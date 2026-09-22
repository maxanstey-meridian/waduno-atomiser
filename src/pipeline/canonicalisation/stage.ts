import { run, stage, type Pipeline, type Stage } from "@maxanstey-meridian/tandem";
import type { AtomisationState } from "../state.js";
import { createCanonicalisationBatchPipeline } from "./batch.js";
import type { CanonicalisationState } from "./claim.js";

export const createCanonicalisationStage = (
  claimPipeline: Pipeline<CanonicalisationState>,
  ledgerPath?: string,
): Stage<AtomisationState> =>
  stage<AtomisationState>({
    id: "canonicalize",
    execute: async (state, { signal }) => {
      if (state.working.phase !== "discovered") {
        throw new Error("Canonicalisation requires discovered candidates.");
      }
      if (state.working.items.length === 0) {
        return { ...state, working: { phase: "canonicalised", items: [] } };
      }
      const batch = createCanonicalisationBatchPipeline(
        claimPipeline,
        state.working.items.length,
        ledgerPath,
      );
      const result = await run(
        batch,
        {
          source: state.source,
          candidates: state.working.items,
          canonicalised: [],
        },
        { signal, ledgerPath },
      );
      if (!result.succeeded) {
        throw new Error(result.summary ?? "Canonicalisation failed.");
      }
      return { ...state, working: { phase: "canonicalised", items: result.state.canonicalised } };
    },
  });
