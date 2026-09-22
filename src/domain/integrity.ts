import { z } from "zod";

export const IntegrityScoreKey = z.enum([
  "supported",
  "meaning_preserved",
  "standalone",
  "atomic",
  "context_complete",
]);
export type IntegrityScoreKey = z.infer<typeof IntegrityScoreKey>;
export const IntegrityProbability = z.number().min(0).max(1);
export const IntegrityScores = z.strictObject({
  probabilities: z.record(IntegrityScoreKey, IntegrityProbability),
  mean: IntegrityProbability,
});
export type IntegrityScores = z.infer<typeof IntegrityScores>;
export const IntegrityDecision = IntegrityScores.extend({
  supported: z.boolean(),
  meaning_preserved: z.boolean(),
  standalone: z.boolean(),
  context_complete: z.boolean(),
  atomic: z.boolean(),
  reason: z.string(),
});
export type IntegrityDecision = z.infer<typeof IntegrityDecision>;

export type IntegrityCheck = {
  readonly index: number;
  readonly key: IntegrityScoreKey;
  readonly probability: number;
  readonly reason: string;
};

export const acceptsIntegrityProbability = (probability: number): boolean => probability >= 0.6;

export const foldIntegrityChecks = (
  checks: readonly IntegrityCheck[],
  candidateCount: number,
): IntegrityDecision[] => {
  if (
    checks.some(
      (check) => !Number.isInteger(check.index) || check.index < 0 || check.index >= candidateCount,
    )
  ) {
    throw new Error("Integrity check has an invalid candidate index.");
  }
  return Array.from({ length: candidateCount }, (_, candidateIndex) => {
    const candidateChecks = checks.filter((check) => check.index === candidateIndex);
    const byKey = new Map(candidateChecks.map((check) => [check.key, check]));
    if (
      candidateChecks.length !== IntegrityScoreKey.options.length ||
      byKey.size !== IntegrityScoreKey.options.length
    ) {
      throw new Error("Integrity classification requires exactly one probability for every check.");
    }
    const probabilities = IntegrityScores.shape.probabilities.parse(
      Object.fromEntries(candidateChecks.map((check) => [check.key, check.probability])),
    );
    return {
      probabilities,
      mean:
        Object.values(probabilities).reduce((total, probability) => total + probability, 0) /
        IntegrityScoreKey.options.length,
      supported: acceptsIntegrityProbability(probabilities.supported),
      meaning_preserved: acceptsIntegrityProbability(probabilities.meaning_preserved),
      standalone: acceptsIntegrityProbability(probabilities.standalone),
      context_complete: acceptsIntegrityProbability(probabilities.context_complete),
      atomic: acceptsIntegrityProbability(probabilities.atomic),
      reason:
        candidateChecks.find((check) => !acceptsIntegrityProbability(check.probability))?.reason ??
        "",
    };
  });
};

export const passesIntegrity = (decision: IntegrityDecision): boolean =>
  decision.supported &&
  decision.meaning_preserved &&
  decision.standalone &&
  decision.atomic &&
  decision.context_complete;

export const canRepair = (decision: IntegrityDecision): boolean =>
  decision.supported &&
  decision.meaning_preserved &&
  (!decision.standalone || !decision.context_complete);

export const canSplit = (decision: IntegrityDecision): boolean =>
  decision.supported &&
  decision.meaning_preserved &&
  decision.standalone &&
  decision.context_complete &&
  !decision.atomic;
