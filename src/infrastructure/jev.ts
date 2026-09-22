import { OpenRouter } from "@openrouter/sdk";
import { HTTPClient } from "@openrouter/sdk/lib/http.js";
import type { DecisionsNoulQuestion } from "@openrouter/sdk/models";
import { z } from "zod";
import type { FramingClassifier, FramingSubject } from "../application/ports/framing-classifier.js";
import type { IntegrityClassifier } from "../application/ports/integrity-classifier.js";
import {
  type WorldLayer,
  type SourceCommitment,
  type ModalFrame,
  type Instability,
} from "../domain/framing.js";
import { IntegrityProbability } from "../domain/integrity.js";
import {
  acceptsIntegrityProbability,
  foldIntegrityChecks,
  type IntegrityCheck,
} from "../domain/integrity.js";
import {
  framingQuestions,
  integrityRules,
  classificationInstruction,
  splitPreservation,
} from "./jev-prompts.js";

const INTEGRITY_BATCH_SIZE = 100;
const IntegrityAnswer = z.object({ type: z.literal("noul"), noul: IntegrityProbability });
const ChoiceAnswer = z.object({ type: z.literal("choice"), choice: z.string() });

const FramingAnswers = z.object({
  world_layer: z.enum([
    "real_world",
    "fictional_world",
    "undetermined",
  ]) satisfies z.ZodType<WorldLayer>,
  source_commitment: z.enum([
    "asserted",
    "reported",
    "denied",
    "hedged",
  ]) satisfies z.ZodType<SourceCommitment>,
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
  ]) satisfies z.ZodType<ModalFrame>,
  temporal_instability: z.enum(["stable", "mutable"]) satisfies z.ZodType<Instability>,
});

const framingRequest = (subject: FramingSubject) => ({
  state: {
    claim: subject.claim,
    source: {
      title: subject.sourceTitle,
      text: subject.sourceText,
      context: subject.sourceContext,
    },
  },
  questions: framingQuestions,
});

const framingClassifier =
  (client: OpenRouter): FramingClassifier =>
  async (subject, signal) => {
    const { answers } = await client.alpha.decisions.create(
      { decisionsRequest: { model: "typesafe/jev-1.13", ...framingRequest(subject) } },
      { signal },
    );
    const labels = FramingAnswers.parse({
      world_layer: ChoiceAnswer.parse(answers.world_layer).choice,
      source_commitment: ChoiceAnswer.parse(answers.source_commitment).choice,
      modal_frame: ChoiceAnswer.parse(answers.modal_frame).choice,
      temporal_instability: ChoiceAnswer.parse(answers.temporal_instability).choice,
    });
    return {
      world: {
        layer: labels.world_layer,
        fictional_work: null,
      },
      epistemic: { source_commitment: labels.source_commitment, modal_frame: labels.modal_frame },
      temporal: { instability: labels.temporal_instability },
    };
  };

// Each bounded batch shares one source context. Index the provider questions so
// folding returns decisions in input order across all batches and checks.
const integrityClassifier =
  (client: OpenRouter): IntegrityClassifier =>
  async (source, candidates, signal) => {
    const checks: IntegrityCheck[] = [];
    for (let start = 0; start < candidates.length; start += INTEGRITY_BATCH_SIZE) {
      signal.throwIfAborted();
      const batch = candidates.slice(start, start + INTEGRITY_BATCH_SIZE);
      for (const rule of integrityRules) {
        const questions = Object.fromEntries(
          batch.map((candidate, position) => {
            const question =
              rule.key === "meaning_preserved" && candidate.parentProposition !== undefined
                ? splitPreservation
                : rule;
            return [
              `a${start + position}`,
              {
                type: "noul",
                instructions: {
                  ...(rule.key === "context_complete"
                    ? {}
                    : { instruction: classificationInstruction }),
                  ...(rule.key === "standalone" || rule.key === "context_complete"
                    ? {}
                    : { proposition: candidate.proposition }),
                  claim: candidate.claim,
                  ...(rule.key === "meaning_preserved" && candidate.parentProposition !== undefined
                    ? { parent_proposition: candidate.parentProposition }
                    : {}),
                  question: question.ask,
                },
                criteria: question.criteria,
              } satisfies DecisionsNoulQuestion,
            ];
          }),
        );
        const { answers } = await client.alpha.decisions.create(
          {
            decisionsRequest: {
              model: "typesafe/jev-1.13",
              state:
                rule.key === "standalone"
                  ? {}
                  : { source: { text: source.text, title: source.title, context: source.context } },
              questions,
            },
          },
          { signal },
        );
        for (let position = 0; position < batch.length; position += 1) {
          const index = start + position;
          const probability = IntegrityAnswer.parse(answers[`a${index}`]).noul;
          const accepted = acceptsIntegrityProbability(probability);
          checks.push({
            index,
            key: rule.key,
            probability,
            reason: accepted ? "" : `${rule.rejectPrefix}: ${rule.key} P=${probability.toFixed(2)}`,
          });
        }
      }
    }
    return foldIntegrityChecks(checks, candidates.length);
  };

export type JevClassifiers = {
  readonly classifyIntegrity: IntegrityClassifier;
  readonly classifyFraming: FramingClassifier;
};

export const createJevClassifiers = (
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): JevClassifiers => {
  const client = new OpenRouter({
    apiKey,
    httpClient: new HTTPClient({ fetcher: fetchImpl }),
    retryConfig: { strategy: "none" },
  });
  return {
    classifyIntegrity: integrityClassifier(client),
    classifyFraming: framingClassifier(client),
  };
};
