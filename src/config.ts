import { z } from "zod";
import type { ClaimExtractorEndpoint } from "./infrastructure/claim-extractor.js";
import type { FastinoEndpoint } from "./infrastructure/fastino.js";

const positiveInteger = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);

const modelBaseUrl = z
  .url()
  .check((ctx) => {
    const url = new URL(ctx.value);
    if (!["http:", "https:"].includes(url.protocol)) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        message: "must use HTTP or HTTPS",
      });
    }
    if (url.search || url.hash) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        message: "must not contain a query or fragment",
      });
    }
  })
  .transform((value) => value.replace(/\/$/u, ""));

const EnvironmentConfig = z.object({
  SPLIT_BASE_URL: modelBaseUrl.default("https://openrouter.ai/api/v1"),
  SPLIT_MODEL: z.string().trim().min(1).default("openai/gpt-6-luna"),
  SPLIT_API_KEY_ENVIRONMENT_VARIABLE: z.string().trim().min(1).default("OPENROUTER_API_KEY"),
  OPENROUTER_API_KEY: z.string().trim().min(1).optional(),
  TANDEM_LEDGER_PATH: z.string().trim().min(1).optional(),
  FASTINO_BASE_URL: modelBaseUrl.default("https://api.fastino.ai/v1"),
  FASTINO_MODEL: z.string().trim().min(1).default("fastino/gliner2.5-base-v1"),
  FASTINO_REQUEST_TIMEOUT_MILLISECONDS: positiveInteger(30_000),
  SPLIT_REQUEST_TIMEOUT_MILLISECONDS: positiveInteger(30_000),
  SPLIT_IDLE_TIMEOUT_MILLISECONDS: positiveInteger(30_000),
  CLAIM_EXTRACTOR_BASE_URL: modelBaseUrl.default("http://127.0.0.1:8092/v1"),
  CLAIM_EXTRACTOR_MODEL: z.string().trim().min(1).default("claim-extractor-4B-q-2605-oQ8-MTP"),
  CLAIM_EXTRACTOR_API_KEY_ENVIRONMENT_VARIABLE: z
    .string()
    .trim()
    .min(1)
    .default("CLAIM_EXTRACTOR_API_KEY"),
  CLAIM_EXTRACTOR_REQUEST_TIMEOUT_MILLISECONDS: positiveInteger(180_000),
  CLAIM_EXTRACTOR_REASONING_EFFORT: z.enum(["minimal", "low", "medium", "high"]).optional(),
});

const requiredApiKey = (environment: NodeJS.ProcessEnv, name: string, purpose: string) => {
  const value = environment[name];
  if (value === undefined || value.trim() === "") {
    throw new TypeError(`${name} is required for ${purpose}.`);
  }
  return value;
};

export type AtomiserConfig = {
  readonly splitBaseUrl: string;
  readonly splitModel: string;
  readonly splitApiKeyEnvironmentVariable: string;
  readonly openRouterApiKey: string;
  readonly python: string;
  readonly tagger: FastinoEndpoint;
  readonly ledgerPath?: string;
  readonly splitRequestTimeoutMilliseconds: number;
  readonly splitIdleTimeoutMilliseconds: number;
  readonly claimExtractor: ClaimExtractorEndpoint;
};

// Tandem and the ClaimExtractor subprocess read their keys by variable name, so only
// the names travel in config. Checking the keys here fails startup, not the first request.
export const parseAtomiserEnv = (environment: NodeJS.ProcessEnv = process.env): AtomiserConfig => {
  const value = EnvironmentConfig.parse(environment);
  const openRouterApiKey =
    value.OPENROUTER_API_KEY ??
    requiredApiKey(environment, "OPENROUTER_API_KEY", "Jev classification");
  requiredApiKey(environment, value.SPLIT_API_KEY_ENVIRONMENT_VARIABLE, "claim splitting");
  requiredApiKey(environment, value.CLAIM_EXTRACTOR_API_KEY_ENVIRONMENT_VARIABLE, "ClaimExtractor");
  const fastinoApiKey = requiredApiKey(environment, "FASTINO_API_KEY", "GLiNER tagging");
  return {
    splitBaseUrl: value.SPLIT_BASE_URL,
    splitModel: value.SPLIT_MODEL,
    splitApiKeyEnvironmentVariable: value.SPLIT_API_KEY_ENVIRONMENT_VARIABLE,
    openRouterApiKey,
    python: ".venv/bin/python",
    tagger: {
      baseUrl: value.FASTINO_BASE_URL,
      model: value.FASTINO_MODEL,
      apiKey: fastinoApiKey,
      timeoutMilliseconds: value.FASTINO_REQUEST_TIMEOUT_MILLISECONDS,
    },
    splitRequestTimeoutMilliseconds: value.SPLIT_REQUEST_TIMEOUT_MILLISECONDS,
    splitIdleTimeoutMilliseconds: value.SPLIT_IDLE_TIMEOUT_MILLISECONDS,
    claimExtractor: {
      baseUrl: value.CLAIM_EXTRACTOR_BASE_URL,
      model: value.CLAIM_EXTRACTOR_MODEL,
      apiKeyVariable: value.CLAIM_EXTRACTOR_API_KEY_ENVIRONMENT_VARIABLE,
      reasoningEffort: value.CLAIM_EXTRACTOR_REASONING_EFFORT ?? null,
      timeoutMilliseconds: value.CLAIM_EXTRACTOR_REQUEST_TIMEOUT_MILLISECONDS,
    },
    ledgerPath: value.TANDEM_LEDGER_PATH,
  };
};

const ServerConfig = z.object({
  ATOMISER_HOST: z.string().default("127.0.0.1"),
  ATOMISER_PORT: z.coerce.number().int().min(0).max(65535).default(8099),
  ATOMISER_CONCURRENCY: positiveInteger(2),
  ATOMISER_TIMEOUT_MS: positiveInteger(600_000),
  ATOMISER_QUEUE_LIMIT: positiveInteger(8),
});
export type ServerConfig = z.infer<typeof ServerConfig>;

export const parseServerEnv = (environment: NodeJS.ProcessEnv = process.env): ServerConfig =>
  ServerConfig.parse(environment);
