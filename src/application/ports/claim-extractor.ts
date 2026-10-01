export type ClaimExtractionSource = {
  readonly text: string;
  readonly title: string;
  readonly context: {
    readonly sectionPath: readonly string[];
    readonly leadIn: string | null;
  };
};

/** Where ClaimExtractor's prompt is sent: the local fine-tune, or a hosted model given the
 *  same Orbitals prompt. The stage and its output are the same either way. */
export type ClaimExtractorEndpoint = {
  readonly baseUrl: string;
  readonly model: string;
  /** Name of the variable holding the endpoint's key. */
  readonly apiKeyVariable: string;
  /** Sent only to hosted reasoning models; the local fine-tune takes no reasoning field. */
  readonly reasoningEffort: "minimal" | "low" | "medium" | "high" | null;
  readonly timeoutMilliseconds: number;
};

export interface ClaimExtractor {
  (source: ClaimExtractionSource, signal: AbortSignal): Promise<readonly string[]>;
}
