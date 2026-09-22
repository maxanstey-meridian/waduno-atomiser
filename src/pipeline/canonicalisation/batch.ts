import {
  output,
  parallel,
  pipeline,
  route,
  run,
  stage,
  type Pipeline,
} from "@maxanstey-meridian/tandem";
import { z } from "zod";
import { SourceEnvelope } from "../../contracts/source.js";
import { CanonicalCandidate, DiscoveredCandidate } from "../candidate.js";
import type { CanonicalisationState } from "./claim.js";

const CANONICALISATION_CONCURRENCY = 6;

export const CanonicalisationBatchState = z.object({
  source: SourceEnvelope,
  candidates: z.array(DiscoveredCandidate).readonly(),
  canonicalised: z.array(CanonicalCandidate).readonly(),
});
export type CanonicalisationBatchState = z.infer<typeof CanonicalisationBatchState>;

export const createCanonicalisationBatchPipeline = (
  claimPipeline: Pipeline<CanonicalisationState>,
  candidateCount: number,
  ledgerPath?: string,
): Pipeline<CanonicalisationBatchState> => {
  const branches = Object.fromEntries(
    Array.from({ length: candidateCount }, (_, index) => [
      `candidate-${index}`,
      stage<CanonicalisationBatchState>({
        id: `canonicalize-${index}`,
        execute: async (state, { signal }) => {
          const candidate = state.candidates[index]!;
          const result = await run(
            claimPipeline,
            {
              sourceTitle: state.source.title,
              blockText: state.source.text,
              context: state.source.context,
              proposition: candidate.proposition,
              claim: null,
            },
            { signal, ledgerPath },
          );
          if (!result.succeeded || result.state.claim === null) {
            throw new Error(result.summary ?? "Canonicalisation failed.");
          }
          return {
            ...state,
            canonicalised: [CanonicalCandidate.parse({ ...candidate, claim: result.state.claim })],
          };
        },
      }),
    ]),
  );

  const done = output<CanonicalisationBatchState>({
    id: "done",
    summary: (state) => `${state.canonicalised.length} claims canonicalised`,
  });
  const failed = output<CanonicalisationBatchState>({
    id: "failed",
    failed: true,
    summary: () => "Canonicalisation failed.",
  });
  const canonicalise =
    candidateCount === 1
      ? branches["candidate-0"]!
      : parallel<CanonicalisationBatchState>()({
          id: "canonicalize-candidates",
          max: CANONICALISATION_CONCURRENCY,
          branches,
          merge: (baseline, results) => ({
            ...baseline,
            canonicalised: baseline.candidates.map(
              (_, index) => results[`candidate-${index}`]!.canonicalised[0]!,
            ),
          }),
        });
  return pipeline({
    name: "aps-canonicalize-candidates",
    state: CanonicalisationBatchState,
    start: canonicalise,
    nodes: canonicalise.kind === "stage" ? [canonicalise, done] : [canonicalise, done, failed],
    routes:
      canonicalise.kind === "stage"
        ? [route({ from: canonicalise, to: done, label: "claim canonicalised" })]
        : [
            route({
              from: canonicalise,
              to: done,
              outcome: "success",
              label: "claims canonicalised",
            }),
            route({
              from: canonicalise,
              to: failed,
              outcome: "failed",
              label: "canonicalisation failed",
            }),
          ],
    outputs: canonicalise.kind === "stage" ? [done] : [done, failed],
    persist: ledgerPath !== undefined,
  });
};
