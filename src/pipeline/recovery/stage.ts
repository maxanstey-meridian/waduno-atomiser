import { run, stage, type Stage } from "@maxanstey-meridian/tandem";
import { passesIntegrity } from "../../domain/integrity.js";
import type { CandidateOutcome } from "../outcomes.js";
import type { AtomisationState } from "../state.js";
import { createRecoveryBatchPipeline } from "./batch.js";
import { acceptedCandidates } from "./outcome.js";
import type { RecoveryDependencies } from "./recover-candidate.js";

export const createRecoveryStage = (
  dependencies: RecoveryDependencies,
  ledgerPath?: string,
): Stage<AtomisationState> =>
  stage<AtomisationState>({
    id: "recovery",
    execute: async (state, { signal }) => {
      if (state.working.phase !== "assessed") {
        throw new Error("Recovery requires assessed candidates.");
      }
      const candidates = state.working.items;
      if (candidates.length === 0) {
        return { ...state, working: { phase: "accepted", items: [] } };
      }
      const batch = createRecoveryBatchPipeline(dependencies, candidates.length, ledgerPath);
      const nextDiscoveryIndex =
        Math.max(
          -1,
          ...candidates.map((candidate) => candidate.discoveryIndex),
          ...state.outcomes.map((outcome) => outcome.candidate.discoveryIndex),
        ) + 1;
      const result = await run(
        batch,
        {
          source: state.source,
          candidates,
          nextDiscoveryIndex,
          outcomes: [],
        },
        { signal, ledgerPath },
      );
      if (!result.succeeded) {
        throw new Error(result.summary ?? "Recovery failed.");
      }
      return {
        ...state,
        working: { phase: "accepted", items: acceptedCandidates(result.state.outcomes) },
        outcomes: [...state.outcomes, ...result.state.outcomes],
      };
    },
  });

export const createResolutionStage = (): Stage<AtomisationState> =>
  stage<AtomisationState>({
    id: "recovery",
    execute: (state) => {
      if (state.working.phase !== "assessed") {
        throw new Error("Recovery requires assessed candidates.");
      }
      const outcomes = state.working.items.map((candidate): CandidateOutcome =>
        passesIntegrity(candidate.integrity)
          ? { outcome: "accepted", candidate, accepted: candidate, reason: "", repair: null }
          : { outcome: "rejected", candidate, reason: candidate.integrity.reason, repair: null },
      );
      return {
        ...state,
        working: { phase: "accepted", items: acceptedCandidates(outcomes) },
        outcomes: [...state.outcomes, ...outcomes],
      };
    },
  });
