import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { createFastinoTagger } from "../src/infrastructure/fastino.js";

const endpoint = {
  baseUrl: "https://fastino.test/v1",
  model: "fastino/gliner2.5-base-v1",
  apiKey: "fastino-key",
  timeoutMilliseconds: 5000,
};

const TAG_TYPES = {
  individual: "A specifically named individual person or fictional character",
  organization:
    "A specifically named organization, institution, school, company, government body, agency, band, media outlet, or organized group",
  work: "A specifically named creative work, television series, film, book, play, programme, advertisement, game, or franchise",
  installment:
    "A specifically named episode, chapter, issue, installment, or individual entry within a larger creative work",
  place: "A specifically named real or fictional geographic place or location",
  named_event_or_program:
    "A specifically named event, movement, test, programme, competition, campaign, initiative, rally, or organized activity",
  named_object:
    "A specifically named individual physical or fictional object, artifact, vehicle, toy, weapon, or item",
  topic:
    "A specific topic, cultural phenomenon, historical period, genre, theme, trend, or subject useful for identifying what the article or claim is about, such as 1990s nostalgia, Britpop, or 1990s music",
};

const completion = (content: unknown) =>
  Response.json({
    choices: [{ message: { role: "assistant", content: JSON.stringify(content) } }],
  });

test("tagger sends each claim with its title and keeps confident, case-insensitively unique tags", async () => {
  const requests: { url: string; key: string | null; body: unknown }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body: unknown = await request.json();
    requests.push({ url: request.url, key: request.headers.get("X-API-Key"), body });
    const claim = z.object({ messages: z.tuple([z.object({ content: z.string() })]) }).parse(body)
      .messages[0].content;
    if (claim.endsWith("second")) {
      return completion({ entities: { topic: [{ text: "Same", confidence: 0.9 }] } });
    }
    return completion({
      entities: {
        work: [
          { text: "Frankenstein", confidence: 0.95, start: 0, end: 12 },
          { text: "Prometheus", confidence: 0.91 },
          { text: "Frankenstein; or, The Modern Prometheus", confidence: 0.86 },
        ],
        topic: [{ text: "FRANKENSTEIN; OR, THE MODERN PROMETHEUS", confidence: 0.99 }],
        individual: [{ text: "Mary Shelley", confidence: 0.79 }],
        place: [
          { text: "Bath", confidence: 0.8 },
          { text: "BATH", confidence: 0.95 },
        ],
      },
    });
  };
  const tag = createFastinoTagger(endpoint, transport);

  assert.deepEqual(await tag("Title", ["first", "second"], AbortSignal.timeout(5000)), [
    ["Frankenstein", "Prometheus", "Frankenstein; or, The Modern Prometheus", "Bath"],
    ["Same"],
  ]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, "https://fastino.test/v1/chat/completions");
  assert.equal(requests[0]?.key, "fastino-key");
  assert.deepEqual(requests[0]?.body, {
    model: "fastino/gliner2.5-base-v1",
    messages: [{ role: "user", content: "[Article: Title]\nClaim: first" }],
    schema: { entities: TAG_TYPES },
    threshold: 0.5,
    include_confidence: true,
    include_spans: false,
  });
  assert.deepEqual(await tag("Title", [], AbortSignal.timeout(5000)), []);
  assert.equal(requests.length, 2);
});

test("tagger fails on HTTP errors and malformed responses instead of returning empty tags", async () => {
  for (const [title, response] of [
    ["http", new Response("bad request", { status: 400 })],
    ["not json content", Response.json({ choices: [{ message: { content: "not json" } }] })],
    ["no choices", Response.json({ choices: [] })],
    ["bad confidence", completion({ entities: { topic: [{ text: "Bad", confidence: 2 }] } })],
  ] as const) {
    const tag = createFastinoTagger(endpoint, async () => response);
    await assert.rejects(tag(title, ["one"], AbortSignal.timeout(5000)), /Fastino/u, title);
  }
});

const hanging =
  (signals: AbortSignal[] = []): typeof fetch =>
  (input, init) => {
    const { signal } = new Request(input, init);
    signals.push(signal);
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };

test("cancellation reaches the request", async () => {
  const tag = createFastinoTagger(endpoint, hanging());
  await assert.rejects(tag("slow", ["one"], AbortSignal.timeout(50)), { name: "TimeoutError" });
});

test("a warming or rate-limited model is retried after its Retry-After delay", async () => {
  const statuses = [425, 429];
  let calls = 0;
  const tag = createFastinoTagger(endpoint, async () => {
    const status = statuses[calls++];
    return status === undefined
      ? completion({ entities: { topic: [{ text: "Warm", confidence: 0.9 }] } })
      : new Response("warming", { status, headers: { "Retry-After": "0" } });
  });
  assert.deepEqual(await tag("Title", ["one"], AbortSignal.timeout(5000)), [["Warm"]]);
  assert.equal(calls, 3);
});

test("a client error is not retried", async () => {
  let calls = 0;
  const tag = createFastinoTagger(endpoint, async () => {
    calls++;
    return new Response("bad request", { status: 400 });
  });
  await assert.rejects(
    tag("Title", ["one"], AbortSignal.timeout(5000)),
    /Fastino tagging failed \(400\): "bad request"/u,
  );
  assert.equal(calls, 1);
});

test("an endpoint timeout fails the run with Fastino context", async () => {
  const tag = createFastinoTagger({ ...endpoint, timeoutMilliseconds: 20 }, hanging());
  await assert.rejects(tag("slow", ["one"], AbortSignal.timeout(5000)), /Fastino tagging failed/u);
});

test("one failed claim cancels the claims still in flight", async () => {
  const signals: AbortSignal[] = [];
  const wait = hanging(signals);
  let resolve = () => {};
  const inFlight = new Promise<void>((settle) => {
    resolve = settle;
  });
  const tag = createFastinoTagger(endpoint, async (input, init) => {
    const request = new Request(input, init);
    if ((await request.clone().text()).includes("fails")) {
      await inFlight;
      return new Response("bad request", { status: 400 });
    }
    const response = wait(request);
    resolve();
    return await response;
  });
  await assert.rejects(tag("Title", ["hangs", "fails"], AbortSignal.timeout(5000)), /Fastino/u);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.aborted, true);
});
