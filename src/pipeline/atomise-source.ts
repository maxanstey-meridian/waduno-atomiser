import {
  output,
  pipeline,
  route,
  type ChatClient,
  type Pipeline,
} from "@maxanstey-meridian/tandem";
import type { AtomTagger } from "../application/ports/atom-tagger.js";
import type { FramingClassifier } from "../application/ports/framing-classifier.js";
import type { IntegrityClassifier } from "../application/ports/integrity-classifier.js";
import { createCanonicalisationPipeline } from "./canonicalisation/claim.js";
import { createCanonicalisationStage } from "./canonicalisation/stage.js";
import { createDeduplicationStage } from "./deduplicate.js";
import { createDiscoveryAgent } from "./discovery/agent.js";
import { createFinalisationStage } from "./finalize.js";
import { createFramingStage } from "./framing.js";
import { createIntegrityStage } from "./integrity.js";
import { createRepairPipeline } from "./recovery/repair.js";
import { createSplitPipeline } from "./recovery/split.js";
import { createResolutionStage, createRecoveryStage } from "./recovery/stage.js";
import { AtomisationState } from "./state.js";
import { createTaggingStage } from "./tagging.js";

export type AtomisationPipelineDependencies = {
  readonly apsClient: ChatClient;
  readonly llmClient: ChatClient;
  readonly classifyIntegrity: IntegrityClassifier;
  readonly classifyFraming: FramingClassifier;
  readonly tag: AtomTagger;
};

export type AtomisationPipelineOptions = {
  readonly recovery?: boolean;
  readonly ledgerPath?: string;
};

export const createAtomisationPipeline = (
  dependencies: AtomisationPipelineDependencies,
  options: AtomisationPipelineOptions = {},
): Pipeline<AtomisationState> => {
  const persist = options.ledgerPath !== undefined;
  const claimPipeline = createCanonicalisationPipeline(dependencies.llmClient, persist);
  const repairPipeline = createRepairPipeline(dependencies.llmClient, persist);
  const splitPipeline = createSplitPipeline(dependencies.apsClient, persist);

  const discovery = createDiscoveryAgent(dependencies.apsClient);
  const dedupe = createDeduplicationStage();
  const canonicalise = createCanonicalisationStage(claimPipeline, options.ledgerPath);
  const integrity = createIntegrityStage(dependencies.classifyIntegrity);
  const recover =
    (options.recovery ?? true)
      ? createRecoveryStage(
          {
            classifyIntegrity: dependencies.classifyIntegrity,
            repairPipeline,
            splitPipeline,
            claimPipeline,
          },
          options.ledgerPath,
        )
      : createResolutionStage();
  const framing = createFramingStage(dependencies.classifyFraming);
  const finalize = createFinalisationStage();
  const tagging = createTaggingStage(dependencies.tag);

  return pipeline({
    name: "atomization-aps",
    state: AtomisationState,
    start: discovery,
    nodes: [
      discovery,
      dedupe,
      canonicalise,
      integrity,
      recover,
      framing,
      tagging,
      finalize,
      noPropositions,
      noValidCandidates,
      completed,
      failed,
    ],
    routes: [
      route({
        from: discovery,
        to: noPropositions,
        outcome: "success",
        label: "nothing discovered",
        when: (state) => state.output?.status === "no_propositions",
      }),
      route({
        from: discovery,
        to: dedupe,
        outcome: "success",
        label: "propositions discovered",
        when: (state) => state.working.items.length > 0,
      }),
      route({ from: discovery, to: failed, outcome: "failed", label: "discovery failed" }),
      route({ from: dedupe, to: canonicalise, label: "deduplicated" }),
      route({ from: canonicalise, to: integrity, label: "claims canonicalised" }),
      route({ from: integrity, to: recover, label: "integrity classified" }),
      route({ from: recover, to: framing, label: "recovery applied" }),
      route({ from: framing, to: tagging, label: "framing classified" }),
      route({ from: tagging, to: finalize, label: "atoms tagged" }),
      route({
        from: finalize,
        to: completed,
        label: "atoms accepted",
        when: (state) => state.output?.status === "completed",
      }),
      route({
        from: finalize,
        to: noValidCandidates,
        label: "integrity rejected",
        when: (state) => state.output?.status === "no_valid_candidates",
      }),
    ],
    outputs: [noPropositions, noValidCandidates, completed, failed],
    persist,
  });
};

export const noPropositions = output<AtomisationState>({
  id: "no-propositions",
  summary: () => "No propositions were discovered.",
});

export const noValidCandidates = output<AtomisationState>({
  id: "no-valid-candidates",
  summary: () => "No valid atom candidates remained.",
});

export const completed = output<AtomisationState>({
  id: "completed",
  summary: (state) => `${state.output?.atoms.length ?? 0} atoms accepted.`,
});

export const failed = output<AtomisationState>({
  id: "failed",
  failed: true,
  summary: () => "Atomization failed.",
});
