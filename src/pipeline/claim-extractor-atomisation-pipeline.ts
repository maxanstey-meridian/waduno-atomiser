import {
  collection,
  pipeline,
  route,
  stage,
  type ChatClient,
  type Pipeline,
} from "@maxanstey-meridian/tandem";
import { z } from "zod";
import { noPropositionsOutput } from "../agents/discover.js";
import { createSplitAgent } from "../agents/split.js";
import type { AtomTagger } from "../application/ports/atom-tagger.js";
import type { ClaimExtractor } from "../application/ports/claim-extractor.js";
import type { FramingClassifier } from "../application/ports/framing-classifier.js";
import type { IntegrityClassifier } from "../application/ports/integrity-classifier.js";
import { SourceEnvelope } from "../contracts/source.js";
import { IntegrityDecision, canSplit, passesIntegrity } from "../domain/integrity.js";
import { AssessedCandidate, CanonicalCandidate, type DiscoveredCandidate } from "./candidate.js";
import { createCommonStages } from "./common-stages.js";
import { CandidateOutcome, acceptedCandidates, type CandidateResolution } from "./outcomes.js";
import { AtomisationState } from "./state.js";

export type ClaimExtractorPipelineDependencies = {
  readonly extractClaims: ClaimExtractor;
  readonly apsClient: ChatClient;
  readonly classifyIntegrity: IntegrityClassifier;
  readonly classifyFraming: FramingClassifier;
  readonly tag: AtomTagger;
};

export type ClaimExtractorPipelineOptions = {
  readonly ledgerPath?: string;
  readonly integrityGate?: boolean;
};

export const createClaimExtractorAtomisationPipeline = (
  {
    extractClaims,
    apsClient,
    classifyIntegrity,
    classifyFraming,
    tag,
  }: ClaimExtractorPipelineDependencies,
  options: ClaimExtractorPipelineOptions = {},
): Pipeline<AtomisationState> => {
  const splitAgent = createSplitAgent(apsClient);
  const extracted = stage<AtomisationState>({
    id: "claim-extract",
    execute: async (state, { signal }) => {
      const claims = await extractClaims(state.source, signal);
      const items = claims.map((claim, discoveryIndex) =>
        CanonicalCandidate.parse({ discoveryIndex, proposition: claim, claim }),
      );
      return {
        ...state,
        working: { phase: "canonicalised", items },
        output: items.length === 0 ? noPropositionsOutput() : null,
      };
    },
  });

  const dedupe = stage<AtomisationState>({
    id: "dedupe",
    execute: (state) => {
      if (state.working.phase !== "canonicalised") {
        throw new Error("Deduplication requires extracted claims.");
      }
      const firstIndexByClaim = new Map<string, number>();
      const items: CanonicalCandidate[] = [];
      const outcomes = [...state.outcomes];
      for (const candidate of state.working.items) {
        const firstIndex = firstIndexByClaim.get(candidate.claim);
        if (firstIndex !== undefined) {
          const duplicate: DiscoveredCandidate = {
            discoveryIndex: candidate.discoveryIndex,
            proposition: candidate.proposition,
          };
          outcomes.push({
            outcome: "duplicate",
            candidate: duplicate,
            reason: `duplicate of candidate ${firstIndex}`,
          });
        } else {
          firstIndexByClaim.set(candidate.claim, candidate.discoveryIndex);
          items.push(candidate);
        }
      }
      return { ...state, working: { phase: "canonicalised", items }, outcomes };
    },
  });

  const resolve = collection({
    id: "resolve-claims",
    item: z.object({ source: SourceEnvelope, candidate: AssessedCandidate }),
    result: CandidateOutcome,
    agents: [splitAgent],
    max: 6,
    items: (state: AtomisationState) => {
      if (state.working.phase !== "assessed") {
        throw new Error("Resolution requires assessed claims.");
      }
      return state.working.items.map((candidate) => ({ source: state.source, candidate }));
    },
    execute: async ({ source, candidate }, context): Promise<CandidateOutcome> => {
      if (options.integrityGate !== true) {
        return {
          outcome: "accepted",
          candidate,
          accepted: { ...candidate, integrity: { ...candidate.integrity, gateBypassed: true } },
          reason: "",
          repair: null,
        };
      }
      if (passesIntegrity(candidate.integrity)) {
        return { outcome: "accepted", candidate, accepted: candidate, reason: "", repair: null };
      }
      if (!canSplit(candidate.integrity)) {
        return {
          outcome: "rejected",
          candidate,
          reason: candidate.integrity.reason,
          repair: null,
        };
      }
      const response = await context.run(splitAgent, candidate.claim);
      if (response.items.length < 2) {
        return {
          outcome: "rejected",
          candidate,
          reason: `${candidate.integrity.reason}; APS did not split the claim`,
          repair: null,
        };
      }
      const children: CandidateResolution[] = [];
      for (const [discoveryIndex, item] of response.items.entries()) {
        context.signal.throwIfAborted();
        const claim = item.proposition.trim();
        const child = {
          discoveryIndex,
          proposition: claim,
          claim,
          parentProposition: candidate.claim,
          recovery: "split" as const,
        };
        const decisions = await classifyIntegrity(source, [child], context.signal);
        if (decisions.length !== 1) {
          throw new Error("Integrity classification produced an incorrect number of decisions.");
        }
        const assessed = AssessedCandidate.parse({
          ...child,
          integrity: IntegrityDecision.parse(decisions[0]),
        });
        children.push(
          passesIntegrity(assessed.integrity)
            ? {
                outcome: "accepted",
                candidate: assessed,
                accepted: assessed,
                reason: "",
                repair: null,
              }
            : {
                outcome: "rejected",
                candidate: assessed,
                reason: assessed.integrity.reason,
                repair: null,
              },
        );
      }
      return { outcome: "split", candidate, reason: candidate.integrity.reason, children };
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

  const { integrity, framing, tagging, finalize, done } = createCommonStages(
    classifyIntegrity,
    classifyFraming,
    tag,
  );
  return pipeline({
    name: "atomization-claim-extractor",
    state: AtomisationState,
    start: extracted,
    nodes: [extracted, dedupe, integrity, resolve, framing, tagging, finalize, done],
    routes: [
      route({
        from: extracted,
        to: done,
        label: "no claims extracted",
        when: (state) => state.output?.status === "no_propositions",
      }),
      route({
        from: extracted,
        to: dedupe,
        label: "claims extracted",
        when: (state) => state.working.items.length > 0,
      }),
      route({ from: dedupe, to: integrity, label: "claims deduplicated" }),
      route({ from: integrity, to: resolve, label: "integrity classified" }),
      route({ from: resolve, to: framing, label: "claims resolved" }),
      route({ from: framing, to: tagging, label: "framing classified" }),
      route({ from: tagging, to: finalize, label: "atoms tagged" }),
      route({ from: finalize, to: done, label: "atomisation completed" }),
    ],
    outputs: [done],
    persist: options.ledgerPath !== undefined,
  });
};
