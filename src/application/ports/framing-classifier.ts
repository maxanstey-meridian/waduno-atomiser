import type { EpistemicFraming, TemporalFraming, WorldFraming } from "../../domain/framing.js";

export type FramingSource = {
  readonly title: string;
  readonly text: string;
  readonly context: {
    readonly sectionPath: readonly string[];
    readonly leadIn: string | null;
  };
};

export type FramingResult = {
  readonly world: WorldFraming;
  readonly epistemic: EpistemicFraming;
  readonly temporal: TemporalFraming;
};

export interface FramingClassifier {
  (
    source: FramingSource,
    claims: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly FramingResult[]>;
}
