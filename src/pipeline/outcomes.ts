import { z } from "zod";
import { AcceptedCandidate, AssessedCandidate, DiscoveredCandidate } from "./candidate.js";

const AssessedOutcome = z.strictObject({
  candidate: AssessedCandidate,
  reason: z.string(),
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
