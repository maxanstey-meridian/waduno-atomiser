import {
  collection,
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
import { passesIntegrity } from "../domain/integrity.js";
import { AssessedCandidate, CanonicalCandidate, DiscoveredCandidate } from "./candidate.js";
import { createCommonStages } from "./common-stages.js";
import { CandidateOutcome, acceptedCandidates, type CandidateResolution } from "./outcomes.js";
import { recoverCandidate } from "./recover-candidate.js";
import { AtomisationState } from "./state.js";

export type LunaPipelineDependencies = {
  readonly apsClient: ChatClient;
  readonly llmClient: ChatClient;
  readonly classifyIntegrity: IntegrityClassifier;
  readonly classifyFraming: FramingClassifier;
  readonly tag: AtomTagger;
};

export type LunaPipelineOptions = {
  readonly recovery?: boolean;
  readonly integrityGate?: boolean;
  readonly ledgerPath?: string;
};

export const createLunaAtomisationPipeline = (
  { apsClient, llmClient, classifyIntegrity, classifyFraming, tag }: LunaPipelineDependencies,
  options: LunaPipelineOptions = {},
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
      if (options.integrityGate === false) {
        return {
          outcome: "accepted",
          candidate,
          accepted: { ...candidate, integrity: { ...candidate.integrity, gateBypassed: true } },
          reason: "",
          repair: null,
        };
      }
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

  const { integrity, framing, tagging, finalize, done, failed } = createCommonStages(
    classifyIntegrity,
    classifyFraming,
    tag,
  );

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
