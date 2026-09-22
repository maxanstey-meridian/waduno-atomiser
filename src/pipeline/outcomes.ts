import { z } from "zod";
import { IntegrityDecision } from "../domain/integrity.js";
import {
  AcceptedCandidate,
  AssessedCandidate,
  CanonicalCandidate,
  DiscoveredCandidate,
} from "./candidate.js";

export const RepairAttempt = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("unchanged"), claim: CanonicalCandidate.shape.claim }),
  z.strictObject({
    outcome: z.literal("accepted"),
    claim: CanonicalCandidate.shape.claim,
    integrity: IntegrityDecision,
  }),
  z.strictObject({
    outcome: z.literal("rejected"),
    claim: CanonicalCandidate.shape.claim,
    integrity: IntegrityDecision,
  }),
]);
export type RepairAttempt = z.infer<typeof RepairAttempt>;

const AssessedOutcome = z.strictObject({
  candidate: AssessedCandidate,
  reason: z.string(),
  repair: RepairAttempt.nullable(),
});
export const CandidateResolution = z.discriminatedUnion("outcome", [
  AssessedOutcome.extend({ outcome: z.literal("accepted"), accepted: AcceptedCandidate }),
  AssessedOutcome.extend({ outcome: z.literal("rejected") }),
]);
export type CandidateResolution = z.infer<typeof CandidateResolution>;

export const CandidateOutcome = z.discriminatedUnion("outcome", [
  ...CandidateResolution.options,
  z.strictObject({
    outcome: z.literal("split"),
    candidate: AssessedCandidate,
    reason: z.string(),
    children: z.array(CandidateResolution),
  }),
  z.strictObject({
    outcome: z.literal("duplicate"),
    candidate: DiscoveredCandidate,
    reason: z.string(),
  }),
]);
export type CandidateOutcome = z.infer<typeof CandidateOutcome>;

export const acceptedCandidates = (outcomes: readonly CandidateOutcome[]): AcceptedCandidate[] =>
  outcomes.flatMap((outcome) => {
    if (outcome.outcome === "accepted") {
      return [outcome.accepted];
    }
    if (outcome.outcome === "split") {
      return acceptedCandidates(outcome.children);
    }
    return [];
  });
