import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createClaimExtractor,
  type ClaimExtractorEndpoint,
} from "../src/infrastructure/claim-extractor.js";

const source = {
  text: "She wrote the novel.",
  title: "Mary Shelley",
  context: { sectionPath: ["Frankenstein"], leadIn: "Shelley began writing in 1816." },
};
const endpoint = {
  baseUrl: "http://127.0.0.1:8092/v1",
  model: "claim-extractor",
  apiKeyVariable: "CLAIM_EXTRACTOR_API_KEY",
  reasoningEffort: null,
  timeoutMilliseconds: 5000,
} satisfies ClaimExtractorEndpoint;

const extractor = async (
  t: TestContext,
  worker: string,
  overrides: Partial<ClaimExtractorEndpoint> = {},
) => {
  const directory = await mkdtemp(join(tmpdir(), "claim-extractor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, "worker.mjs");
  await writeFile(script, worker);
  return createClaimExtractor(process.execPath, script, { ...endpoint, ...overrides });
};

const replyWith = (value: string) => `
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    process.stdout.write(JSON.stringify({ claims: [{ content: JSON.stringify(${value}) }] }));
  });
`;

test("an extractor that exits before reading a large source rejects without crashing the host", async (t) => {
  const extract = await extractor(t, "process.exit(1)");
  await assert.rejects(
    extract({ ...source, text: "x".repeat(900_000) }, AbortSignal.timeout(5000)),
    /EPIPE|ECONNRESET|ClaimExtractor failed/u,
  );
});

test("the extractor passes unchanged text and bounded context to its worker", async (t) => {
  const extract = await extractor(t, replyWith("JSON.parse(input)"));
  const claims = await extract(source, AbortSignal.timeout(5000));
  assert.deepEqual(JSON.parse(claims[0]!), source);
});

test("the extractor passes the endpoint and reasoning effort to its worker", async (t) => {
  const argv = async (overrides: Partial<ClaimExtractorEndpoint>) => {
    const extract = await extractor(t, replyWith("process.argv.slice(2)"), overrides);
    return JSON.parse((await extract(source, AbortSignal.timeout(5000)))[0]!);
  };
  assert.deepEqual(await argv({}), [
    "http://127.0.0.1:8092/v1",
    "claim-extractor",
    "CLAIM_EXTRACTOR_API_KEY",
    "5",
    "",
  ]);
  assert.equal((await argv({ reasoningEffort: "minimal" })).at(-1), "minimal");
});
