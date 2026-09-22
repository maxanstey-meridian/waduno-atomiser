import assert from "node:assert/strict";
import test from "node:test";
import { parseApsPropositions } from "../src/agents/parse-propositions.js";
import { assembleFraming } from "../src/domain/framing.js";
import {
  acceptsIntegrityProbability,
  canRepair,
  canSplit,
  foldIntegrityChecks,
  passesIntegrity,
} from "../src/domain/integrity.js";

test("parseApsPropositions collects bullets and skips the streamed </s> echo", () => {
  const response =
    "PROPOSITIONS:\n<s>\n- Platoon won four Oscars.\n</s>\n- Oliver Stone directed it.\n</s>\n\n- </s>";
  const parsed = parseApsPropositions(response);
  assert.deepEqual(
    parsed.items.map((item) => item.proposition),
    ["Platoon won four Oscars.", "Oliver Stone directed it."],
  );
});

test("parseApsPropositions tolerates a plain bullet reply without <s> noise", () => {
  const parsed = parseApsPropositions("PROPOSITIONS:\n\n- Only one.");
  assert.deepEqual(
    parsed.items.map((item) => item.proposition),
    ["Only one."],
  );
});

test("APS distinguishes an empty proposition list from malformed output and has no count cap", () => {
  assert.deepEqual(parseApsPropositions("PROPOSITIONS:\n"), { items: [] });
  for (const response of ["", "Sorry, unavailable.", "PROPOSITIONS:\n-", "- Fact.\ntruncated"]) {
    assert.throws(() => parseApsPropositions(response), /APS/u);
  }
  assert.equal(
    parseApsPropositions(Array.from({ length: 205 }, (_, i) => `- Fact ${i}.`).join("\n")).items
      .length,
    205,
  );
});

test("foldIntegrityChecks derives complete decisions and rejects missing checks", () => {
  const checks = [
    { index: 0, key: "supported", accepted: true, probability: 0.9, reason: "" },
    {
      index: 0,
      key: "standalone",
      accepted: false,
      probability: 0.1,
      reason: "unresolved: standalone P=0.10",
    },
    { index: 0, key: "atomic", accepted: true, probability: 0.8, reason: "" },
    { index: 0, key: "meaning_preserved", accepted: true, probability: 0.7, reason: "" },
  ] as const;
  const complete = [
    ...checks,
    { index: 0, key: "context_complete", probability: 1, reason: "" } as const,
  ];
  const decision = foldIntegrityChecks(complete, 1)[0]!;
  assert.equal(decision.supported, true);
  assert.equal(decision.standalone, false);
  assert.equal(decision.reason, "unresolved: standalone P=0.10");
  assert.deepEqual(decision.probabilities, {
    supported: 0.9,
    standalone: 0.1,
    atomic: 0.8,
    meaning_preserved: 0.7,
    context_complete: 1,
  });
  assert.equal(decision.mean, 0.7);
  assert.throws(() => foldIntegrityChecks(checks, 1), /every check/u);
  assert.throws(() => foldIntegrityChecks([], 1), /every check/u);
  assert.throws(() => foldIntegrityChecks([...complete, complete[0]!], 1), /every check/u);
  assert.throws(() =>
    foldIntegrityChecks([{ ...complete[0]!, probability: NaN }, ...complete.slice(1)], 1),
  );
});

test("framing preserves labels and enforces fictional-world stability", () => {
  const framing = assembleFraming(
    { layer: "fictional_world" },
    { source_commitment: "asserted", modal_frame: "actual" },
    { instability: "stable" },
  );
  assert.equal(framing.world.layer, "fictional_world");

  assert.throws(() =>
    assembleFraming(
      { layer: "fictional_world" },
      { source_commitment: "asserted", modal_frame: "actual" },
      { instability: "mutable" },
    ),
  );
});

test("integrity gates every check at 0.6 and limits recovery to eligible failures", () => {
  assert.equal(acceptsIntegrityProbability(0.599999), false);
  assert.equal(acceptsIntegrityProbability(0.6), true);
  assert.equal(acceptsIntegrityProbability(1), true);
  const accepted = {
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
  assert.equal(passesIntegrity(accepted), true);
  assert.equal(canRepair(accepted), false);
  assert.equal(canSplit(accepted), false);
  for (const key of [
    "supported",
    "meaning_preserved",
    "standalone",
    "context_complete",
    "atomic",
  ] as const) {
    const failed = { ...accepted, [key]: false };
    assert.equal(passesIntegrity(failed), false, key);
    assert.equal(canRepair(failed), key === "standalone" || key === "context_complete", key);
    assert.equal(canSplit(failed), key === "atomic", key);
  }
  for (const key of ["supported", "meaning_preserved"] as const) {
    const failed = {
      ...accepted,
      [key]: false,
      standalone: false,
      context_complete: false,
      atomic: false,
    };
    assert.equal(canRepair(failed), false);
    assert.equal(canSplit(failed), false);
  }
  const unresolvedCompound = { ...accepted, standalone: false, atomic: false };
  assert.equal(canRepair(unresolvedCompound), true);
  assert.equal(canSplit(unresolvedCompound), false);
});
