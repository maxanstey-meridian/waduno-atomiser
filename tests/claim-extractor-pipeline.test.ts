import { run } from "@maxanstey-meridian/tandem";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SourceEnvelope } from "../src/contracts/source.js";
import type { IntegrityDecision } from "../src/domain/integrity.js";
import { createClaimExtractorAtomisationPipeline } from "../src/pipeline/claim-extractor-atomisation-pipeline.js";
import { initialAtomisationState } from "../src/pipeline/state.js";
import { chatServer } from "./helpers/chat-server.js";

const source = SourceEnvelope.parse(
  JSON.parse(
    readFileSync(
      new URL("./fixtures/source-envelope-quick-brown-fox.json", import.meta.url),
      "utf8",
    ),
  ),
);

const accepted: IntegrityDecision = {
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
};

test("ClaimExtractor claims split through APS and reach Jev and GLiNER without Luna", async (t) => {
  const aps = await chatServer(t, (request) => {
    const claim = request.messages.at(-1)?.content;
    if (claim === "The fox jumps and the dog sleeps.") {
      return "PROPOSITIONS:\n- The fox jumps.\n- The dog sleeps.";
    }
    return `PROPOSITIONS:\n- ${claim}`;
  });
  const checked: string[] = [];
  const tagged: string[] = [];
  const graph = createClaimExtractorAtomisationPipeline(
    {
      extractClaims: async () => [
        "The fox jumps and the dog sleeps.",
        "The fox jumps and the dog sleeps.",
      ],
      apsClient: aps.client("aps"),
      classifyIntegrity: async (_source, candidates) => {
        checked.push(...candidates.map((candidate) => candidate.claim));
        return candidates.map((candidate) =>
          candidate.claim === "The fox jumps and the dog sleeps."
            ? {
                ...accepted,
                atomic: false,
                probabilities: { ...accepted.probabilities, atomic: 0.1 },
                mean: 0.82,
                reason: "compound",
              }
            : candidate.claim === "The dog sleeps."
              ? {
                  ...accepted,
                  supported: false,
                  probabilities: { ...accepted.probabilities, supported: 0.1 },
                  mean: 0.82,
                  reason: "unsupported",
                }
              : accepted,
        );
      },
      classifyFraming: async (_source, claims) =>
        claims.map(() => ({
          world: { layer: "real_world" },
          epistemic: { source_commitment: "asserted", modal_frame: "actual" },
          temporal: { instability: "stable" },
        })),
      tag: async (_title, claims) => {
        tagged.push(...claims);
        return claims.map(() => []);
      },
    },
    { integrityGate: true },
  );
  const result = await run(graph, initialAtomisationState(source));
  assert.equal(result.succeeded, true, result.summary ?? "failed");
  assert.deepEqual(checked, [
    "The fox jumps and the dog sleeps.",
    "The fox jumps.",
    "The dog sleeps.",
  ]);
  assert.deepEqual(tagged, ["The fox jumps."]);
  assert.deepEqual(
    result.state.output?.atoms.map((atom) => atom.claim),
    ["The fox jumps."],
  );
  assert.equal(result.state.output?.atoms[0]?.recovery, "split");
  assert.deepEqual(
    result.state.output?.candidateRejections.map((rejection) => rejection.stage),
    ["deduplication", "integrity_validation"],
  );
  assert.equal(aps.requests.length, 1);
});

test("an empty ClaimExtractor result completes without splitting or classifying", async () => {
  const graph = createClaimExtractorAtomisationPipeline({
    extractClaims: async () => [],
    apsClient: {
      kind: "openai-compatible",
      version: 1,
      endpoint: "http://127.0.0.1:1/v1",
      model: "unused",
      wireApi: "completions",
      verifyModel: false,
    },
    classifyIntegrity: async () => assert.fail("Unexpected Jev call"),
    classifyFraming: async () => assert.fail("Unexpected framing call"),
    tag: async () => assert.fail("Unexpected GLiNER call"),
  });
  const result = await run(graph, initialAtomisationState(source));
  assert.equal(result.succeeded, true, result.summary ?? "failed");
  assert.equal(result.state.output?.status, "no_propositions");
});

test("ClaimExtractor defaults to retaining a rejected claim without splitting", async () => {
  const graph = createClaimExtractorAtomisationPipeline({
    extractClaims: async () => ["The fox jumps and the dog sleeps."],
    apsClient: {
      kind: "openai-compatible",
      version: 1,
      endpoint: "http://127.0.0.1:1/v1",
      model: "unused",
      wireApi: "completions",
      verifyModel: false,
    },
    classifyIntegrity: async () => [{ ...accepted, atomic: false, reason: "compound" }],
    classifyFraming: async () => [
      {
        world: { layer: "real_world" },
        epistemic: { source_commitment: "asserted", modal_frame: "actual" },
        temporal: { instability: "stable" },
      },
    ],
    tag: async () => [[]],
  });
  const result = await run(graph, initialAtomisationState(source));
  assert.equal(result.succeeded, true, result.summary ?? "failed");
  assert.deepEqual(
    result.state.output?.atoms.map((atom) => atom.claim),
    ["The fox jumps and the dog sleeps."],
  );
  assert.deepEqual(result.state.output?.candidateRejections, []);
});
