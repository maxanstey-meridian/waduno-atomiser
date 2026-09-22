import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ATOMIZATION_VERSION, CandidateRejection } from "../src/contracts/atomise.js";

const assertImports = (
  directory: string,
  allowedDirectories: readonly string[],
  libraries: readonly string[] = [],
) => {
  const root = fileURLToPath(new URL(`../src/${directory}/`, import.meta.url));
  const allowedRoots = allowedDirectories.map((name) =>
    fileURLToPath(new URL(`../src/${name}/`, import.meta.url)),
  );
  for (const name of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (!name.endsWith(".ts")) {
      continue;
    }
    const path = resolve(root, name);
    const file = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const check = (value: string) => {
      assert.ok(
        libraries.includes(value) ||
          (value.startsWith(".") &&
            allowedRoots.some((allowed) =>
              resolve(dirname(path), value).startsWith(
                allowed.endsWith(sep) ? allowed : allowed + sep,
              ),
            )),
        `${directory}/${name} imports forbidden dependency ${value}`,
      );
    };
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        check(node.moduleSpecifier.text);
      }
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      ) {
        check(node.argument.literal.text);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        assert.ok(
          node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]),
          `${directory} cannot compute imports`,
        );
        check(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
};

test("published contracts are closed over contracts and schema libraries", () => {
  assertImports("contracts", ["contracts"], ["zod"]);
});

test("Domain and Application cannot depend on contracts, infrastructure or the runtime", () => {
  assertImports("domain", ["domain"], ["zod"]);
  assertImports("application", ["application", "domain"]);
});

test("HTTP depends on the pipeline and contracts, not bootstrap or model adapters", () => {
  assertImports(
    "interface",
    ["interface", "pipeline", "contracts"],
    ["@maxanstey-meridian/tandem", "fastify"],
  );
});

test("version 10 distinguishes unscored duplicates from scored integrity rejections", () => {
  assert.equal(ATOMIZATION_VERSION, 10);
  const rejection = {
    candidateIndex: 1,
    proposition: "A fact.",
    support: [],
    reason: "duplicate of candidate 0",
  };
  const scores = { probabilities: { supported: 0.2 }, mean: 0.2 };
  assert.equal(
    CandidateRejection.safeParse({ ...rejection, stage: "deduplication" }).success,
    true,
  );
  assert.equal(
    CandidateRejection.safeParse({ ...rejection, stage: "deduplication", scores }).success,
    false,
  );
  assert.equal(
    CandidateRejection.safeParse({ ...rejection, stage: "integrity_validation" }).success,
    false,
  );
  assert.equal(
    CandidateRejection.safeParse({ ...rejection, stage: "integrity_validation", scores }).success,
    true,
  );
});

test("pipeline operations depend on schemas, domain rules and ports, never concrete adapters or reports", () => {
  assertImports(
    "pipeline",
    ["pipeline", "agents", "domain", "application", "contracts"],
    ["zod", "@maxanstey-meridian/tandem"],
  );
});

test("agents depend on their contracts, not adapters or reporting", () => {
  assertImports(
    "agents",
    ["agents", "pipeline", "contracts"],
    ["zod", "@maxanstey-meridian/tandem"],
  );
});
