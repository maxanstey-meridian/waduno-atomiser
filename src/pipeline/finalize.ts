import { stage, type Stage } from "@maxanstey-meridian/tandem";
import {
  ATOMIZATION_VERSION,
  type AtomDraft,
  type CandidateRejection,
} from "../contracts/atomise.js";
import type { SourceEnvelope } from "../contracts/source.js";
import type { TaggedCandidate } from "./candidate.js";
import type { CandidateOutcome } from "./outcomes.js";
import type { AtomisationState } from "./state.js";

const toAtomDraft = (candidate: TaggedCandidate, source: SourceEnvelope): AtomDraft => ({
  proposition: candidate.proposition,
  claim: candidate.claim,
  tags: candidate.tags,
  evidence: {
    sourceId: source.id,
    sourceVersion: source.version,
    title: source.title,
    kind: source.kind,
    passages: source.passages,
  },
  framing: candidate.framing,
  scores: { probabilities: candidate.integrity.probabilities, mean: candidate.integrity.mean },
  ...(candidate.recovery === undefined ? {} : { recovery: candidate.recovery }),
  atomizationVersion: ATOMIZATION_VERSION,
});

export const candidateRejections = (
  outcomes: readonly CandidateOutcome[],
  source: SourceEnvelope,
): CandidateRejection[] =>
  outcomes.flatMap((outcome): CandidateRejection[] => {
    if (outcome.outcome === "split") {
      return candidateRejections(outcome.children, source);
    }
    if (outcome.outcome === "accepted") {
      return [];
    }
    const rejection = {
      candidateIndex: outcome.candidate.discoveryIndex,
      proposition: outcome.candidate.proposition,
      support: source.passages,
      reason: outcome.reason,
    };
    if (outcome.outcome === "duplicate") {
      return [{ ...rejection, stage: "deduplication" }];
    }
    return [
      {
        ...rejection,
        stage: "integrity_validation",
        scores: {
          probabilities: outcome.candidate.integrity.probabilities,
          mean: outcome.candidate.integrity.mean,
        },
      },
    ];
  });

export const createFinalisationStage = (): Stage<AtomisationState> =>
  stage<AtomisationState>({
    id: "finalize",
    execute: (state) => {
      if (state.working.phase !== "tagged") {
        throw new Error("Finalisation requires tagged candidates.");
      }
      const atoms = state.working.items.map((candidate) => toAtomDraft(candidate, state.source));
      return {
        ...state,
        output: {
          atomizationVersion: ATOMIZATION_VERSION,
          status: atoms.length === 0 ? "no_valid_candidates" : "completed",
          atoms,
          candidateRejections: candidateRejections(state.outcomes, state.source),
        },
      };
    },
  });
