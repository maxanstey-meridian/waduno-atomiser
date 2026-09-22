import type { EpistemicFraming, TemporalFraming, WorldFraming } from "../../domain/framing.js";

export type FramingSubject = {
  readonly claim: string;
  readonly sourceTitle: string;
  readonly sourceText: string;
  readonly sourceContext: {
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
  (subject: FramingSubject, signal: AbortSignal): Promise<FramingResult>;
}
