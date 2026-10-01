import type { ChatClient, Pipeline } from "@maxanstey-meridian/tandem";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AtomiserConfig } from "./config.js";
import { createClaimExtractor } from "./infrastructure/claim-extractor.js";
import { createGlinerTagger } from "./infrastructure/gliner.js";
import { createJevClassifiers } from "./infrastructure/jev.js";
import { createClaimExtractorAtomisationPipeline } from "./pipeline/claim-extractor-atomisation-pipeline.js";
import type { AtomisationState } from "./pipeline/state.js";

export type AtomiserRuntime = {
  readonly pipeline: Pipeline<AtomisationState>;
  readonly ledgerPath?: string;
  readonly close: () => void;
};

export const bootstrapAtomiser = async (config: AtomiserConfig): Promise<AtomiserRuntime> => {
  if (config.ledgerPath) {
    await mkdir(dirname(config.ledgerPath), { recursive: true });
  }
  const splitClient: ChatClient = {
    kind: "openai-compatible",
    version: 1,
    endpoint: config.splitBaseUrl,
    model: config.splitModel,
    wireApi: "completions",
    apiKeyEnvironmentVariable: config.splitApiKeyEnvironmentVariable,
    verifyModel: true,
    requestTimeoutMs: config.splitRequestTimeoutMilliseconds,
    idleTimeoutMs: config.splitIdleTimeoutMilliseconds,
  };
  const { classifyIntegrity, classifyFraming } = createJevClassifiers(config.openRouterApiKey);
  const tagger = createGlinerTagger(
    config.glinerPython,
    fileURLToPath(new URL("../python/gliner.py", import.meta.url)),
    config.glinerModelPath,
  );
  const pipeline = createClaimExtractorAtomisationPipeline(
    {
      extractClaims: createClaimExtractor(
        config.glinerPython,
        fileURLToPath(new URL("../python/claim_extractor.py", import.meta.url)),
        config.claimExtractor,
      ),
      splitClient,
      classifyIntegrity,
      classifyFraming,
      tag: tagger.tag,
    },
    { persist: config.ledgerPath !== undefined },
  );
  return { pipeline, ledgerPath: config.ledgerPath, close: tagger.close };
};
