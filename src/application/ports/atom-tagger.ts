export type ExtractedEntity = {
  readonly text: string;
  readonly type: string;
  readonly confidence: number;
};

export interface AtomTagger {
  (
    title: string,
    claims: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly ExtractedEntity[][]>;
}
