import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createGlinerTagger } from "../src/infrastructure/gliner.js";

const create = () =>
  createGlinerTagger(
    "python3",
    fileURLToPath(new URL("./fixtures/tagger-worker.py", import.meta.url)),
    "unused",
  );

test("tagger reuses one process and serializes concurrent requests without mixing outputs", async () => {
  const tagger = create();
  try {
    const [first, second] = await Promise.all([
      tagger.tag("first title", ["one", "two"], AbortSignal.timeout(5000)),
      tagger.tag("second title", ["three"], AbortSignal.timeout(5000)),
    ]);
    assert.deepEqual(
      first.map((entities) => entities.slice(0, 2)),
      [
        [
          { text: "first title", type: "topic", confidence: 0.9 },
          { text: "one", type: "individual", confidence: 0.8 },
        ],
        [
          { text: "first title", type: "topic", confidence: 0.9 },
          { text: "two", type: "individual", confidence: 0.8 },
        ],
      ],
    );
    assert.deepEqual(second[0]?.slice(0, 2), [
      { text: "second title", type: "topic", confidence: 0.9 },
      { text: "three", type: "individual", confidence: 0.8 },
    ]);
    assert.equal(first[0]?.[2]?.text, second[0]?.[2]?.text);
    assert.equal(first[0]?.[3]?.text, "1");
    assert.equal(second[0]?.[3]?.text, "2");
  } finally {
    tagger.close();
  }
  await assert.rejects(tagger.tag("closed", ["one"], AbortSignal.timeout(5000)), /closed/u);
});

test("tagger rejects malformed responses, wrong counts and process crashes then recovers", async () => {
  const tagger = create();
  try {
    for (const title of ["malformed", "wrong count", "bad entity", "crash"]) {
      await assert.rejects(tagger.tag(title, ["one"], AbortSignal.timeout(5000)), /GLiNER/u);
      const [entities] = await tagger.tag("healthy", ["one"], AbortSignal.timeout(5000));
      assert.deepEqual(entities?.slice(0, 2), [
        { text: "healthy", type: "topic", confidence: 0.9 },
        { text: "one", type: "individual", confidence: 0.8 },
      ]);
    }
  } finally {
    tagger.close();
  }
});

test("cancellation kills active inference without corrupting the next request", async () => {
  const tagger = create();
  try {
    await assert.rejects(tagger.tag("slow", ["one"], AbortSignal.timeout(100)));
    const [entities] = await tagger.tag("healthy", ["two"], AbortSignal.timeout(5000));
    assert.deepEqual(entities?.slice(0, 2), [
      { text: "healthy", type: "topic", confidence: 0.9 },
      { text: "two", type: "individual", confidence: 0.8 },
    ]);
  } finally {
    tagger.close();
  }
});
