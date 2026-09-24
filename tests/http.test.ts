import { pipeline, stage, route, output } from "@maxanstey-meridian/tandem";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseAtomiserEnv } from "../src/config.js";
import { ATOMIZATION_VERSION } from "../src/contracts/atomise.js";
import { SourceEnvelope } from "../src/contracts/source.js";
import { createAtomiserServer } from "../src/interface/http/server.js";
import { createLunaAtomisationPipeline } from "../src/pipeline/luna-atomisation-pipeline.js";
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
  let discovery = "PROPOSITIONS:\n- The fox jumps.";
  const server = await chatServer(t, (request) =>
    request.model === "aps" ? discovery : JSON.stringify({ claim: "The fox jumps." }),
  );
  const pipeline = createLunaAtomisationPipeline(
    {
      apsClient: server.client("aps"),
      llmClient: server.client("claim"),
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
    { recovery: false },
  );
  const { app } = createAtomiserServer(pipeline, { concurrency: 1, timeoutMs: 5000 });
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
    assert.equal(response.json().atomizationVersion, ATOMIZATION_VERSION);
  }
  discovery = "PROPOSITIONS:\n- The fox jumps.\n- The fox jumps.";
  const duplicates = await app.inject({ method: "POST", url: "/atomise", payload: source });
  assert.equal(duplicates.statusCode, 200, duplicates.body);
  assert.equal(duplicates.json().atomizationVersion, ATOMIZATION_VERSION);
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
  discovery = "PROPOSITIONS:\n";
  assert.equal(
    (await app.inject({ method: "POST", url: "/atomise", payload: source })).json().status,
    "no_propositions",
  );
  discovery = "Sorry, the model is unavailable.";
  const failed = await app.inject({ method: "POST", url: "/atomise", payload: source });
  assert.equal(failed.statusCode, 502, failed.body);
  assert.equal(failed.json().code, "atomisation_failed");
  assert.equal((await app.inject("/health")).json().active, 0);
});

test("configuration permits unauthenticated APS and explicitly configured LAN HTTP", () => {
  const config = parseAtomiserEnv({
    ATOMISER_PIPELINE: "luna",
    OPENROUTER_API_KEY: "test",
    APS_BASE_URL: "http://192.168.1.20:8092/v1",
  });
  assert.equal(config.apsApiKeyEnvironmentVariable, undefined);
  assert.equal(config.apsBaseUrl, "http://192.168.1.20:8092/v1");
  assert.equal("corpusBaseUrl" in config, false);
  const localLlm = parseAtomiserEnv({
    ATOMISER_PIPELINE: "luna",
    OPENROUTER_API_KEY: "jev-key",
    APS_API_KEY: "local-key",
    LLM_BASE_URL: "http://127.0.0.1:8888/v1",
    LLM_MODEL: "local-llm",
    LLM_API_KEY_ENVIRONMENT_VARIABLE: "APS_API_KEY",
    LLM_REQUEST_TIMEOUT_MILLISECONDS: "60000",
  });
  assert.equal(localLlm.llmBaseUrl, "http://127.0.0.1:8888/v1");
  assert.equal(localLlm.llmModel, "local-llm");
  assert.equal(localLlm.llmApiKeyEnvironmentVariable, "APS_API_KEY");
  assert.equal(localLlm.llmRequestTimeoutMilliseconds, 60000);
  assert.equal(localLlm.openRouterApiKey, "jev-key");
  assert.equal(
    parseAtomiserEnv({ OPENROUTER_API_KEY: "test", APS_API_KEY: "secret" })
      .apsApiKeyEnvironmentVariable,
    "APS_API_KEY",
  );
  assert.throws(() =>
    parseAtomiserEnv({ OPENROUTER_API_KEY: "test", APS_BASE_URL: "file:///tmp/model" }),
  );
});

test("ClaimExtractor configuration does not require a Luna or local endpoint key", () => {
  const config = parseAtomiserEnv({
    OPENROUTER_API_KEY: "jev-key",
  });
  assert.equal(config.pipeline, "claim-extractor");
  assert.equal(config.integrityGate, false);
  assert.equal(config.claimExtractorModel, "claim-extractor-4B-q-2605-oQ8-MTP");
  assert.equal(
    parseAtomiserEnv({ ATOMISER_PIPELINE: "luna", OPENROUTER_API_KEY: "jev-key" }).integrityGate,
    true,
  );
  assert.equal(
    parseAtomiserEnv({
      ATOMISER_PIPELINE: "luna",
      ATOMISER_INTEGRITY_GATE: "false",
      OPENROUTER_API_KEY: "jev-key",
    }).integrityGate,
    false,
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
      const { app, cancel } = createAtomiserServer(graph, {
        concurrency: 1,
        timeoutMs: shutdown ? 5000 : 300,
      });
      t.after(() => app.close());
      const running = app
        .inject({ method: "POST", url: "/atomise", payload: source })
        .then((response) => response);
      await started;
      assert.equal((await app.inject("/health")).json().active, 1);
      assert.equal(
        (await app.inject({ method: "POST", url: "/atomise", payload: source })).statusCode,
        503,
      );
      if (shutdown) {
        cancel();
      }
      assert.equal((await running).statusCode, shutdown ? 503 : 504);
      assert.equal(cancelled, true);
      assert.equal((await app.inject("/health")).json().active, 0);
    }
  },
);
