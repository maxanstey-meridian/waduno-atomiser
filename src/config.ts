import { z } from "zod";

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

// Validate the environment-facing names once, then hand the rest of the app a
// typed config. Secret variable names are retained where Tandem resolves the key.
const EnvironmentConfig = z.object({
  APS_BASE_URL: modelBaseUrl.default("http://127.0.0.1:8092/v1"),
  APS_MODEL: z.string().trim().min(1).default("gemma-7b-aps-it-8bit"),
  APS_API_KEY_ENVIRONMENT_VARIABLE: z.string().trim().min(1).default("APS_API_KEY"),
  OPENROUTER_API_KEY: z.string().trim().min(1).optional(),
  TANDEM_LEDGER_PATH: z.string().trim().min(1).default(".data/atomize.sqlite3"),
  GLINER_PYTHON: z.string().trim().min(1).default(".venv/bin/python"),
  GLINER_MODEL_PATH: z.string().trim().min(1).default(".data/gliner2.5-base-v1"),
  ATOMIZER_RECOVERY: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  APS_REQUEST_TIMEOUT_MILLISECONDS: positiveInteger(120_000),
  APS_IDLE_TIMEOUT_MILLISECONDS: positiveInteger(30_000),
  LLM_BASE_URL: modelBaseUrl.default("https://openrouter.ai/api/v1"),
  LLM_MODEL: z.string().trim().min(1).default("openai/gpt-6-luna"),
  LLM_API_KEY_ENVIRONMENT_VARIABLE: z.string().trim().min(1).default("OPENROUTER_API_KEY"),
  LLM_REQUEST_TIMEOUT_MILLISECONDS: positiveInteger(120_000),
});

const requiredApiKey = (environment: NodeJS.ProcessEnv, name: string, purpose: string) => {
  const value = environment[name];
  if (value === undefined || value.trim() === "") {
    throw new TypeError(`${name} is required for ${purpose}.`);
  }
  return value;
};

export type AtomiserConfig = {
  readonly apsBaseUrl: string;
  readonly apsModel: string;
  readonly apsApiKeyEnvironmentVariable?: string;
  readonly openRouterApiKey: string;
  readonly glinerPython: string;
  readonly glinerModelPath: string;
  readonly ledgerPath?: string;
  readonly apsRecovery: boolean;
  readonly apsRequestTimeoutMilliseconds: number;
  readonly apsIdleTimeoutMilliseconds: number;
  readonly llmBaseUrl: string;
  readonly llmModel: string;
  readonly llmApiKeyEnvironmentVariable: string;
  readonly llmRequestTimeoutMilliseconds: number;
};

// Entrypoints pass their environment here. Defaults and required-key checks are
// resolved before any client is constructed; no downstream code needs to repeat them.
export const parseAtomiserEnv = (environment: NodeJS.ProcessEnv = process.env): AtomiserConfig => {
  const value = EnvironmentConfig.parse(environment);
  const apsApiKeyEnvironmentVariable = value.APS_API_KEY_ENVIRONMENT_VARIABLE;
  const openRouterApiKey =
    value.OPENROUTER_API_KEY ??
    requiredApiKey(environment, "OPENROUTER_API_KEY", "Jev classification");
  requiredApiKey(
    environment,
    value.LLM_API_KEY_ENVIRONMENT_VARIABLE,
    "canonicalisation and repair",
  );
  return {
    apsBaseUrl: value.APS_BASE_URL,
    apsModel: value.APS_MODEL,
    ...(environment[apsApiKeyEnvironmentVariable]?.trim() ? { apsApiKeyEnvironmentVariable } : {}),
    openRouterApiKey,
    glinerPython: value.GLINER_PYTHON,
    glinerModelPath: value.GLINER_MODEL_PATH,
    apsRecovery: value.ATOMIZER_RECOVERY,
    apsRequestTimeoutMilliseconds: value.APS_REQUEST_TIMEOUT_MILLISECONDS,
    apsIdleTimeoutMilliseconds: value.APS_IDLE_TIMEOUT_MILLISECONDS,
    llmBaseUrl: value.LLM_BASE_URL,
    llmModel: value.LLM_MODEL,
    llmApiKeyEnvironmentVariable: value.LLM_API_KEY_ENVIRONMENT_VARIABLE,
    llmRequestTimeoutMilliseconds: value.LLM_REQUEST_TIMEOUT_MILLISECONDS,
    ...(value.TANDEM_LEDGER_PATH === undefined ? {} : { ledgerPath: value.TANDEM_LEDGER_PATH }),
  };
};

const ServerConfig = z.object({
  ATOMISER_HOST: z.string().default("127.0.0.1"),
  ATOMISER_PORT: z.coerce.number().int().min(0).max(65535).default(8099),
  ATOMISER_CONCURRENCY: positiveInteger(2),
  ATOMISER_TIMEOUT_MS: positiveInteger(600_000),
});
export type ServerConfig = z.infer<typeof ServerConfig>;

export const parseServerEnv = (environment: NodeJS.ProcessEnv = process.env): ServerConfig =>
  ServerConfig.parse(environment);
