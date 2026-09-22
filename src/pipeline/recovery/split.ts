import {
  output,
  pipeline,
  route,
  type ChatClient,
  type Pipeline,
  run,
  agent,
  type Agent,
} from "@maxanstey-meridian/tandem";
import { z } from "zod";
import { type IntegrityClassifier } from "../../application/ports/integrity-classifier.js";
import { type SourceEnvelope } from "../../contracts/source.js";
import { IntegrityDecision } from "../../domain/integrity.js";
import { AssessedCandidate } from "../candidate.js";
import { type CanonicalisationState } from "../canonicalisation/claim.js";
import { type DiscoveryOutput, parseApsPropositions } from "../discovery/parse.js";

export const SplitState = z.strictObject({
  proposition: z.string(),
  propositions: z.array(z.string()),
});
export type SplitState = z.infer<typeof SplitState>;

export const createSplitPipeline = (client: ChatClient, persist = false): Pipeline<SplitState> => {
  const split = createSplitAgent(client);
  const done = output<SplitState>({
    id: "split",
    summary: (state) => `${state.propositions.length} propositions`,
  });
  const failed = output<SplitState>({ id: "failed", failed: true, summary: () => "failed" });

  return pipeline({
    persist,
    name: "aps-atomic-re-split",
    state: SplitState,
    start: split,
    nodes: [split, done, failed],
    outputs: [done, failed],
    routes: [
      route({ from: split, to: done, outcome: "success", label: "split" }),
      route({ from: split, to: failed, outcome: "failed", label: "split failed" }),
    ],
  });
};

export const SplitCandidate = AssessedCandidate.pick({
  proposition: true,
  claim: true,
  integrity: true,
});
export type SplitCandidate = z.infer<typeof SplitCandidate>;

export const splitCandidate = async (
  source: SourceEnvelope,
  proposition: string,
  classifyIntegrity: IntegrityClassifier,
  splitPipeline: Pipeline<SplitState>,
  claimPipeline: Pipeline<CanonicalisationState>,
  signal: AbortSignal,
  ledgerPath?: string,
): Promise<SplitCandidate[]> => {
  const result = await run(
    splitPipeline,
    { proposition, propositions: [] },
    { signal, ledgerPath },
  );
  if (!result.succeeded) {
    throw new Error(result.summary ?? "Splitting failed.");
  }
  const children: SplitCandidate[] = [];
  for (const part of result.state.propositions) {
    signal.throwIfAborted();
    const canonicalised = await run(
      claimPipeline,
      {
        sourceTitle: source.title,
        blockText: source.text,
        context: source.context,
        proposition: part,
        claim: null,
      },
      { signal, ledgerPath },
    );
    if (!canonicalised.succeeded || canonicalised.state.claim === null) {
      throw new Error(canonicalised.summary ?? "Child canonicalisation failed.");
    }
    const claim = canonicalised.state.claim;
    const decisions = await classifyIntegrity(
      source,
      [{ proposition: part, claim, parentProposition: proposition }],
      signal,
    );
    if (decisions.length !== 1) {
      throw new Error("Integrity classification produced no decision.");
    }
    children.push({ proposition: part, claim, integrity: IntegrityDecision.parse(decisions[0]) });
  }
  return children;
};

export const createSplitAgent = (client: ChatClient): Agent<SplitState> =>
  agent<SplitState, DiscoveryOutput>({
    id: "aps-re-split",
    instructions: "",
    client,
    reasoning: { effort: "none" },
    temperature: 0,
    maxOutputTokens: 2048,
    message: (state) => state.proposition,
    output: {
      instructions: "",
      raw: true,
      parse: parseApsPropositions,
      validateFor: () => [],
      apply: (state, value) => ({
        ...state,
        propositions: value.items.map((item) => item.proposition.trim()),
      }),
    },
  });
