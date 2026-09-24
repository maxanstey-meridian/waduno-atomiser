import type { ChatClient, Pipeline } from "@maxanstey-meridian/tandem";
import { fileURLToPath } from "node:url";
import type { AtomiserConfig } from "./config.js";
import { createClaimExtractor } from "./infrastructure/claim-extractor.js";
import { createGlinerTagger } from "./infrastructure/gliner.js";
import { createJevClassifiers } from "./infrastructure/jev.js";
import { createClaimExtractorAtomisationPipeline } from "./pipeline/claim-extractor-atomisation-pipeline.js";
import { createLunaAtomisationPipeline } from "./pipeline/luna-atomisation-pipeline.js";
import type { AtomisationState } from "./pipeline/state.js";

export type AtomiserRuntime = {
  readonly pipeline: Pipeline<AtomisationState>;
  readonly close: () => void;
};

export const bootstrapAtomiser = (config: AtomiserConfig): AtomiserRuntime => {
  const apsClient: ChatClient = {
    kind: "openai-compatible",
    version: 1,
    endpoint: config.apsBaseUrl,
    model: config.apsModel,
    wireApi: "completions",
    apiKeyEnvironmentVariable: config.apsApiKeyEnvironmentVariable,
    verifyModel: true,
    requestTimeoutMs: config.apsRequestTimeoutMilliseconds,
    idleTimeoutMs: config.apsIdleTimeoutMilliseconds,
  };
  const { classifyIntegrity, classifyFraming } = createJevClassifiers(config.openRouterApiKey);
  const tagger = createGlinerTagger(
    config.glinerPython,
    fileURLToPath(new URL("../python/gliner.py", import.meta.url)),
    config.glinerModelPath,
  );
  const pipeline =
    config.pipeline === "claim-extractor"
      ? createClaimExtractorAtomisationPipeline(
          {
            extractClaims: createClaimExtractor(
              config.glinerPython,
              fileURLToPath(new URL("../python/claim_extractor.py", import.meta.url)),
              config.claimExtractorBaseUrl,
              config.claimExtractorModel,
              config.claimExtractorApiKeyEnvironmentVariable,
              config.claimExtractorRequestTimeoutMilliseconds,
            ),
            apsClient,
            classifyIntegrity,
            classifyFraming,
            tag: tagger.tag,
          },
          { ledgerPath: config.ledgerPath, integrityGate: config.integrityGate },
        )
      : createLunaAtomisationPipeline(
          {
            apsClient,
            llmClient: {
              kind: "openai-compatible",
              version: 1,
              endpoint: config.llmBaseUrl,
              model: config.llmModel,
              wireApi: "completions",
              apiKeyEnvironmentVariable: config.llmApiKeyEnvironmentVariable,
              verifyModel: true,
              requestTimeoutMs: config.llmRequestTimeoutMilliseconds,
            },
            classifyIntegrity,
            classifyFraming,
            tag: tagger.tag,
          },
          {
            ledgerPath: config.ledgerPath,
            recovery: config.apsRecovery,
            integrityGate: config.integrityGate,
          },
        );
  return { pipeline, close: tagger.close };
};
