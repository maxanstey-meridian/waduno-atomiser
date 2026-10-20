import {
  collection,
  pipeline,
  route,
  stage,
  type ChatClient,
  type Pipeline,
} from "@maxanstey-meridian/tandem";
import { createRewriteAgent } from "../agents/rewrite.js";
import type { AtomTagger } from "../application/ports/atom-tagger.js";
import type { FramingClassifier } from "../application/ports/framing-classifier.js";
import type { IntegrityClassifier } from "../application/ports/integrity-classifier.js";
import { SourceEnvelope } from "../contracts/source.js";
import { CanonicalCandidate, passesCandidateIntegrity } from "./candidate.js";
import { CandidateOutcome, acceptedCandidates } from "./outcomes.js";
import { doneOutput, finalizeStage, framingStage, integrityStage, taggingStage } from "./stages.js";
import { AtomisationState } from "./state.js";

export type ItemPipelineDependencies = {
  readonly rewriteClient: ChatClient;
  readonly classifyIntegrity: IntegrityClassifier;
  readonly classifyFraming: FramingClassifier;
  readonly tag: AtomTagger;
};

export type ItemPipelineOptions = {
  readonly persist: boolean;
};

export const createItemAtomisationPipeline = (
  { rewriteClient, classifyIntegrity, classifyFraming, tag }: ItemPipelineDependencies,
  options: ItemPipelineOptions,
): Pipeline<AtomisationState> => {
  const rewriteAgent = createRewriteAgent(rewriteClient);
  const rewrite = collection({
    id: "rewrite-item",
    item: SourceEnvelope,
    result: CanonicalCandidate,
    agents: [rewriteAgent],
    max: 1,
    items: (state: AtomisationState) => [state.source],
    execute: async (source, context): Promise<CanonicalCandidate> => {
      const { claim } = await context.run(rewriteAgent, {
        title: source.title,
        sectionPath: source.context.sectionPath,
        text: source.text,
      });
      return { discoveryIndex: 0, proposition: source.text, claim, origin: "rewritten" };
    },
    apply: (state, items): AtomisationState => ({
      ...state,
      working: { phase: "canonicalised", items },
    }),
  });

  const resolve = stage<AtomisationState>({
    id: "resolve-item",
    execute: (state) => {
      if (state.working.phase !== "assessed") {
        throw new Error("Resolution requires assessed claims.");
      }
      const outcomes = state.working.items.map((candidate): CandidateOutcome =>
        passesCandidateIntegrity(candidate)
          ? { outcome: "accepted", candidate, accepted: candidate, reason: "" }
          : { outcome: "rejected", candidate, reason: candidate.integrity.reason },
      );
      return {
        ...state,
        working: { phase: "accepted", items: acceptedCandidates(outcomes) },
        outcomes: [...state.outcomes, ...outcomes],
      };
    },
  });

  const integrity = integrityStage(classifyIntegrity);
  const framing = framingStage(classifyFraming);
  const tagging = taggingStage(tag);
  const finalize = finalizeStage();
  const done = doneOutput();
  return pipeline({
    name: "atomization-item",
    state: AtomisationState,
    start: rewrite,
    nodes: [rewrite, integrity, resolve, framing, tagging, finalize, done],
    routes: [
      route({ from: rewrite, to: integrity, label: "item rewritten" }),
      route({ from: integrity, to: resolve, label: "integrity classified" }),
      route({ from: resolve, to: framing, label: "item resolved" }),
      route({ from: framing, to: tagging, label: "framing classified" }),
      route({ from: tagging, to: finalize, label: "atoms tagged" }),
      route({ from: finalize, to: done, label: "atomisation completed" }),
    ],
    outputs: [done],
    persist: options.persist,
  });
};
