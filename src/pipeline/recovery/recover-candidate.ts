import type { Pipeline } from "@maxanstey-meridian/tandem";
import type { IntegrityClassifier } from "../../application/ports/integrity-classifier.js";
import type { SourceEnvelope } from "../../contracts/source.js";
import { canRepair, canSplit, passesIntegrity } from "../../domain/integrity.js";
import type { AssessedCandidate } from "../candidate.js";
import type { CanonicalisationState } from "../canonicalisation/claim.js";
import type { CandidateOutcome, CandidateResolution } from "../outcomes.js";
import type { RepairState } from "./repair.js";
import { repairClaim } from "./repair.js";
import type { SplitState } from "./split.js";
import { splitCandidate } from "./split.js";

export type RecoveryDependencies = {
  readonly classifyIntegrity: IntegrityClassifier;
  readonly repairPipeline: Pipeline<RepairState>;
  readonly splitPipeline: Pipeline<SplitState>;
  readonly claimPipeline: Pipeline<CanonicalisationState>;
};
export type RecoveryOptions = { readonly signal: AbortSignal; readonly ledgerPath?: string };

export const recoverCandidate = async (
  candidate: AssessedCandidate,
  source: SourceEnvelope,
  dependencies: RecoveryDependencies,
  options: RecoveryOptions,
): Promise<CandidateOutcome> => {
  const resolve = async (assessed: AssessedCandidate): Promise<CandidateResolution> => {
    options.signal.throwIfAborted();
    if (passesIntegrity(assessed.integrity)) {
      return {
        outcome: "accepted",
        candidate: assessed,
        accepted: assessed,
        reason: "",
        repair: null,
      };
    }
    if (!canRepair(assessed.integrity)) {
      return {
        outcome: "rejected",
        candidate: assessed,
        reason: `integrity: ${assessed.integrity.reason}`,
        repair: null,
      };
    }
    const repair = await repairClaim(
      source,
      assessed,
      dependencies.classifyIntegrity,
      dependencies.repairPipeline,
      options.signal,
      options.ledgerPath,
    );
    if (repair.outcome === "accepted") {
      return {
        outcome: "accepted",
        candidate: assessed,
        accepted: {
          ...assessed,
          claim: repair.claim,
          integrity: repair.integrity,
          recovery: "repaired",
        },
        reason: "",
        repair,
      };
    }
    return {
      outcome: "rejected",
      candidate: assessed,
      repair,
      reason: `integrity: ${assessed.integrity.reason}; ${repair.outcome === "unchanged" ? "repair unchanged" : "repair failed"}`,
    };
  };

  options.signal.throwIfAborted();
  if (!canSplit(candidate.integrity)) {
    return resolve(candidate);
  }
  const parts = await splitCandidate(
    source,
    candidate.proposition,
    dependencies.classifyIntegrity,
    dependencies.splitPipeline,
    dependencies.claimPipeline,
    options.signal,
    options.ledgerPath,
  );
  if (parts.length === 0) {
    return {
      outcome: "rejected",
      candidate,
      repair: null,
      reason: `integrity: ${candidate.integrity.reason}; re-split produced no propositions`,
    };
  }
  const children: CandidateResolution[] = [];
  for (const [discoveryIndex, part] of parts.entries()) {
    children.push(
      await resolve({
        discoveryIndex,
        proposition: part.proposition,
        claim: part.claim,
        integrity: part.integrity,
        parentProposition: candidate.proposition,
        recovery: "split",
      }),
    );
  }
  return { outcome: "split", candidate, reason: candidate.integrity.reason, children };
};
