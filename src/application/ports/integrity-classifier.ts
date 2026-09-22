import type { IntegrityDecision } from "../../domain/integrity.js";

// The classifier owns batching and answer indices. Callers receive one decision
// per candidate, in the same order.
export type IntegrityCandidate = {
  readonly proposition: string;
  readonly claim: string;
  readonly parentProposition?: string;
};

export type IntegritySource = {
  readonly title: string;
  readonly text: string;
  readonly context: {
    readonly sectionPath: readonly string[];
    readonly leadIn: string | null;
  };
};

export interface IntegrityClassifier {
  (
    source: IntegritySource,
    candidates: readonly IntegrityCandidate[],
    signal: AbortSignal,
  ): Promise<readonly IntegrityDecision[]>;
}
