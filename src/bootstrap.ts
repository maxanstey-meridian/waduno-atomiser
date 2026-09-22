import type { ChatClient, Pipeline } from "@maxanstey-meridian/tandem";
import { fileURLToPath } from "node:url";
import type { AtomiserConfig } from "./config.js";
import { createGlinerTagger } from "./infrastructure/gliner.js";
import { createJevClassifiers } from "./infrastructure/jev.js";
import { createAtomisationPipeline } from "./pipeline/atomise-source.js";
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
  const llmClient: ChatClient = {
    kind: "openai-compatible",
    version: 1,
    endpoint: config.llmBaseUrl,
    model: config.llmModel,
    wireApi: "completions",
    apiKeyEnvironmentVariable: config.llmApiKeyEnvironmentVariable,
    verifyModel: true,
    requestTimeoutMs: config.llmRequestTimeoutMilliseconds,
  };

  const { classifyIntegrity, classifyFraming } = createJevClassifiers(config.openRouterApiKey);
  const tagger = createGlinerTagger(
    config.glinerPython,
    fileURLToPath(new URL("../python/gliner.py", import.meta.url)),
    config.glinerModelPath,
  );
  const pipeline = createAtomisationPipeline(
    { apsClient, llmClient, classifyIntegrity, classifyFraming, tag: tagger.tag },
    { ledgerPath: config.ledgerPath, recovery: config.apsRecovery },
  );
  return { pipeline, close: tagger.close };
};
