import { run } from "@maxanstey-meridian/tandem";
import assert from "node:assert/strict";
import test from "node:test";
import { SourceEnvelope } from "../src/contracts/source.js";
import type { IntegrityDecision } from "../src/domain/integrity.js";
import { createAtomiserServer } from "../src/interface/http/server.js";
import { AcceptedCandidate } from "../src/pipeline/candidate.js";
import { createClaimExtractorAtomisationPipeline } from "../src/pipeline/claim-extractor-atomisation-pipeline.js";
import { createItemAtomisationPipeline } from "../src/pipeline/item-atomisation-pipeline.js";
import { initialAtomisationState } from "../src/pipeline/state.js";
import { chatServer } from "./helpers/chat-server.js";

const source = SourceEnvelope.parse({
  id: "trivia:1",
  version: "1",
  title: "The Example (1999)",
  text: "The cat in the opening scene was a stray. Its purring muffled his lines.",
  kind: "trivia",
  context: { sectionPath: ["Trivia"], leadIn: null },
  passages: [{ passageId: "1", blockId: "b1", text: "The cat in the opening scene was a stray." }],
});

const rewritten =
  "The cat in the opening scene of The Example (1999) was a stray. Its purring muffled the lead's lines.";

const decision = (overrides: Partial<IntegrityDecision> = {}): IntegrityDecision => ({
  supported: true,
  meaning_preserved: true,
  standalone: true,
  context_complete: true,
  atomic: true,
  probabilities: {
    supported: 1,
    meaning_preserved: 1,
    standalone: 1,
    context_complete: 1,
    atomic: 1,
  },
  mean: 1,
  reason: "",
  ...overrides,
});

const framed = (claims: readonly string[]) =>
  claims.map(() => ({
    world: { layer: "real_world" as const },
    epistemic: { source_commitment: "asserted" as const, modal_frame: "actual" as const },
    temporal: { instability: "stable" as const },
  }));

test("an item is rewritten once and kept whole when only atomicity fails", async (t) => {
  const rewriter = await chatServer(t, (request) => {
    assert.equal(request.reasoning_effort, "low");
    return `  ${rewritten}\n`;
  });
  const checked: { proposition: string; claim: string }[] = [];
  const tagged: string[] = [];
  const graph = createItemAtomisationPipeline(
    {
      rewriteClient: rewriter.client("rewrite"),
      classifyIntegrity: async (_source, candidates) => {
        checked.push(...candidates.map(({ proposition, claim }) => ({ proposition, claim })));
        return candidates.map(() => decision({ atomic: false, reason: "compound" }));
      },
      classifyFraming: async (_source, claims) => framed(claims),
      tag: async (_title, claims) => {
        tagged.push(...claims);
        return claims.map(() => ["The Example"]);
      },
    },
    { persist: false },
  );
  const result = await run(graph, initialAtomisationState(source));
  assert.equal(result.succeeded, true, result.summary ?? "failed");
  assert.equal(rewriter.requests.length, 1);
  assert.deepEqual(JSON.parse(rewriter.requests[0]!.messages.at(-1)!.content), {
    title: source.title,
    section: ["Trivia"],
    item: source.text,
  });
  assert.deepEqual(checked, [{ proposition: source.text, claim: rewritten }]);
  assert.deepEqual(tagged, [rewritten]);
  assert.equal(result.state.output?.status, "completed");
  assert.deepEqual(
    result.state.output?.atoms.map(({ proposition, claim, tags }) => ({
      proposition,
      claim,
      tags,
    })),
    [{ proposition: source.text, claim: rewritten, tags: ["The Example"] }],
  );
  assert.deepEqual(result.state.output?.candidateRejections, []);
});

test("an item failing any check other than atomicity is rejected with its scores", async (t) => {
  const rewriter = await chatServer(t, () => rewritten);
  const graph = createItemAtomisationPipeline(
    {
      rewriteClient: rewriter.client("rewrite"),
      classifyIntegrity: async (_source, candidates) =>
        candidates.map(() =>
          decision({
            supported: false,
            probabilities: {
              supported: 0.3,
              meaning_preserved: 1,
              standalone: 1,
              context_complete: 1,
              atomic: 1,
            },
            mean: 0.86,
            reason: "unsupported: supported P=0.30",
          }),
        ),
      classifyFraming: async (_source, claims) => {
        assert.deepEqual(claims, []);
        return [];
      },
      tag: async () => assert.fail("Unexpected tagger call"),
    },
    { persist: false },
  );
  const result = await run(graph, initialAtomisationState(source));
  assert.equal(result.succeeded, true, result.summary ?? "failed");
  assert.equal(result.state.output?.status, "no_valid_candidates");
  assert.deepEqual(
    result.state.output?.candidateRejections.map(({ stage, proposition, reason }) => ({
      stage,
      proposition,
      reason,
    })),
    [
      {
        stage: "integrity_validation",
        proposition: source.text,
        reason: "unsupported: supported P=0.30",
      },
    ],
  );
});

test("a blank rewrite fails the run instead of producing an empty item", async (t) => {
  const rewriter = await chatServer(t, () => "   ");
  const graph = createItemAtomisationPipeline(
    {
      rewriteClient: rewriter.client("rewrite"),
      classifyIntegrity: async () => assert.fail("Unexpected Jev call"),
      classifyFraming: async () => assert.fail("Unexpected framing call"),
      tag: async () => assert.fail("Unexpected tagger call"),
    },
    { persist: false },
  );
  await assert.rejects(run(graph, initialAtomisationState(source)), /remained invalid/u);
});

test("only rewritten items are accepted without atomicity", () => {
  const candidate = {
    discoveryIndex: 0,
    proposition: "A and B.",
    claim: "A and B.",
    integrity: decision({ atomic: false }),
  };
  assert.equal(AcceptedCandidate.safeParse({ ...candidate, unit: "item" }).success, true);
  assert.equal(AcceptedCandidate.safeParse({ ...candidate, unit: "claim" }).success, false);
  assert.equal(
    AcceptedCandidate.safeParse({
      ...candidate,
      unit: "item",
      integrity: decision({ standalone: false }),
    }).success,
    false,
  );
});

test("HTTP serves items through the item pipeline, not ClaimExtractor", async (t) => {
  const passage = createClaimExtractorAtomisationPipeline(
    {
      extractClaims: async () => assert.fail("Items must not reach ClaimExtractor"),
      splitClient: (await chatServer(t, () => assert.fail("Unexpected split"))).client("split"),
      classifyIntegrity: async () => assert.fail("Unexpected Jev call"),
      classifyFraming: async () => assert.fail("Unexpected framing call"),
      tag: async () => assert.fail("Unexpected tagger call"),
    },
    { persist: false },
  );
  const item = createItemAtomisationPipeline(
    {
      rewriteClient: (await chatServer(t, () => rewritten)).client("rewrite"),
      classifyIntegrity: async (_source, candidates) => candidates.map(() => decision()),
      classifyFraming: async (_source, claims) => framed(claims),
      tag: async (_title, claims) => claims.map(() => []),
    },
    { persist: false },
  );
  const { app } = createAtomiserServer(
    { passage, item },
    { concurrency: 1, timeoutMs: 5000, queueLimit: 8 },
  );
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/atomise-item", payload: source });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().atoms[0].claim, rewritten);
  assert.equal(
    (await app.inject({ method: "POST", url: "/atomise-item", payload: { id: "x" } })).statusCode,
    400,
  );
});
