import { pipeline, stage, route, output } from "@maxanstey-meridian/tandem";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseAtomiserEnv } from "../src/config.js";
import { SourceEnvelope } from "../src/contracts/source.js";
import { createAtomiserServer } from "../src/interface/http/server.js";
import { createClaimExtractorAtomisationPipeline } from "../src/pipeline/claim-extractor-atomisation-pipeline.js";
import { AtomisationState } from "../src/pipeline/state.js";
import { chatServer } from "./helpers/chat-server.js";

const source = SourceEnvelope.parse(
  JSON.parse(
    readFileSync(
      new URL("./fixtures/source-envelope-quick-brown-fox.json", import.meta.url),
      "utf8",
    ),
  ),
);

test("HTTP validates input, extracts every source kind, and distinguishes empty and failed runs", async (t) => {
  let extracted: readonly string[] | Error = ["The fox jumps."];
  const server = await chatServer(t, () => assert.fail("Accepted claims must not be split"));
  const pipeline = createClaimExtractorAtomisationPipeline(
    {
      extractClaims: async () => {
        if (extracted instanceof Error) {
          throw extracted;
        }
        return [...extracted];
      },
      splitClient: server.client("split"),
      tag: async (_title, claims) => claims.map(() => ["Fox"]),
      classifyIntegrity: async (_source, candidates) =>
        candidates.map(() => ({
          supported: true,
          meaning_preserved: true,
          standalone: true,
          context_complete: true,
          atomic: true,
          probabilities: {
            supported: 1,
            meaning_preserved: 1,
            standalone: 1,
            context_complete: 1,
            atomic: 1,
          },
          mean: 1,
          reason: "",
        })),
      classifyFraming: async (_source, claims) =>
        claims.map(() => ({
          world: { layer: "real_world" },
          epistemic: { source_commitment: "asserted", modal_frame: "actual" },
          temporal: { instability: "stable" },
        })),
    },
    { persist: false },
  );
  const { app } = createAtomiserServer(
    { passage: pipeline, item: pipeline },
    {
      concurrency: 1,
      timeoutMs: 5000,
      queueLimit: 8,
    },
  );
  t.after(() => app.close());
  assert.equal(
    (await app.inject({ method: "POST", url: "/atomise", payload: { articleId: "wrong" } }))
      .statusCode,
    400,
  );
  for (const kind of ["paragraph", "caption", "custom"]) {
    const response = await app.inject({
      method: "POST",
      url: "/atomise",
      payload: { ...source, kind },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().status, "completed");
    assert.equal(response.json().atoms[0].claim, "The fox jumps.");
    assert.deepEqual(response.json().atoms[0].tags, ["Fox"]);
  }
  extracted = ["The fox jumps.", "The fox jumps."];
  const duplicates = await app.inject({ method: "POST", url: "/atomise", payload: source });
  assert.equal(duplicates.statusCode, 200, duplicates.body);
  assert.equal(duplicates.json().atoms.length, 1);
  assert.deepEqual(duplicates.json().candidateRejections, [
    {
      candidateIndex: 1,
      stage: "deduplication",
      proposition: "The fox jumps.",
      support: source.passages,
      reason: "duplicate of candidate 0",
    },
  ]);
  extracted = [];
  assert.equal(
    (await app.inject({ method: "POST", url: "/atomise", payload: source })).json().status,
    "no_propositions",
  );
  extracted = new Error("ClaimExtractor is unavailable.");
  const failed = await app.inject({ method: "POST", url: "/atomise", payload: source });
  assert.equal(failed.statusCode, 502, failed.body);
  assert.equal(failed.json().code, "atomisation_failed");
  assert.equal((await app.inject("/health")).json().active, 0);
});

const keys = {
  OPENROUTER_API_KEY: "jev-key",
  CLAIM_EXTRACTOR_API_KEY: "extractor-key",
  FASTINO_API_KEY: "fastino-key",
};

test("the splitter defaults to Luna on OpenRouter and accepts only HTTP endpoints", () => {
  const config = parseAtomiserEnv(keys);
  assert.equal(config.splitBaseUrl, "https://openrouter.ai/api/v1");
  assert.equal(config.splitModel, "openai/gpt-6-luna");
  assert.equal(config.splitApiKeyEnvironmentVariable, "OPENROUTER_API_KEY");
  assert.equal("corpusBaseUrl" in config, false);
  assert.throws(() => parseAtomiserEnv({ ...keys, SPLIT_BASE_URL: "file:///tmp/model" }));
});

test("configuration defaults the ClaimExtractor and tagger models and passes reasoning effort through", () => {
  const config = parseAtomiserEnv(keys);
  assert.equal(config.openRouterApiKey, "jev-key");
  assert.deepEqual(config.tagger, {
    baseUrl: "https://api.fastino.ai/v1",
    model: "fastino/gliner2.5-base-v1",
    apiKey: "fastino-key",
    timeoutMilliseconds: 30_000,
  });
  assert.deepEqual(config.claimExtractor, {
    baseUrl: "http://127.0.0.1:8092/v1",
    model: "claim-extractor-4B-q-2605-oQ8-MTP",
    apiKeyVariable: "CLAIM_EXTRACTOR_API_KEY",
    reasoningEffort: null,
    timeoutMilliseconds: 180_000,
  });
  assert.equal(
    parseAtomiserEnv({ ...keys, CLAIM_EXTRACTOR_REASONING_EFFORT: "minimal" }).claimExtractor
      .reasoningEffort,
    "minimal",
  );
});

test("startup fails when any model key is missing", () => {
  assert.throws(
    () => parseAtomiserEnv({ ...keys, OPENROUTER_API_KEY: undefined }),
    /OPENROUTER_API_KEY is required/u,
  );
  assert.throws(
    () => parseAtomiserEnv({ ...keys, SPLIT_API_KEY_ENVIRONMENT_VARIABLE: "SPLIT_KEY" }),
    /SPLIT_KEY is required for claim splitting/u,
  );
  assert.throws(
    () => parseAtomiserEnv({ ...keys, CLAIM_EXTRACTOR_API_KEY: " " }),
    /CLAIM_EXTRACTOR_API_KEY is required for ClaimExtractor/u,
  );
  assert.throws(
    () => parseAtomiserEnv({ ...keys, FASTINO_API_KEY: "" }),
    /FASTINO_API_KEY is required for GLiNER tagging/u,
  );
  assert.equal(
    parseAtomiserEnv({
      OPENROUTER_API_KEY: "jev-key",
      FASTINO_API_KEY: "fastino-key",
      CLAIM_EXTRACTOR_API_KEY_ENVIRONMENT_VARIABLE: "OPENROUTER_API_KEY",
    }).claimExtractor.apiKeyVariable,
    "OPENROUTER_API_KEY",
  );
});

test(
  "HTTP timeout and shutdown cancel work and release occupied capacity",
  { timeout: 10000 },
  async (t) => {
    for (const shutdown of [false, true]) {
      let entered = () => {};
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let cancelled = false;
      const wait = stage<AtomisationState>({
        id: "wait",
        execute: async (_state, { signal }) => {
          entered();
          return new Promise<AtomisationState>((_resolve, reject) => {
            const abort = () => {
              cancelled = true;
              reject(signal.reason);
            };
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) {
              abort();
            }
          });
        },
      });
      const done = output<AtomisationState>({ id: "done", summary: () => "done" });
      const graph = pipeline({
        name: "cancellation",
        state: AtomisationState,
        start: wait,
        nodes: [wait, done],
        outputs: [done],
        routes: [route({ from: wait, to: done, label: "done" })],
      });
      const { app, cancel } = createAtomiserServer(
        { passage: graph, item: graph },
        {
          concurrency: 1,
          timeoutMs: shutdown ? 5000 : 300,
          queueLimit: 8,
        },
      );
      t.after(() => app.close());
      const running = app
        .inject({ method: "POST", url: "/atomise", payload: source })
        .then((response) => response);
      await started;
      assert.equal((await app.inject("/health")).json().active, 1);
      const queued = app.inject({ method: "POST", url: "/atomise", payload: source });
      assert.equal((await app.inject("/health")).json().active, 1);
      if (shutdown) {
        cancel();
      }
      assert.equal((await running).statusCode, shutdown ? 503 : 504);
      assert.equal((await queued).statusCode, shutdown ? 503 : 504);
      assert.equal(cancelled, true);
      assert.equal((await app.inject("/health")).json().active, 0);
    }
  },
);

test("HTTP waits for a free atomisation slot shared by passages and items", async (t) => {
  let entered = 0;
  let releaseFirst = () => {};
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted = () => {};
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const work = stage<AtomisationState>({
    id: "work",
    execute: async (state) => {
      entered++;
      if (entered === 1) {
        firstStarted();
        await firstGate;
      }
      return state;
    },
  });
  const done = output<AtomisationState>({ id: "done", summary: () => "done" });
  const graph = pipeline({
    name: "queue",
    state: AtomisationState,
    start: work,
    nodes: [work, done],
    outputs: [done],
    routes: [route({ from: work, to: done, label: "done" })],
  });
  const { app } = createAtomiserServer(
    { passage: graph, item: graph },
    { concurrency: 1, timeoutMs: 5000, queueLimit: 8 },
  );
  t.after(() => app.close());
  const first = app.inject({ method: "POST", url: "/atomise", payload: source });
  await started;
  const second = app.inject({ method: "POST", url: "/atomise-item", payload: source });
  let secondSettled = false;
  void second.then(() => {
    secondSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await app.inject("/health")).json().active, 1);
  assert.equal(entered, 1);
  assert.equal(secondSettled, false);
  releaseFirst();
  assert.equal((await first).statusCode, 502);
  assert.equal((await second).statusCode, 502);
  assert.equal(entered, 2);
  assert.equal((await app.inject("/health")).json().active, 0);
});

test("HTTP answers busy once the wait queue shared by passages and items is full", async (t) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = () => {};
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const work = stage<AtomisationState>({
    id: "work",
    execute: async (state) => {
      started();
      await gate;
      return state;
    },
  });
  const done = output<AtomisationState>({ id: "done", summary: () => "done" });
  const graph = pipeline({
    name: "full-queue",
    state: AtomisationState,
    start: work,
    nodes: [work, done],
    outputs: [done],
    routes: [route({ from: work, to: done, label: "done" })],
  });
  const { app } = createAtomiserServer(
    { passage: graph, item: graph },
    { concurrency: 1, timeoutMs: 5000, queueLimit: 1 },
  );
  t.after(() => {
    release();
    return app.close();
  });
  const first = app.inject({ method: "POST", url: "/atomise", payload: source });
  await running;
  const second = app.inject({ method: "POST", url: "/atomise-item", payload: source });
  for (let attempt = 0; (await app.inject("/health")).json().waiting !== 1; attempt++) {
    assert.ok(attempt < 100, "second request never queued");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  const third = await app.inject({ method: "POST", url: "/atomise", payload: source });
  assert.equal(third.statusCode, 503);
  assert.equal(third.json().code, "busy");
  release();
  await first;
  await second;
  assert.equal((await app.inject("/health")).json().waiting, 0);
});
