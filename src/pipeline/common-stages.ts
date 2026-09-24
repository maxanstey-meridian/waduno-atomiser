import { output, stage } from "@maxanstey-meridian/tandem";
import type { AtomTagger } from "../application/ports/atom-tagger.js";
import type { FramingClassifier } from "../application/ports/framing-classifier.js";
import type { IntegrityClassifier } from "../application/ports/integrity-classifier.js";
import { assembleFraming } from "../domain/framing.js";
import { IntegrityDecision } from "../domain/integrity.js";
import type { FramedCandidate } from "./candidate.js";
import { finalise } from "./finalize.js";
import type { AtomisationState } from "./state.js";

export const createCommonStages = (
  classifyIntegrity: IntegrityClassifier,
  classifyFraming: FramingClassifier,
  tag: AtomTagger,
) => {
  const integrity = stage<AtomisationState>({
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

  const framing = stage<AtomisationState>({
    id: "framing",
    execute: async (state, { signal }) => {
      if (state.working.phase !== "accepted") {
        throw new Error("Framing requires accepted candidates.");
      }
      const candidates = state.working.items;
      const results = await classifyFraming(
        state.source,
        candidates.map((candidate) => candidate.claim),
        signal,
      );
      if (results.length !== candidates.length) {
        throw new Error("Framing classification produced an incorrect number of results.");
      }
      const items: FramedCandidate[] = candidates.map((candidate, index) => {
        const result = results[index]!;
        return {
          ...candidate,
          framing: assembleFraming(result.world, result.epistemic, result.temporal),
        };
      });
      return { ...state, working: { phase: "framed", items } };
    },
  });

  const tagging = stage<AtomisationState>({
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
          items: candidates.map((candidate, index) => ({
            ...candidate,
            tags: tags[index]!,
          })),
        },
      };
    },
  });

  const finalize = stage<AtomisationState>({ id: "finalize", execute: finalise });
  const done = output<AtomisationState>({
    id: "done",
    summary: (state) => {
      if (state.output === null) {
        throw new Error("Completed atomisation has no output.");
      }
      if (state.output.status === "no_propositions") {
        return "No propositions were discovered.";
      }
      if (state.output.status === "no_valid_candidates") {
        return "No valid atom candidates remained.";
      }
      return `${state.output.atoms.length} atoms accepted.`;
    },
  });
  const failed = output<AtomisationState>({
    id: "failed",
    failed: true,
    summary: () => "Atomization failed.",
  });
  return { integrity, framing, tagging, finalize, done, failed };
};
