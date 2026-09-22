import assert from "node:assert/strict";
import test from "node:test";
import { SourceEnvelope } from "../../src/contracts/source.js";
import { createJevClassifiers } from "../../src/infrastructure/jev.js";
import { framingCanaries, integrityCanaries } from "../fixtures/jev-canaries.js";

const canarySource = (text: string) =>
  SourceEnvelope.parse({
    id: "canary:source",
    version: "1",
    title: "",
    text,
    kind: "paragraph",
    context: { sectionPath: [], leadIn: null },
    passages: [
      {
        passageId: "passage:1",
        blockId: "block:1",
        startOffset: 0,
        endOffset: [...text].length,
        text,
      },
    ],
  });

const canaryCandidate = (fixture: (typeof integrityCanaries)[number]) => ({
  proposition: fixture.proposition,
  claim: fixture.claim,
  ...(fixture.parentProposition === undefined
    ? {}
    : { parentProposition: fixture.parentProposition }),
});

test("live Jev recognises the labelled semantic canaries", { timeout: 300_000 }, async () => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  assert.ok(
    apiKey && apiKey.trim(),
    "Set OPENROUTER_API_KEY in the environment or .env for pnpm test:jev",
  );
  const { classifyIntegrity, classifyFraming } = createJevClassifiers(apiKey);
  const signal = AbortSignal.timeout(290_000);
  const failures: string[] = [];
  const rows: { case: string; check: string; expected: string; actual: string; result: string }[] =
    [];

  for (const fixture of integrityCanaries) {
    const source = SourceEnvelope.parse({
      id: `canary:${fixture.name}`,
      version: "1",
      title: "",
      text: fixture.source,
      kind: "paragraph",
      context: { sectionPath: [], leadIn: null },
      passages: [
        {
          passageId: "passage:1",
          blockId: "block:1",
          startOffset: 0,
          endOffset: [...fixture.source].length,
          text: fixture.source,
        },
      ],
    });
    const [decision] = await classifyIntegrity(
      source,
      [
        {
          proposition: fixture.proposition,
          claim: fixture.claim,
          ...(fixture.parentProposition === undefined
            ? {}
            : { parentProposition: fixture.parentProposition }),
        },
      ],
      signal,
    );
    for (const key of Object.keys(fixture.expected) as (keyof typeof fixture.expected)[]) {
      const probability = decision?.probabilities[key];
      const passed =
        typeof probability === "number" &&
        Number.isFinite(probability) &&
        probability >= 0 &&
        probability <= 1 &&
        decision?.[key] === fixture.expected[key];
      rows.push({
        case: fixture.name,
        check: key,
        expected: String(fixture.expected[key]),
        actual: `${decision?.[key]} (P=${probability ?? "missing"})`,
        result: passed ? "PASS" : "FAIL",
      });
      if (!passed) {
        failures.push(`${fixture.name}: ${key}. ${fixture.why}`);
      }
    }
  }

  for (const fixture of framingCanaries) {
    const result = await classifyFraming(
      {
        claim: fixture.claim,
        sourceTitle: fixture.sourceTitle,
        sourceText: fixture.sourceText,
        sourceContext: { sectionPath: [], leadIn: null },
      },
      signal,
    );
    for (const group of ["world", "epistemic", "temporal"] as const) {
      const actual: Record<string, unknown> = result[group];
      for (const [key, expected] of Object.entries(fixture.expected[group] ?? {})) {
        const passed = actual[key] === expected;
        rows.push({
          case: fixture.name,
          check: `${group}.${key}`,
          expected: String(expected),
          actual: String(actual[key]),
          result: passed ? "PASS" : "FAIL",
        });
        if (!passed) {
          failures.push(`${fixture.name}: ${group}.${key}. ${fixture.why}`);
        }
      }
    }
  }

  console.table(rows);
  assert.deepEqual(failures, [], "Live Jev canary failures");
});

test(
  "live Jev batch and singleton decisions match the labelled canaries",
  { timeout: 300_000 },
  async () => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    assert.ok(apiKey && apiKey.trim(), "Set OPENROUTER_API_KEY for pnpm test:jev");
    const { classifyIntegrity } = createJevClassifiers(apiKey);
    const signal = AbortSignal.timeout(290_000);
    const groups = new Map<string, (typeof integrityCanaries)[number][]>();
    for (const fixture of integrityCanaries) {
      const group = groups.get(fixture.source) ?? [];
      group.push(fixture);
      groups.set(fixture.source, group);
    }
    const failures: string[] = [];
    const rows: {
      case: string;
      check: string;
      expected: boolean;
      single: number | undefined;
      batch: number | undefined;
      delta: string;
      result: string;
    }[] = [];
    let compared = 0;
    for (const [text, fixtures] of groups) {
      if (fixtures.length < 2) {
        continue;
      }
      const source = canarySource(text);
      const batch = await classifyIntegrity(source, fixtures.map(canaryCandidate), signal);
      assert.equal(batch.length, fixtures.length);
      for (const [index, fixture] of fixtures.entries()) {
        const single = await classifyIntegrity(source, [canaryCandidate(fixture)], signal);
        assert.equal(single.length, 1);
        compared += 1;
        for (const key of Object.keys(fixture.expected) as (keyof typeof fixture.expected)[]) {
          const singleProbability = single[0]?.probabilities[key];
          const batchProbability = batch[index]?.probabilities[key];
          const validScores = [singleProbability, batchProbability].every(
            (value) =>
              typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1,
          );
          const passed =
            validScores &&
            single[0]?.[key] === fixture.expected[key] &&
            batch[index]?.[key] === fixture.expected[key];
          rows.push({
            case: fixture.name,
            check: key,
            expected: fixture.expected[key],
            single: singleProbability,
            batch: batchProbability,
            delta:
              singleProbability === undefined || batchProbability === undefined
                ? "missing"
                : (batchProbability - singleProbability).toFixed(2),
            result: passed ? "PASS" : "FAIL",
          });
          if (!passed) {
            failures.push(
              `${fixture.name}: ${key}; single=${single[0]?.[key]}, batch=${batch[index]?.[key]}, expected=${fixture.expected[key]}. ${fixture.why}`,
            );
          }
        }
      }
    }
    console.table(rows);
    assert.ok(compared > 0, "Fixtures must include multiple candidates sharing a source");
    assert.deepEqual(failures, [], "Live Jev batch/singleton canary failures");
  },
);
