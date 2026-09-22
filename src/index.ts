export type {
  IntegrityClassifier,
  IntegrityCandidate,
  IntegritySource,
} from "./application/ports/integrity-classifier.js";
export type { IntegrityCheck } from "./domain/integrity.js";
export type {
  FramingClassifier,
  FramingSubject,
  FramingResult,
} from "./application/ports/framing-classifier.js";
export {
  createAtomisationPipeline,
  type AtomisationPipelineDependencies,
  type AtomisationPipelineOptions,
} from "./pipeline/atomise-source.js";
export { AtomisationState, initialAtomisationState } from "./pipeline/state.js";
export { DiscoveryOutput } from "./agents/parse-propositions.js";
export type {
  EpistemicFraming,
  Instability,
  ModalFrame,
  SourceCommitment,
  TemporalFraming,
  WorldFraming,
  WorldLayer,
} from "./domain/framing.js";
export { IntegrityDecision, IntegrityScoreKey, IntegrityScores } from "./domain/integrity.js";
export {
  DiscoveredCandidate,
  CanonicalCandidate,
  AssessedCandidate,
  AcceptedCandidate,
  FramedCandidate,
  TaggedCandidate,
} from "./pipeline/candidate.js";
export { CandidateOutcome, CandidateResolution, RepairAttempt } from "./pipeline/outcomes.js";
export {
  ATOMIZATION_VERSION,
  AtomDraft,
  type AtomEvidence,
  AtomFraming,
  AtomizationOutput,
  type AtomizationStatus,
  CandidateRejection,
} from "./contracts/atomise.js";
export { SourceEnvelope, SourcePassage } from "./contracts/source.js";
export { bootstrapAtomiser, type AtomiserRuntime } from "./bootstrap.js";
export { parseAtomiserEnv, type AtomiserConfig } from "./config.js";
