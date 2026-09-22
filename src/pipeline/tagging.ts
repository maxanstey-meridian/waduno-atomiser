import { stage, type Stage } from "@maxanstey-meridian/tandem";
import type { AtomTagger } from "../application/ports/atom-tagger.js";
import type { AtomisationState } from "./state.js";

export const createTaggingStage = (tag: AtomTagger): Stage<AtomisationState> =>
  stage<AtomisationState>({
    id: "tagging",
    execute: async (state, { signal }) => {
      if (state.working.phase !== "framed") {
        throw new Error("Tagging requires framed candidates.");
      }
      const candidates = state.working.items;
      const tags =
        candidates.length === 0
          ? []
          : await tag(
              state.source.title,
              candidates.map((candidate) => candidate.claim),
              signal,
            );
      if (tags.length !== candidates.length) {
        throw new Error("Tagger returned an incorrect number of results");
      }
      return {
        ...state,
        working: {
          phase: "tagged",
          items: candidates.map((candidate, index) => ({ ...candidate, tags: tags[index]! })),
        },
      };
    },
  });
