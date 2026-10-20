import type { ChatClient } from "@maxanstey-meridian/tandem";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AtomiserConfig } from "./config.js";
import { createClaimExtractor } from "./infrastructure/claim-extractor.js";
import { createFastinoTagger } from "./infrastructure/fastino.js";
import { createJevClassifiers } from "./infrastructure/jev.js";
import { createClaimExtractorAtomisationPipeline } from "./pipeline/claim-extractor-atomisation-pipeline.js";
import { createItemAtomisationPipeline } from "./pipeline/item-atomisation-pipeline.js";
import type { AtomiserPipelines } from "./pipeline/pipelines.js";

export type AtomiserRuntime = {
  readonly pipelines: AtomiserPipelines;
  readonly ledgerPath?: string;
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
  const tag = createFastinoTagger(config.tagger);
  const persist = { persist: config.ledgerPath !== undefined };
  const passage = createClaimExtractorAtomisationPipeline(
    {
      extractClaims: createClaimExtractor(
        config.python,
        fileURLToPath(new URL("../python/claim_extractor.py", import.meta.url)),
        config.claimExtractor,
      ),
      splitClient,
      classifyIntegrity,
      classifyFraming,
      tag,
    },
    persist,
  );
  const item = createItemAtomisationPipeline(
    { rewriteClient: splitClient, classifyIntegrity, classifyFraming, tag },
    persist,
  );
  return { pipelines: { passage, item }, ledgerPath: config.ledgerPath };
};
