import type { AcceptedCandidate } from "../candidate.js";
import type { CandidateOutcome } from "../outcomes.js";

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
