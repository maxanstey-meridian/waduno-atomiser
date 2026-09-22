import { OpenRouter } from "@openrouter/sdk";
import { HTTPClient } from "@openrouter/sdk/lib/http.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  formatOpenRouterSpend,
  measureOpenRouterSpend,
  readOpenRouterUsage,
} from "../scripts/openrouter-spend.js";

const metadata = (usage: unknown) => ({
  data: {
    allowed_data_regions: ["global"],
    byok_usage: 0,
    byok_usage_daily: 0,
    byok_usage_weekly: 0,
    byok_usage_monthly: 0,
    creator_user_id: null,
    free_model_daily_requests: { limit: 50, remaining: 50, used: 0 },
    include_byok_in_limit: false,
    is_free_tier: false,
    is_management_key: false,
    is_provisioning_key: false,
    label: "private-label",
    limit: null,
    limit_remaining: null,
    limit_reset: null,
    organization_id: null,
    workspace_id: null,
    rate_limit: { interval: "10s", note: "deprecated", requests: -1 },
    usage,
    usage_daily: 0,
    usage_weekly: 0,
    usage_monthly: 0,
  },
});

test("spend reads the official key counter and preserves small costs without retaining key metadata", async () => {
  const values = [10, 10.000019, 10.000043];
  const client = new OpenRouter({
    apiKey: "test",
    retryConfig: { strategy: "none" },
    httpClient: new HTTPClient({
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        assert.equal(request.method, "GET");
        assert.equal(new URL(request.url).pathname, "/api/v1/key");
        assert.equal(request.headers.get("authorization"), "Bearer test");
        return Response.json(metadata(values.shift()));
      },
    }),
  });
  const signal = AbortSignal.timeout(5000);
  const first = await readOpenRouterUsage(client, signal);
  const second = await readOpenRouterUsage(client, signal);
  const third = await readOpenRouterUsage(client, signal);
  const firstCost = measureOpenRouterSpend(first, second);
  const nextCost = measureOpenRouterSpend(second, third);
  const total = measureOpenRouterSpend(first, third);
  assert.equal(firstCost.status, "estimated");
  assert.equal(nextCost.status, "estimated");
  assert.equal(total.status, "estimated");
  assert.ok(Math.abs(firstCost.costUsd! - 0.000019) < 1e-12);
  assert.ok(Math.abs(firstCost.costUsd! + nextCost.costUsd! - total.costUsd!) < 1e-12);
  assert.equal(formatOpenRouterSpend(firstCost), "$0.000019 USD (key-wide estimate)");
  assert.equal(JSON.stringify(total).includes("private-label"), false);
  assert.ok(Number.isFinite(Date.parse(first.observedAt)));
});

test("failed, invalid and cancelled usage reads stay unavailable instead of manufacturing free runs", async () => {
  for (const response of [
    new Response("Unavailable", { status: 503 }),
    Response.json(metadata("bad")),
    Response.json(metadata(-1)),
  ]) {
    let requests = 0;
    const client = new OpenRouter({
      apiKey: "test",
      retryConfig: { strategy: "none" },
      httpClient: new HTTPClient({
        fetcher: async () => {
          requests++;
          return response;
        },
      }),
    });
    const snapshot = await readOpenRouterUsage(client, AbortSignal.timeout(5000));
    assert.equal(snapshot.status, "unavailable");
    assert.equal(requests, 1);
    const spend = measureOpenRouterSpend(snapshot, {
      status: "available",
      observedAt: new Date().toISOString(),
      usageUsd: 10,
    });
    assert.equal(spend.status, "unavailable");
    assert.equal(spend.costUsd, null);
    assert.match(formatOpenRouterSpend(spend), /unavailable/u);
  }
  const client = new OpenRouter({
    apiKey: "test",
    httpClient: new HTTPClient({
      fetcher: async () => assert.fail("Cancelled delay must not request usage"),
    }),
  });
  const controller = new AbortController();
  controller.abort();
  assert.equal((await readOpenRouterUsage(client, controller.signal, 2000)).status, "unavailable");
  const before = {
    status: "available" as const,
    observedAt: new Date().toISOString(),
    usageUsd: 10,
  };
  assert.equal(measureOpenRouterSpend(before, { ...before, usageUsd: 9 }).status, "unavailable");
  assert.equal(measureOpenRouterSpend(before, before).costUsd, 0);
});
