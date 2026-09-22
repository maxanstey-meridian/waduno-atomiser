import { z } from "zod";
import { AtomFraming } from "../contracts/atomise.js";
import { IntegrityDecision, passesIntegrity } from "../domain/integrity.js";

export const DiscoveredCandidate = z.strictObject({
  discoveryIndex: z.number().int().nonnegative(),
  proposition: z.string().min(1),
});
export type DiscoveredCandidate = z.infer<typeof DiscoveredCandidate>;

export const CanonicalCandidate = DiscoveredCandidate.extend({
  claim: z.string().regex(/\S/u, "Candidate has no canonical claim."),
  parentProposition: z.string().min(1).optional(),
  recovery: z.enum(["repaired", "split"]).optional(),
});
export type CanonicalCandidate = z.infer<typeof CanonicalCandidate>;

export const AssessedCandidate = CanonicalCandidate.extend({ integrity: IntegrityDecision });
export type AssessedCandidate = z.infer<typeof AssessedCandidate>;

export const AcceptedCandidate = AssessedCandidate.extend({
  integrity: IntegrityDecision.refine(passesIntegrity, "Accepted candidate failed integrity."),
});
export type AcceptedCandidate = z.infer<typeof AcceptedCandidate>;

export const FramedCandidate = AcceptedCandidate.extend({ framing: AtomFraming });
export type FramedCandidate = z.infer<typeof FramedCandidate>;

export const TaggedCandidate = FramedCandidate.extend({ tags: z.array(z.string()) });
export type TaggedCandidate = z.infer<typeof TaggedCandidate>;
