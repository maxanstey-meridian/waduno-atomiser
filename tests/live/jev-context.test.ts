import assert from "node:assert/strict";
import test from "node:test";
import { SourceEnvelope } from "../../src/contracts/source.js";
import { passesIntegrity } from "../../src/domain/integrity.js";
import { createJevClassifiers } from "../../src/infrastructure/jev.js";
import { contextCanaries } from "../fixtures/jev-context-canaries.js";

test(
  "Jev context completeness separates missing scope from incidental detail",
  { timeout: 180_000 },
  async () => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    assert.ok(apiKey && apiKey.trim(), "Set OPENROUTER_API_KEY for the live context test");
    const { classifyIntegrity } = createJevClassifiers(apiKey);
    const rows = [];
    const failures: string[] = [];
    const signal = AbortSignal.timeout(170_000);
    for (const fixture of contextCanaries) {
      const source = SourceEnvelope.parse({
        id: "context-canary",
        version: "1",
        title: fixture.source.title,
        text: fixture.source.text,
        kind: "paragraph",
        context: { sectionPath: [], leadIn: null },
        passages: [
          {
            passageId: "p1",
            blockId: "b1",
            startOffset: 0,
            endOffset: [...fixture.source.text].length,
            text: fixture.source.text,
          },
        ],
      });
      const [decision] = await classifyIntegrity(
        source,
        [{ proposition: fixture.claim, claim: fixture.claim }],
        signal,
      );
      const probability = decision?.probabilities.context_complete;
      const valid =
        typeof probability === "number" &&
        Number.isFinite(probability) &&
        probability >= 0 &&
        probability <= 1;
      const accepted = decision?.context_complete;
      const passed = valid && accepted === fixture.expected;
      rows.push({
        case: fixture.name,
        expected: fixture.expected,
        probability,
        accepted,
        result: passed ? "PASS" : "FAIL",
      });
      if (!passed) {
        failures.push(`${fixture.name}: P=${probability}, expected=${fixture.expected}`);
      }
    }
    console.table(rows);
    assert.deepEqual(failures, [], "Context-completeness failures");
  },
);

test(
  "source lead-in resolves a reference without adding a separate lead-in fact",
  { timeout: 30000 },
  async () => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    assert.ok(apiKey && apiKey.trim(), "Set OPENROUTER_API_KEY for the live context test");
    const text = "She opened the gate.";
    const source = SourceEnvelope.parse({
      id: "lead-in",
      version: "1",
      title: "North Depot",
      text,
      kind: "paragraph",
      context: { sectionPath: [], leadIn: "Mira approached the gate of North Depot." },
      passages: [{ passageId: "p", blockId: "b", startOffset: 0, endOffset: text.length, text }],
    });
    const [decision] = await createJevClassifiers(apiKey).classifyIntegrity(
      source,
      [{ proposition: text, claim: "Mira opened the gate of North Depot." }],
      AbortSignal.timeout(25000),
    );
    console.log("Lead-in reference resolution", decision);
    assert.equal(passesIntegrity(decision!), true);
    const [differentFact] = await createJevClassifiers(apiKey).classifyIntegrity(
      source,
      [{ proposition: text, claim: "Mira approached the gate of North Depot." }],
      AbortSignal.timeout(25000),
    );
    assert.equal(differentFact?.supported, false);
    assert.equal(differentFact?.meaning_preserved, false);
  },
);
