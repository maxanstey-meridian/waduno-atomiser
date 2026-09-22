import type { CollectionContext, TaskAgent } from "@maxanstey-meridian/tandem";
import type { CanonicaliseInput, CanonicalClaimResponse } from "../agents/canonicalise.js";
import type { DiscoveryOutput } from "../agents/parse-propositions.js";
import type { RepairInput, RepairResponse } from "../agents/repair.js";
import type { IntegrityClassifier } from "../application/ports/integrity-classifier.js";
import type { SourceEnvelope } from "../contracts/source.js";
import { IntegrityDecision, canRepair, canSplit, passesIntegrity } from "../domain/integrity.js";
import type { AssessedCandidate } from "./candidate.js";
import type { CandidateOutcome, CandidateResolution, RepairAttempt } from "./outcomes.js";

export type RecoveryAgents = {
  readonly canonicalise: TaskAgent<CanonicaliseInput, CanonicalClaimResponse>;
  readonly repair: TaskAgent<RepairInput, RepairResponse>;
  readonly split: TaskAgent<string, DiscoveryOutput>;
};

export const recoverCandidate = async (
  candidate: AssessedCandidate,
  source: SourceEnvelope,
  classifyIntegrity: IntegrityClassifier,
  context: CollectionContext,
  agents: RecoveryAgents,
): Promise<CandidateOutcome> => {
  const { signal } = context;
  const resolve = async (assessed: AssessedCandidate): Promise<CandidateResolution> => {
    signal.throwIfAborted();
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
    const response = await context.run(agents.repair, {
      sourceTitle: source.title,
      blockText: source.text,
      context: source.context,
      proposition: assessed.proposition,
      claim: assessed.claim,
    });
    const claim = response.claim.trim();
    let repair: RepairAttempt;
    if (claim === assessed.claim.trim()) {
      repair = { outcome: "unchanged", claim };
    } else {
      const decisions = await classifyIntegrity(source, [{ ...assessed, claim }], signal);
      if (decisions.length !== 1) {
        throw new Error("Integrity classification produced an incorrect number of decisions.");
      }
      const integrity = IntegrityDecision.parse(decisions[0]);
      repair = { outcome: passesIntegrity(integrity) ? "accepted" : "rejected", claim, integrity };
    }
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

  signal.throwIfAborted();
  if (!canSplit(candidate.integrity)) {
    return resolve(candidate);
  }
  const response = await context.run(agents.split, candidate.proposition);
  if (response.items.length === 0) {
    return {
      outcome: "rejected",
      candidate,
      repair: null,
      reason: `integrity: ${candidate.integrity.reason}; re-split produced no propositions`,
    };
  }
  const parts: AssessedCandidate[] = [];
  for (const [discoveryIndex, item] of response.items.entries()) {
    signal.throwIfAborted();
    const proposition = item.proposition.trim();
    const canonical = await context.run(agents.canonicalise, {
      sourceTitle: source.title,
      blockText: source.text,
      context: source.context,
      proposition,
    });
    const claim = canonical.claim.trim();
    const decisions = await classifyIntegrity(
      source,
      [{ proposition, claim, parentProposition: candidate.proposition }],
      signal,
    );
    if (decisions.length !== 1) {
      throw new Error("Integrity classification produced no decision.");
    }
    parts.push({
      discoveryIndex,
      proposition,
      claim,
      integrity: IntegrityDecision.parse(decisions[0]),
      parentProposition: candidate.proposition,
      recovery: "split",
    });
  }
  const children: CandidateResolution[] = [];
  for (const part of parts) {
    children.push(await resolve(part));
  }
  return { outcome: "split", candidate, reason: candidate.integrity.reason, children };
};
