import assert from "node:assert/strict";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createExampleCorpus } from "../examples/corpus/api.js";
import { fetchExampleSources } from "../examples/corpus/client.js";
import { parseExampleCorpusEnv } from "../examples/corpus/config.js";
import { SourceSearchResponse } from "../examples/corpus/contract.js";
import { passages, type ExamplePassage } from "../examples/corpus/passages.js";
import { startExampleCorpus } from "../examples/corpus/start.js";

const serve = async (t: TestContext, catalogue: readonly ExamplePassage[]) => {
  const server = createExampleCorpus(catalogue);
  t.after(() => server.close());
  return server.listen({ port: 0, host: "127.0.0.1" });
};

test("the demo HTTP client consumes the entire editable catalogue, including appended passages", async (t) => {
  const appended = { id: "appended", title: "Added by a consumer", text: "An owl 🦉 flies." };
  const catalogue = [...passages, appended];
  const baseUrl = await serve(t, catalogue);
  const sources = await fetchExampleSources(baseUrl);
  assert.deepEqual(
    sources.map((source) => source.title),
    catalogue.map((passage) => passage.title),
  );
  assert.deepEqual(
    sources.map((source) => source.text),
    catalogue.map((passage) => passage.text),
  );
  assert.equal(sources.length, catalogue.length);
  assert.equal(new Set(sources.map((source) => source.id)).size, catalogue.length);
  const last = sources.at(-1);
  assert.equal(last?.passages[0]?.endOffset, [...appended.text].length);
  assert.equal(last?.passages[0]?.text, appended.text);
  const health = await fetch(`${baseUrl}/health`);
  assert.deepEqual(await health.json(), { service: "example-corpus", status: "ok" });
});

test("example search ignores query filtering and limits without duplicating the catalogue", async (t) => {
  const baseUrl = await serve(t, passages);
  const response = await fetch(`${baseUrl}/source-candidates/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ queries: ["fox", "not a match"], limit: 1 }),
  });
  assert.equal(response.status, 200);
  const search = SourceSearchResponse.parse(await response.json());
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0]?.candidates.length, passages.length);
});

test("example API rejects unknown identities and malformed requests", async (t) => {
  const baseUrl = await serve(t, passages);
  for (const [body, status] of [
    [JSON.stringify({ id: "missing", version: "1" }), 404],
    [JSON.stringify({ id: `urn:example:source:${passages[0]!.id}`, version: "wrong" }), 404],
    [JSON.stringify({ id: "missing" }), 400],
    ["not json", 400],
  ] as const) {
    const response = await fetch(`${baseUrl}/source-envelope`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(response.status, status);
    await response.arrayBuffer();
  }
});

test("example catalogue rejects blank or duplicate ids before starting", () => {
  const passage = { id: "one", title: "One", text: "One fact." };
  assert.throws(() => createExampleCorpus([passage, passage]), /unique/u);
  assert.throws(() => createExampleCorpus([{ ...passage, id: " " }]), /non-empty/u);
  assert.throws(() => createExampleCorpus([{ ...passage, text: "" }]));
});

test("example server and client share a validated loopback address", () => {
  assert.equal(parseExampleCorpusEnv({}).origin, "http://127.0.0.1:8098");
  assert.equal(parseExampleCorpusEnv({ CORPUS_BASE_URL: "http://localhost:8198" }).port, "8198");
  assert.throws(() => parseExampleCorpusEnv({ CORPUS_BASE_URL: "https://example.com" }));
  assert.throws(() => parseExampleCorpusEnv({ CORPUS_BASE_URL: "http://localhost:8198/nested" }));
});

test(
  "each watched example process owns its lifecycle without stopping another instance",
  { timeout: 20000 },
  async (t) => {
    const signal = AbortSignal.timeout(15000);
    const first = await startExampleCorpus(new URL("http://127.0.0.1:0"), signal);
    t.after(first.close);
    const second = await startExampleCorpus(new URL("http://127.0.0.1:0"), signal);
    t.after(second.close);
    assert.notEqual(first.origin, second.origin);
    assert.equal((await fetchExampleSources(first.origin, signal)).length, passages.length);
    await first.close();
    await assert.rejects(fetch(`${first.origin}/health`, { signal }));
    assert.equal((await fetchExampleSources(second.origin, signal)).length, passages.length);
    await assert.rejects(startExampleCorpus(new URL(second.origin), signal), /EADDRINUSE/u);
    assert.equal((await fetch(`${second.origin}/health`, { signal })).status, 200);
  },
);

test(
  "the native watcher reloads an edited catalogue in an isolated copy",
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "atomiser-watch-"));
    let close = async () => {};
    t.after(async () => {
      await close();
      await rm(directory, { recursive: true, force: true });
    });
    await cp(new URL("../examples/corpus/", import.meta.url), join(directory, "examples/corpus"), {
      recursive: true,
    });
    await cp(new URL("../src/contracts/", import.meta.url), join(directory, "src/contracts"), {
      recursive: true,
    });
    await symlink(
      fileURLToPath(new URL("../node_modules", import.meta.url)),
      join(directory, "node_modules"),
    );
    await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    const reserve = createExampleCorpus();
    const origin = await reserve.listen({ port: 0, host: "127.0.0.1" });
    await reserve.close();
    const { startExampleCorpus: start } = await import(
      pathToFileURL(join(directory, "examples/corpus/start.ts")).href
    );
    const signal = AbortSignal.timeout(15000);
    const running = await start(new URL(origin), signal);
    close = running.close;
    assert.equal((await fetchExampleSources(origin, signal)).length, passages.length);
    const added = { id: "watch-edit", title: "Edited catalogue", text: "An owl flies." };
    await writeFile(
      join(directory, "examples/corpus/passages.ts"),
      `export const passages = ${JSON.stringify([added])};\n`,
    );
    for (let attempt = 0; attempt < 50; attempt++) {
      await setTimeout(100);
      try {
        const sources = await fetchExampleSources(origin, signal);
        if (sources.length === 1 && sources[0]?.title === added.title) {
          assert.equal(sources[0].text, added.text);
          return;
        }
      } catch {
        signal.throwIfAborted();
      }
    }
    assert.fail("Watched API did not reload the edited catalogue");
  },
);
