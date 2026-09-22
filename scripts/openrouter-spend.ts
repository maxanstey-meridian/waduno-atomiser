import type { OpenRouter } from "@openrouter/sdk";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";

export const ACCOUNTING_WAIT_MS = 2000;

type UsageSnapshot =
  | { status: "available"; observedAt: string; usageUsd: number }
  | { status: "unavailable"; observedAt: string };

export type OpenRouterSpend = {
  scope: "OPENROUTER_API_KEY";
  currency: "USD";
  accountingWaitMs: number;
  before: UsageSnapshot;
  after: UsageSnapshot;
} & (
  | { status: "estimated"; costUsd: number }
  | { status: "unavailable"; costUsd: null; reason: string }
);

export const readOpenRouterUsage = async (
  client: OpenRouter,
  signal: AbortSignal,
  waitMs = 0,
): Promise<UsageSnapshot> => {
  try {
    if (waitMs > 0) {
      await setTimeout(waitMs, undefined, { signal });
    }
    const { data } = await client.apiKeys.getCurrentKeyMetadata(undefined, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    const usageUsd = z.number().nonnegative().parse(data.usage);
    return { status: "available", observedAt: new Date().toISOString(), usageUsd };
  } catch {
    return { status: "unavailable", observedAt: new Date().toISOString() };
  }
};

export const measureOpenRouterSpend = (
  before: UsageSnapshot,
  after: UsageSnapshot,
): OpenRouterSpend => {
  const measurement = {
    scope: "OPENROUTER_API_KEY" as const,
    currency: "USD" as const,
    accountingWaitMs: ACCOUNTING_WAIT_MS,
    before,
    after,
  };
  if (before.status === "unavailable" || after.status === "unavailable") {
    return {
      ...measurement,
      status: "unavailable",
      costUsd: null,
      reason: "OpenRouter usage snapshot unavailable.",
    };
  }
  if (after.usageUsd < before.usageUsd) {
    return {
      ...measurement,
      status: "unavailable",
      costUsd: null,
      reason: "OpenRouter usage counter decreased.",
    };
  }
  return { ...measurement, status: "estimated", costUsd: after.usageUsd - before.usageUsd };
};

export const formatOpenRouterSpend = (spend: OpenRouterSpend) =>
  spend.status === "estimated"
    ? `$${spend.costUsd.toFixed(6)} USD (key-wide estimate)`
    : `unavailable (${spend.reason})`;
