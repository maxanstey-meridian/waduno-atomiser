import { stage, type Stage } from "@maxanstey-meridian/tandem";
import type { DiscoveredCandidate } from "./candidate.js";
import type { AtomisationState } from "./state.js";

export const createDeduplicationStage = (): Stage<AtomisationState> =>
  stage<AtomisationState>({
    id: "dedupe",
    execute: (state) => {
      if (state.working.phase !== "discovered") {
        throw new Error("Deduplication requires discovered candidates.");
      }
      const firstIndexByProposition = new Map<string, number>();
      const items: DiscoveredCandidate[] = [];
      const outcomes = [...state.outcomes];
      for (const candidate of state.working.items) {
        const firstIndex = firstIndexByProposition.get(candidate.proposition);
        if (firstIndex !== undefined) {
          outcomes.push({
            outcome: "duplicate",
            candidate,
            reason: `duplicate of candidate ${firstIndex}`,
          });
        } else {
          firstIndexByProposition.set(candidate.proposition, candidate.discoveryIndex);
          items.push(candidate);
        }
      }
      return { ...state, working: { phase: "discovered", items }, outcomes };
    },
  });
