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
      first.map((tags) => tags.slice(0, 2)),
      [
        ["first title", "one"],
        ["first title", "two"],
      ],
    );
    assert.deepEqual(second[0]?.slice(0, 2), ["second title", "three"]);
    assert.equal(first[0]?.[2], second[0]?.[2]);
    assert.equal(first[0]?.[3], "1");
    assert.equal(second[0]?.[3], "2");
  } finally {
    tagger.close();
  }
  await assert.rejects(tagger.tag("closed", ["one"], AbortSignal.timeout(5000)), /closed/u);
});

test("tagger rejects malformed responses, wrong counts and process crashes then recovers", async () => {
  const tagger = create();
  try {
    for (const title of ["malformed", "wrong count", "crash"]) {
      await assert.rejects(tagger.tag(title, ["one"], AbortSignal.timeout(5000)), /GLiNER/u);
      const [tags] = await tagger.tag("healthy", ["one"], AbortSignal.timeout(5000));
      assert.deepEqual(tags?.slice(0, 2), ["healthy", "one"]);
    }
  } finally {
    tagger.close();
  }
});

test("cancellation kills active inference without corrupting the next request", async () => {
  const tagger = create();
  try {
    await assert.rejects(tagger.tag("slow", ["one"], AbortSignal.timeout(100)));
    const [tags] = await tagger.tag("healthy", ["two"], AbortSignal.timeout(5000));
    assert.deepEqual(tags?.slice(0, 2), ["healthy", "two"]);
  } finally {
    tagger.close();
  }
});
