import {
  collection,
  output,
  pipeline,
  route,
  stage,
  type ChatClient,
  type Pipeline,
} from "@maxanstey-meridian/tandem";
import { z } from "zod";
import { createCanonicalisationAgent } from "../agents/canonicalise.js";
import { createDiscoveryAgent } from "../agents/discover.js";
import { createRepairAgent } from "../agents/repair.js";
import { createSplitAgent } from "../agents/split.js";
import type { AtomTagger } from "../application/ports/atom-tagger.js";
import type { FramingClassifier } from "../application/ports/framing-classifier.js";
import type { IntegrityClassifier } from "../application/ports/integrity-classifier.js";
import { SourceEnvelope } from "../contracts/source.js";
import { assembleFraming } from "../domain/framing.js";
import { IntegrityDecision, passesIntegrity } from "../domain/integrity.js";
import {
  AssessedCandidate,
  CanonicalCandidate,
  DiscoveredCandidate,
  type FramedCandidate,
} from "./candidate.js";
import { finalise } from "./finalize.js";
import { CandidateOutcome, acceptedCandidates, type CandidateResolution } from "./outcomes.js";
import { recoverCandidate } from "./recover-candidate.js";
import { AtomisationState } from "./state.js";

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
  {
    apsClient,
    llmClient,
    classifyIntegrity,
    classifyFraming,
    tag,
  }: AtomisationPipelineDependencies,
  options: AtomisationPipelineOptions = {},
): Pipeline<AtomisationState> => {
  const agents = {
    canonicalise: createCanonicalisationAgent(llmClient),
    repair: createRepairAgent(llmClient),
    split: createSplitAgent(apsClient),
  };
  const discovery = createDiscoveryAgent(apsClient);

  const dedupe = stage<AtomisationState>({
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

  const canonicalise = collection({
    id: "canonicalise",
    item: z.object({ source: SourceEnvelope, candidate: DiscoveredCandidate }),
    result: CanonicalCandidate,
    agents: [agents.canonicalise],
    max: 6,
    items: (state: AtomisationState) => {
      if (state.working.phase !== "discovered") {
        throw new Error("Canonicalisation requires discovered candidates.");
      }
      return state.working.items.map((candidate) => ({ source: state.source, candidate }));
    },
    execute: async ({ source, candidate }, context) => {
      const result = await context.run(agents.canonicalise, {
        sourceTitle: source.title,
        blockText: source.text,
        context: source.context,
        proposition: candidate.proposition,
      });
      return { ...candidate, claim: result.claim.trim() };
    },
    apply: (state, items): AtomisationState => ({
      ...state,
      working: { phase: "canonicalised", items },
    }),
  });

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

  const recover = collection({
    id: "recovery",
    item: z.object({ source: SourceEnvelope, candidate: AssessedCandidate }),
    result: CandidateOutcome,
    agents: [agents.canonicalise, agents.repair, agents.split],
    max: 6,
    items: (state: AtomisationState) => {
      if (state.working.phase !== "assessed") {
        throw new Error("Recovery requires assessed candidates.");
      }
      return state.working.items.map((candidate) => ({ source: state.source, candidate }));
    },
    execute: ({ source, candidate }, context): Promise<CandidateOutcome> | CandidateOutcome => {
      if (options.recovery !== false) {
        return recoverCandidate(candidate, source, classifyIntegrity, context, agents);
      }
      if (passesIntegrity(candidate.integrity)) {
        return { outcome: "accepted", candidate, accepted: candidate, reason: "", repair: null };
      }
      return { outcome: "rejected", candidate, reason: candidate.integrity.reason, repair: null };
    },
    apply: (state, results): AtomisationState => {
      let nextDiscoveryIndex =
        Math.max(
          -1,
          ...state.working.items.map((candidate) => candidate.discoveryIndex),
          ...state.outcomes.map((outcome) => outcome.candidate.discoveryIndex),
        ) + 1;
      const outcomes = results.map((outcome): CandidateOutcome => {
        if (outcome.outcome !== "split") {
          return outcome;
        }
        const children = outcome.children.map((child): CandidateResolution => {
          const discoveryIndex = nextDiscoveryIndex++;
          const candidate = { ...child.candidate, discoveryIndex };
          return child.outcome === "accepted"
            ? { ...child, candidate, accepted: { ...child.accepted, discoveryIndex } }
            : { ...child, candidate };
        });
        return { ...outcome, children };
      });
      return {
        ...state,
        working: { phase: "accepted", items: acceptedCandidates(outcomes) },
        outcomes: [...state.outcomes, ...outcomes],
      };
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
      const entities =
        candidates.length === 0
          ? []
          : await tag(
              state.source.title,
              candidates.map((candidate) => candidate.claim),
              signal,
            );
      if (entities.length !== candidates.length) {
        throw new Error("Tagger returned an incorrect number of results");
      }
      return {
        ...state,
        working: {
          phase: "tagged",
          items: candidates.map((candidate, index) => ({
            ...candidate,
            entities: entities[index]!,
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
      done,
      failed,
    ],
    routes: [
      route({
        from: discovery,
        to: done,
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
      route({ from: finalize, to: done, label: "atomisation completed" }),
    ],
    outputs: [done, failed],
    persist: options.ledgerPath !== undefined,
  });
};
