import {
  output,
  parallel,
  pipeline,
  route,
  stage,
  type Pipeline,
} from "@maxanstey-meridian/tandem";
import { z } from "zod";
import { SourceEnvelope } from "../../contracts/source.js";
import { AssessedCandidate } from "../candidate.js";
import { CandidateOutcome, type CandidateResolution } from "../outcomes.js";
import { recoverCandidate, type RecoveryDependencies } from "./recover-candidate.js";

export const RecoveryBatchState = z.strictObject({
  source: SourceEnvelope,
  candidates: z.array(AssessedCandidate).readonly(),
  nextDiscoveryIndex: z.number().int().nonnegative(),
  outcomes: z.array(CandidateOutcome).readonly(),
});
export type RecoveryBatchState = z.infer<typeof RecoveryBatchState>;

const mergeRecovery = (
  baseline: RecoveryBatchState,
  results: readonly RecoveryBatchState[],
): RecoveryBatchState => {
  let nextDiscoveryIndex = baseline.nextDiscoveryIndex;
  const outcomes = results
    .flatMap((result) => result.outcomes)
    .map((outcome): CandidateOutcome => {
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
  return { ...baseline, outcomes };
};

export const createRecoveryBatchPipeline = (
  dependencies: RecoveryDependencies,
  candidateCount: number,
  ledgerPath?: string,
): Pipeline<RecoveryBatchState> => {
  const branches = Object.fromEntries(
    Array.from({ length: candidateCount }, (_, index) => [
      `candidate-${index}`,
      stage<RecoveryBatchState>({
        id: `recover-${index}`,
        execute: async (state, { signal }) => {
          const candidate = state.candidates[index];
          if (candidate === undefined) {
            throw new Error("Recovery candidate is missing.");
          }
          const outcome = await recoverCandidate(candidate, state.source, dependencies, {
            signal,
            ledgerPath,
          });
          const result = { ...state, outcomes: [outcome] };
          return candidateCount === 1 ? mergeRecovery(state, [result]) : result;
        },
      }),
    ]),
  );
  const recover =
    candidateCount === 1
      ? branches["candidate-0"]!
      : parallel<RecoveryBatchState>()({
          id: "recover-candidates",
          max: 6,
          branches,
          merge: (baseline, results) =>
            mergeRecovery(
              baseline,
              Array.from({ length: candidateCount }, (_, index) => results[`candidate-${index}`]!),
            ),
        });
  const done = output<RecoveryBatchState>({ id: "done", summary: () => "Recovery completed" });
  const failed = output<RecoveryBatchState>({
    id: "failed",
    failed: true,
    summary: () => "Recovery failed",
  });
  return pipeline({
    name: "aps-recover-candidates",
    state: RecoveryBatchState,
    start: recover,
    nodes: recover.kind === "stage" ? [recover, done] : [recover, done, failed],
    routes:
      recover.kind === "stage"
        ? [route({ from: recover, to: done, label: "candidate recovered" })]
        : [
            route({ from: recover, to: done, outcome: "success", label: "candidates recovered" }),
            route({ from: recover, to: failed, outcome: "failed", label: "recovery failed" }),
          ],
    outputs: recover.kind === "stage" ? [done] : [done, failed],
    persist: ledgerPath !== undefined,
  });
};
