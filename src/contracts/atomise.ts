import { z } from "zod";
import { SourcePassage } from "./source.js";
export { SourceEnvelope, SourcePassage } from "./source.js";
export const ATOMIZATION_VERSION = 9;
const WorldFraming = z.strictObject({
  layer: z.enum(["real_world", "fictional_world", "undetermined"]),
  fictional_work: z.string().min(1).max(100).nullable(),
});
export type WorldFraming = z.infer<typeof WorldFraming>;
export type WorldLayer = WorldFraming["layer"];

const EpistemicFraming = z.strictObject({
  source_commitment: z.enum(["asserted", "reported", "denied", "hedged"]),
  modal_frame: z.enum([
    "actual",
    "belief",
    "claim",
    "allegation",
    "intention",
    "attempt",
    "prediction",
    "possibility",
    "other",
  ]),
});
export type EpistemicFraming = z.infer<typeof EpistemicFraming>;
export type SourceCommitment = EpistemicFraming["source_commitment"];
export type ModalFrame = EpistemicFraming["modal_frame"];

const TemporalFraming = z.strictObject({ instability: z.enum(["stable", "mutable"]) });
export type TemporalFraming = z.infer<typeof TemporalFraming>;
export type Instability = TemporalFraming["instability"];

export const AtomFraming = z.strictObject({
  world: WorldFraming,
  epistemic: EpistemicFraming,
  temporal: TemporalFraming,
});
export type AtomFraming = z.infer<typeof AtomFraming>;

const RecoveryKind = z.enum(["repaired", "split"]);
export type RecoveryKind = z.infer<typeof RecoveryKind>;

export const Probability = z.number().min(0).max(1);
export const IntegrityScores = z.strictObject({
  probabilities: z.strictObject({
    supported: Probability.optional(),
    meaning_preserved: Probability.optional(),
    standalone: Probability.optional(),
    context_complete: Probability.optional(),
    atomic: Probability.optional(),
  }),
  mean: Probability,
});
export type IntegrityScores = z.infer<typeof IntegrityScores>;
export type IntegrityScoreKey = keyof IntegrityScores["probabilities"];

const RejectionFields = z.strictObject({
  candidateIndex: z.number().int().nonnegative(),
  proposition: z.string().min(1),
  support: z.array(SourcePassage).readonly(),
  reason: z.string().min(1),
});
export const CandidateRejection = z.discriminatedUnion("stage", [
  RejectionFields.extend({ stage: z.literal("deduplication") }),
  RejectionFields.extend({ stage: z.literal("integrity_validation"), scores: IntegrityScores }),
]);
export type CandidateRejection = z.infer<typeof CandidateRejection>;

export const AtomEvidence = z.strictObject({
  sourceId: z.string().min(1),
  sourceVersion: z.string().min(1),
  title: z.string(),
  kind: z.string(),
  passages: z.array(SourcePassage).readonly(),
});
export type AtomEvidence = z.infer<typeof AtomEvidence>;

const AtomFields = z.strictObject({
  proposition: z.string().min(1),
  claim: z.string().min(1),
  tags: z.array(z.string().trim().min(1)),
  evidence: AtomEvidence,
  atomizationVersion: z.number().int().positive(),
});

export const AtomDraft = AtomFields.extend({
  framing: AtomFraming.nullable().optional(),
  scores: IntegrityScores.optional(),
  recovery: RecoveryKind.optional(),
});
export type AtomDraft = z.infer<typeof AtomDraft>;

export const AtomizationOutput = z.strictObject({
  atomizationVersion: z.number().int().positive(),
  status: z.enum(["completed", "no_propositions", "no_valid_candidates"]),
  atoms: z.array(AtomDraft).readonly(),
  candidateRejections: z.array(CandidateRejection).readonly(),
});
export type AtomizationOutput = z.infer<typeof AtomizationOutput>;
export type AtomizationStatus = AtomizationOutput["status"];
