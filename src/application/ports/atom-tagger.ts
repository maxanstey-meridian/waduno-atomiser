export interface AtomTagger {
  (title: string, claims: readonly string[], signal: AbortSignal): Promise<readonly string[][]>;
}
