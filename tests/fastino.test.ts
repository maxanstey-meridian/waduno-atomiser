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
  assert.deepEqual(
    z
      .object({
        model: z.string(),
        messages: z.array(z.object({ role: z.string(), content: z.string() })),
        schema: z.object({ entities: z.array(z.object({ name: z.string() })) }),
        threshold: z.number(),
      })
      .parse(requests[0]?.body),
    {
      model: "fastino/gliner2.5-base-v1",
      messages: [{ role: "user", content: "[Article: Title]\nClaim: first" }],
      schema: {
        entities: [
          "individual",
          "organization",
          "work",
          "installment",
          "place",
          "named_event_or_program",
          "named_object",
          "topic",
        ].map((name) => ({ name })),
      },
      threshold: 0.5,
    },
  );
  assert.deepEqual(await tag("Title", [], AbortSignal.timeout(5000)), []);
  assert.equal(requests.length, 2);
});

test("tagger fails on HTTP errors and malformed responses instead of returning empty tags", async () => {
  for (const [title, response] of [
    ["http", new Response("rate limited", { status: 429 })],
    ["not json content", Response.json({ choices: [{ message: { content: "not json" } }] })],
    ["no choices", Response.json({ choices: [] })],
    ["bad confidence", completion({ entities: { topic: [{ text: "Bad", confidence: 2 }] } })],
  ] as const) {
    const tag = createFastinoTagger(endpoint, async () => response);
    await assert.rejects(tag(title, ["one"], AbortSignal.timeout(5000)), /Fastino/u, title);
  }
});

test("cancellation reaches the request", async () => {
  const transport: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  const tag = createFastinoTagger(endpoint, transport);
  await assert.rejects(tag("slow", ["one"], AbortSignal.timeout(50)), { name: "TimeoutError" });
});
