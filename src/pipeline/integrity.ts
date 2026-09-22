import { stage, type Stage } from "@maxanstey-meridian/tandem";
import type { IntegrityClassifier } from "../application/ports/integrity-classifier.js";
import { IntegrityDecision } from "../domain/integrity.js";
import type { AtomisationState } from "./state.js";

export const createIntegrityStage = (
  classifyIntegrity: IntegrityClassifier,
): Stage<AtomisationState> =>
  stage<AtomisationState>({
    id: "integrity",
    execute: async (state, { signal }) => {
      if (state.working.phase !== "canonicalised") {
        throw new Error("Integrity requires canonicalised candidates.");
      }
      const candidates = state.working.items;
      const decisions = await classifyIntegrity(state.source, candidates, signal);
      if (decisions.length !== candidates.length) {
        throw new Error("Integrity classification produced an incorrect number of decisions.");
      }
      const items = candidates.map((candidate, index) => ({
        ...candidate,
        integrity: IntegrityDecision.parse(decisions[index]),
      }));
      return { ...state, working: { phase: "assessed", items } };
    },
  });
