import { z } from "zod";
import { AtomizationOutput } from "../contracts/atomise.js";
import { SourceEnvelope } from "../contracts/source.js";
import {
  AcceptedCandidate,
  AssessedCandidate,
  CanonicalCandidate,
  DiscoveredCandidate,
  FramedCandidate,
  TaggedCandidate,
} from "./candidate.js";
import { CandidateOutcome } from "./outcomes.js";

export const WorkingCandidates = z.discriminatedUnion("phase", [
  z.strictObject({
    phase: z.literal("discovered"),
    items: z.array(DiscoveredCandidate).readonly(),
  }),
  z.strictObject({
    phase: z.literal("canonicalised"),
    items: z.array(CanonicalCandidate).readonly(),
  }),
  z.strictObject({ phase: z.literal("assessed"), items: z.array(AssessedCandidate).readonly() }),
  z.strictObject({ phase: z.literal("accepted"), items: z.array(AcceptedCandidate).readonly() }),
  z.strictObject({ phase: z.literal("framed"), items: z.array(FramedCandidate).readonly() }),
  z.strictObject({ phase: z.literal("tagged"), items: z.array(TaggedCandidate).readonly() }),
]);
export type WorkingCandidates = z.infer<typeof WorkingCandidates>;

export const AtomisationState = z.strictObject({
  source: SourceEnvelope,
  working: WorkingCandidates,
  outcomes: z.array(CandidateOutcome).readonly(),
  output: AtomizationOutput.nullable(),
});
export type AtomisationState = z.infer<typeof AtomisationState>;

export const initialAtomisationState = (source: SourceEnvelope): AtomisationState => ({
  source,
  working: { phase: "discovered", items: [] },
  outcomes: [],
  output: null,
});
