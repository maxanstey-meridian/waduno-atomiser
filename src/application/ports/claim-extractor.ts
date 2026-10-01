export type ClaimExtractionSource = {
  readonly text: string;
  readonly title: string;
  readonly context: {
    readonly sectionPath: readonly string[];
    readonly leadIn: string | null;
  };
};

export interface ClaimExtractor {
  (source: ClaimExtractionSource, signal: AbortSignal): Promise<readonly string[]>;
}
