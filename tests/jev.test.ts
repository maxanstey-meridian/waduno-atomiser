import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { z } from "zod";
import { SourceEnvelope } from "../src/contracts/source.js";
import { passesIntegrity } from "../src/domain/integrity.js";
import { createJevClassifiers } from "../src/infrastructure/jev.js";

test("the configured classifier batches and folds answers without retaining previous results", async () => {
  const source = SourceEnvelope.parse(
    JSON.parse(
      readFileSync(
        new URL("./fixtures/source-envelope-quick-brown-fox.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const batches: string[][] = [];
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(new URL(request.url).pathname, "/api/alpha/decisions");
    const body = z
      .object({ questions: z.record(z.string(), z.json()) })
      .parse(await request.json());
    const keys = Object.keys(body.questions);
    batches.push(keys);
    return Response.json({
      model: "typesafe/jev-1.13",
      answers: Object.fromEntries(
        keys.map((key) => [key, { type: "noul", noul: key === "a101" ? 0.1 : 0.9 }]),
      ),
      usage: { input_tokens: 10, output_tokens: 1 },
    });
  };
  const classifier = createJevClassifiers("test-key", transport).classifyIntegrity;
  const candidates = Array.from({ length: 205 }, (_, index) => ({
    proposition: `Fact ${index}.`,
    claim: `Fact ${index}.`,
  }));
  const result = await classifier(source, candidates, AbortSignal.timeout(5000));
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 5, 5, 5, 5, 5],
  );
  assert.equal(result.length, 205);
  assert.equal(result[100]?.atomic, true);
  assert.equal(result[101]?.atomic, false);
  assert.equal(result[204]?.atomic, true);
  assert.equal(batches.length, 15);
  const recheck = await classifier(source, [candidates[0]!], AbortSignal.timeout(5000));
  assert.equal(recheck.length, 1);
  const empty = await classifier(source, [], AbortSignal.timeout(5000));
  assert.deepEqual(empty, []);
  assert.equal(batches.length, 20);
});

test("integrity requests carry explicit targets and task-specific criteria, including split preservation", async () => {
  const source = SourceEnvelope.parse(
    JSON.parse(
      readFileSync(
        new URL("./fixtures/source-envelope-quick-brown-fox.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const Question = z.object({
    type: z.literal("noul"),
    instructions: z.object({
      instruction: z.string().optional(),
      question: z.string(),
      proposition: z.string().optional(),
      claim: z.string(),
      parent_proposition: z.string().optional(),
    }),
    criteria: z.object({ true: z.string(), false: z.string() }),
  });
  const requests: z.infer<typeof Question>[][] = [];
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = z
      .object({
        model: z.literal("typesafe/jev-1.13"),
        state: z.unknown(),
        questions: z.record(z.string(), Question),
      })
      .parse(await request.json());
    assert.equal(request.url, "https://openrouter.ai/api/alpha/decisions");
    if (requests.length === 3) {
      assert.deepEqual(body.state, {});
      for (const question of Object.values(body.questions)) {
        assert.deepEqual(Object.keys(question.instructions).sort(), [
          "claim",
          "instruction",
          "question",
        ]);
      }
    } else {
      assert.deepEqual(body.state, {
        source: { text: source.text, title: source.title, context: source.context },
      });
      if (requests.length === 0) {
        for (const question of Object.values(body.questions)) {
          assert.deepEqual(Object.keys(question.instructions).sort(), ["claim", "question"]);
        }
      }
    }
    requests.push(Object.values(body.questions));
    return Response.json({
      model: body.model,
      usage: { input_tokens: 10, output_tokens: 1 },
      answers: Object.fromEntries(
        Object.entries(body.questions).map(([key, question]) => [
          key,
          {
            type: "noul",
            noul: question.instructions.parent_proposition === undefined ? 0.9 : 0.1,
          },
        ]),
      ),
    });
  };
  const results = await createJevClassifiers("test-key", transport).classifyIntegrity(
    source,
    [
      { proposition: "It jumps.", claim: "The fox jumps." },
      {
        proposition: "The fox jumps.",
        claim: "The fox jumps.",
        parentProposition: "The fox jumps and the dog sleeps.",
      },
    ],
    AbortSignal.timeout(5000),
  );
  assert.equal(requests.length, 5);
  assert.equal(new Set(requests.map((questions) => questions[0]!.criteria.true)).size, 5);
  assert.equal(new Set(requests.map((questions) => questions[0]!.criteria.false)).size, 5);
  for (const [index, questions] of requests.entries()) {
    assert.equal(
      questions[0]!.instructions.proposition,
      index === 0 || index === 3 ? undefined : "It jumps.",
    );
    assert.equal(questions[0]!.instructions.claim, "The fox jumps.");
    if (index !== 0) {
      assert.ok(questions[0]!.instructions.instruction!.length > 0);
    }
  }
  const splitChecks = requests
    .flat()
    .filter((question) => question.instructions.parent_proposition !== undefined);
  assert.equal(splitChecks.length, 1);
  assert.equal(
    splitChecks[0]!.instructions.parent_proposition,
    "The fox jumps and the dog sleeps.",
  );
  assert.match(splitChecks[0]!.instructions.question, /asserted component/u);
  assert.equal(passesIntegrity(results[0]!), true);
  assert.equal(results[1]?.supported, true);
  assert.equal(results[1]?.meaning_preserved, false);
  assert.equal(passesIntegrity(results[1]!), false);
});

test("framing supports undetermined worlds and other modalities without guessing a work from the title", async () => {
  for (const layer of ["fictional_world", "undetermined"] as const) {
    const transport: typeof fetch = async (input, init) => {
      const body = z.object({ state: z.unknown() }).parse(await new Request(input, init).json());
      assert.deepEqual(body.state, {
        claim: "The fox would jump if the dog slept.",
        source: {
          text: "The fox would jump if the dog slept.",
          title: "An arbitrary heading",
          context: { sectionPath: [], leadIn: null },
        },
      });
      return Response.json({
        model: "typesafe/jev-1.13",
        usage: { input_tokens: 10, output_tokens: 1 },
        answers: {
          world_layer: { type: "choice", choice: layer },
          source_commitment: { type: "choice", choice: "asserted" },
          modal_frame: { type: "choice", choice: "other" },
          temporal_instability: { type: "choice", choice: "stable" },
        },
      });
    };
    const framing = await createJevClassifiers("test-key", transport).classifyFraming(
      {
        claim: "The fox would jump if the dog slept.",
        sourceTitle: "An arbitrary heading",
        sourceContext: { sectionPath: [], leadIn: null },
        sourceText: "The fox would jump if the dog slept.",
      },
      AbortSignal.timeout(5000),
    );
    assert.equal(framing.world.layer, layer);
    assert.equal(framing.world.fictional_work, null);
    assert.equal(framing.epistemic.modal_frame, "other");
  }
});

test("integrity rejects missing, mistyped and out-of-range provider answers without retrying", async () => {
  const text = "Mira opened the gate.";
  const source = SourceEnvelope.parse({
    id: "s",
    version: "1",
    title: "Gate",
    text,
    kind: "paragraph",
    context: { sectionPath: ["2024"], leadIn: "Mira was at North Depot." },
    passages: [{ passageId: "p", blockId: "b", startOffset: 0, endOffset: text.length, text }],
  });
  for (const answer of [
    undefined,
    { type: "noul", noul: 7 },
    { type: "noul", noul: -0.1 },
    { type: "noul", noul: "0.9" },
    { type: "noul", noul: null },
    { type: "choice", choice: "true" },
  ]) {
    let calls = 0;
    const transport: typeof fetch = async () => {
      calls++;
      return Response.json({
        model: "typesafe/jev-1.13",
        usage: { input_tokens: 1, output_tokens: 1 },
        answers: answer === undefined ? {} : { a0: answer },
      });
    };
    await assert.rejects(
      createJevClassifiers("test", transport).classifyIntegrity(
        source,
        [{ proposition: text, claim: text }],
        AbortSignal.timeout(5000),
      ),
    );
    assert.equal(calls, 1);
  }
});

test("integrity carries lead-in and section context while standalone remains isolated", async () => {
  const text = "She opened it.";
  const context = { sectionPath: ["2024"], leadIn: "Mira was at the North Depot gate." };
  const source = SourceEnvelope.parse({
    id: "s",
    version: "1",
    title: "Gate",
    text,
    kind: "paragraph",
    context,
    passages: [{ passageId: "p", blockId: "b", startOffset: 0, endOffset: text.length, text }],
  });
  let calls = 0;
  const transport: typeof fetch = async (input, init) => {
    const body = z
      .object({ state: z.unknown(), questions: z.record(z.string(), z.unknown()) })
      .parse(await new Request(input, init).json());
    assert.deepEqual(
      body.state,
      calls === 3 ? {} : { source: { title: source.title, text, context } },
    );
    calls++;
    return Response.json({
      model: "typesafe/jev-1.13",
      usage: { input_tokens: 1, output_tokens: 1 },
      answers: Object.fromEntries(
        Object.keys(body.questions).map((key) => [key, { type: "noul", noul: 1 }]),
      ),
    });
  };
  const [result] = await createJevClassifiers("test", transport).classifyIntegrity(
    source,
    [{ proposition: text, claim: "Mira opened the North Depot gate in 2024." }],
    AbortSignal.timeout(5000),
  );
  assert.equal(passesIntegrity(result!), true);
  assert.equal(calls, 5);
});

test("the classifier accepts only bounded source context and applies the domain threshold", async () => {
  for (const probability of [0.599999, 0.6]) {
    const transport: typeof fetch = async (input, init) => {
      const { questions } = z
        .object({ questions: z.record(z.string(), z.unknown()) })
        .parse(await new Request(input, init).json());
      return Response.json({
        model: "typesafe/jev-1.13",
        usage: { input_tokens: 1, output_tokens: 1 },
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [key, { type: "noul", noul: probability }]),
        ),
      });
    };
    const [decision] = await createJevClassifiers("test", transport).classifyIntegrity(
      { title: "Gate", text: "Mira opened the gate.", context: { sectionPath: [], leadIn: null } },
      [{ proposition: "Mira opened the gate.", claim: "Mira opened the gate." }],
      AbortSignal.timeout(5000),
    );
    assert.equal(passesIntegrity(decision!), probability === 0.6);
  }
});
