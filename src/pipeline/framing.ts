import { stage, type Stage } from "@maxanstey-meridian/tandem";
import type { FramingClassifier } from "../application/ports/framing-classifier.js";
import { assembleFraming } from "../domain/framing.js";
import type { FramedCandidate } from "./candidate.js";
import type { AtomisationState } from "./state.js";

export const createFramingStage = (classifyFraming: FramingClassifier): Stage<AtomisationState> =>
  stage<AtomisationState>({
    id: "framing",
    execute: async (state, { signal }) => {
      if (state.working.phase !== "accepted") {
        throw new Error("Framing requires accepted candidates.");
      }
      const items: FramedCandidate[] = [];
      for (const candidate of state.working.items) {
        const result = await classifyFraming(
          {
            claim: candidate.claim,
            sourceTitle: state.source.title,
            sourceText: state.source.text,
            sourceContext: state.source.context,
          },
          signal,
        );
        items.push({
          ...candidate,
          framing: assembleFraming(result.world, result.epistemic, result.temporal),
        });
      }
      return { ...state, working: { phase: "framed", items } };
    },
  });
