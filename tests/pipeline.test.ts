import {
  output,
  pipeline,
  route,
  run,
  inspectAccepted,
  inspectPipeline,
  type Stage,
  type Collection,
  type ChatClient,
} from "@maxanstey-meridian/tandem";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { formatDemoResult, saveDemoResult } from "../scripts/demo-report.js";
import { measureOpenRouterSpend } from "../scripts/openrouter-spend.js";
import type { IntegrityClassifier } from "../src/application/ports/integrity-classifier.js";
import { CandidateRejection } from "../src/contracts/atomise.js";
import { SourceEnvelope } from "../src/contracts/source.js";
import type { IntegrityDecision } from "../src/domain/integrity.js";
import {
  createClaimExtractorAtomisationPipeline,
  type ClaimExtractorPipelineDependencies,
} from "../src/pipeline/claim-extractor-atomisation-pipeline.js";
import { candidateRejections } from "../src/pipeline/finalize.js";
import { AtomisationState, initialAtomisationState } from "../src/pipeline/state.js";
import { chatServer } from "./helpers/chat-server.js";

const source = SourceEnvelope.parse(
  JSON.parse(
    readFileSync(
      new URL("./fixtures/source-envelope-quick-brown-fox.json", import.meta.url),
      "utf8",
    ),
  ),
);
const decision = (overrides: Partial<IntegrityDecision> = {}): IntegrityDecision => ({
  supported: true,
  meaning_preserved: true,
  standalone: true,
  context_complete: true,
  atomic: true,
  probabilities: {
    supported: 1,
    meaning_preserved: 1,
    standalone: 1,
    atomic: 1,
    context_complete: 1,
  },
  mean: 1,
  reason: "",
  ...overrides,
});
const stable = {
  world: { layer: "real_world" },
  epistemic: { source_commitment: "asserted", modal_frame: "actual" },
  temporal: { instability: "stable" },
} as const;

const oneStage = (
  node: Stage<AtomisationState> | Collection<AtomisationState>,
  persist = false,
) => {
  const done = output<AtomisationState>({ id: "done", summary: () => "done" });
  return pipeline({
    name: "stage-test",
    persist,
    state: AtomisationState,
    start: node,
    nodes: [node, done],
    outputs: [done],
    routes: [route({ from: node, to: done, label: "done" })],
  });
};

const unusedClient: ChatClient = {
  kind: "openai-compatible",
  version: 1,
  endpoint: "http://127.0.0.1:1/v1",
  model: "unused",
  wireApi: "completions",
  verifyModel: false,
};
const nodeFromPipeline = (
  id: string,
  dependencies: Partial<ClaimExtractorPipelineDependencies> = {},
  ledgerPath?: string,
): Stage<AtomisationState> | Collection<AtomisationState> => {
  const graph = createClaimExtractorAtomisationPipeline(
    {
      extractClaims: async () => assert.fail("Unexpected extraction call"),
      apsClient: unusedClient,
      classifyIntegrity: async () => assert.fail("Unexpected integrity call"),
      classifyFraming: async () => assert.fail("Unexpected framing call"),
      tag: async () => assert.fail("Unexpected tagging call"),
      ...dependencies,
    },
    { ledgerPath },
  );
  const node = graph.nodes.find((node) => node.id === id);
  assert(node?.kind === "stage" || node?.kind === "collection");
  return node;
};
const resolveNode = (
  dependencies: Partial<ClaimExtractorPipelineDependencies>,
  ledgerPath?: string,
) => nodeFromPipeline("resolve-claims", dependencies, ledgerPath);

const assessed = (
  items: readonly { readonly claim: string; readonly integrity: IntegrityDecision }[],
) =>
  items.map(({ claim, integrity }, discoveryIndex) => ({
    discoveryIndex,
    proposition: claim,
    claim,
    integrity,
  }));

const gate = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test(
  "one native graph isolates concurrent sources and persists each source run",
  { timeout: 60000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "atomiser-ledger-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const ledgerPath = join(directory, "runs.sqlite3");
    const server = await chatServer(t, (request) => {
      const claim = request.messages.at(-1)!.content;
      const title = claim.split(":")[0];
      return `PROPOSITIONS:\n- ${title}: Fact 6.\n- ${title}: Fact 7.`;
    });
    const graph = createClaimExtractorAtomisationPipeline(
      {
        extractClaims: async (extractSource) => [
          ...Array.from({ length: 6 }, (_, index) => `${extractSource.title}: Fact ${index}.`),
          `${extractSource.title}: Fact 6 and Fact 7.`,
        ],
        tag: async (title, claims) => claims.map((claim) => [title, claim]),
        apsClient: server.client("aps-test"),
        classifyIntegrity: async (_source, candidates) =>
          candidates.map((candidate) =>
            decision(
              candidate.claim.includes(" and ") ? { atomic: false, reason: "compound" } : {},
            ),
          ),
        classifyFraming: async (_source, claims) => claims.map(() => stable),
      },
      { ledgerPath },
    );
    assert.equal("atomize" in graph, false);
    const results = await Promise.all(
      ["Alpha", "Beta"].map(async (title) => {
        const result = await run(graph, initialAtomisationState({ ...source, title }), {
          signal: AbortSignal.timeout(45000),
          ledgerPath,
        });
        assert.equal(result.succeeded, true, result.summary ?? "failed");
        assert.equal(result.state.output?.atoms.length, 8);
        assert.deepEqual(
          result.state.output?.atoms.map((atom) => atom.tags),
          Array.from({ length: 8 }, (_, index) => [title, `${title}: Fact ${index}.`]),
        );
        assert.deepEqual(
          result.state.output?.atoms.map((atom) => atom.claim),
          Array.from({ length: 8 }, (_, index) => `${title}: Fact ${index}.`),
        );
        assert.deepEqual(
          result.state.output?.atoms.map((atom) => atom.recovery),
          [...Array.from({ length: 6 }, () => undefined), "split", "split"],
        );
        assert.equal("childRunIds" in result.state, false);
        assert.equal("internalCalls" in result.state, false);
        return result;
      }),
    );
    assert.notDeepEqual(results[0]!.state.output?.atoms, results[1]!.state.output?.atoms);
    const spend = measureOpenRouterSpend(
      { status: "available", observedAt: "2026-09-22T00:00:00.000Z", usageUsd: 1 },
      { status: "available", observedAt: "2026-09-22T00:01:00.000Z", usageUsd: 1.001 },
    );
    const saved = await Promise.all(
      results.map((result) => saveDemoResult(result.state, directory, spend)),
    );
    assert.notEqual(saved[0]!.atomsPath, saved[1]!.atomsPath);
    for (const [index, files] of saved.entries()) {
      const state = results[index]!.state;
      assert.deepEqual(JSON.parse(readFileSync(files.atomsPath, "utf8")), state.output?.atoms);
      const report = JSON.parse(readFileSync(files.reportPath, "utf8"));
      assert.deepEqual(report.source, state.source);
      assert.deepEqual(report.outcomes, state.outcomes);
      assert.deepEqual(report.openRouterSpend, spend);
      assert.equal(report.outcomes.length, 7);
      assert.deepEqual(report.candidates, state.working.items);
      assert.match(formatDemoResult(state), /OUTPUT · 8 atoms/u);
      for (const width of [40, 100]) {
        const plain = formatDemoResult(state, width);
        const colored = formatDemoResult(state, width, true);
        assert.notEqual(colored, plain);
        assert.equal(stripVTControlCharacters(colored), plain);
        assert.equal(stripVTControlCharacters(plain), plain);
      }
      assert.ok(
        formatDemoResult(state, 1000).includes(
          `tags: ${JSON.stringify(state.output!.atoms[0]!.tags)}`,
        ),
      );
    }
    assert.equal(server.requests.length, 2);
    const database = new DatabaseSync(ledgerPath, { readOnly: true });
    const recordedRuns = database.prepare("SELECT run_id FROM runs").all();
    database.close();
    assert.equal(recordedRuns.length, 2);
    for (const record of recordedRuns) {
      const accepted = await inspectAccepted({ ledgerPath, runId: String(record.run_id) });
      assert.equal(accepted.filter((value) => value.kind === "StructuredOutputAccepted").length, 1);
    }
  },
);

test("dedupe reports the original extraction index after earlier duplicates were removed", async () => {
  const input = {
    ...initialAtomisationState(source),
    working: {
      phase: "canonicalised",
      items: ["First.", "First.", "Second.", "Second."].map((claim, discoveryIndex) => ({
        proposition: claim,
        claim,
        discoveryIndex,
      })),
    },
  };
  const result = await run(oneStage(nodeFromPipeline("dedupe")), input);
  assert.deepEqual(
    result.state.working.items.map((candidate) => candidate.discoveryIndex),
    [0, 2],
  );
  assert.deepEqual(
    candidateRejections(result.state.outcomes, result.state.source).map(
      (rejection) => rejection.reason,
    ),
    ["duplicate of candidate 0", "duplicate of candidate 2"],
  );
  assert.deepEqual(
    result.state.outcomes.map((entry) => entry.outcome),
    ["duplicate", "duplicate"],
  );
  assert.match(formatDemoResult(result.state), /Jev: not scored/u);
  for (const rejection of candidateRejections(result.state.outcomes, result.state.source)) {
    assert.equal(rejection.stage, "deduplication");
    assert.equal("scores" in rejection, false);
    CandidateRejection.parse(rejection);
  }
});

test("dedupe preserves signs, decimal points, case and punctuation while removing exact copies", async () => {
  const claims = [
    "It was -5°C.",
    "It was +5°C.",
    "US won.",
    "us won.",
    "It was 0.2.",
    "It was 02.",
    "US won.",
  ];
  const result = await run(oneStage(nodeFromPipeline("dedupe")), {
    ...initialAtomisationState(source),
    working: {
      phase: "canonicalised",
      items: claims.map((claim, discoveryIndex) => ({
        proposition: claim,
        claim,
        discoveryIndex,
      })),
    },
  });
  assert.deepEqual(
    result.state.working.items.map((candidate) => candidate.proposition),
    claims.slice(0, -1),
  );
  assert.equal(
    candidateRejections(result.state.outcomes, result.state.source)[0]?.candidateIndex,
    6,
  );
});

test("extraction receives the bounded source and APS receives the failing claim verbatim", async (t) => {
  const text = "Mr. Burns paid $3 million.\nSenna won by 0.2 seconds. 🦉";
  const context = { sectionPath: ["1992", "Race"], leadIn: "The driver was Ayrton Senna." };
  const compound = "Ayrton Senna won by 0.2 seconds and Mr. Burns paid $3 million.";
  const server = await chatServer(t, (request) => {
    assert.equal(request.reasoning_effort, "none");
    assert.deepEqual(request.messages, [{ role: "user", content: compound }]);
    assert.equal(request.response_format, undefined);
    assert.equal(request.reasoning, undefined);
    return "PROPOSITIONS:\n- Ayrton Senna won by 0.2 seconds.\n- Mr. Burns paid $3 million.";
  });
  const bounded = { ...source, text, context };
  const graph = createClaimExtractorAtomisationPipeline({
    extractClaims: async (extractSource) => {
      assert.deepEqual(extractSource, bounded);
      return [compound];
    },
    apsClient: server.client("aps"),
    classifyIntegrity: async (integritySource, candidates) => {
      assert.deepEqual(integritySource.context, context);
      return candidates.map((candidate) =>
        decision(candidate.claim === compound ? { atomic: false, reason: "compound" } : {}),
      );
    },
    classifyFraming: async (framingSource, claims) => {
      assert.deepEqual(framingSource.context, context);
      assert.deepEqual(claims, ["Ayrton Senna won by 0.2 seconds.", "Mr. Burns paid $3 million."]);
      return claims.map(() => stable);
    },
    tag: async (_title, claims) => claims.map(() => []),
  });
  const result = await run(graph, initialAtomisationState(bounded));
  assert.equal(result.succeeded, true, result.summary ?? "failed");
  assert.equal(server.requests.length, 1);
});

test("resolution accepts passing claims and rejects unsplittable failures without APS", async () => {
  const result = await run(oneStage(resolveNode({})), {
    ...initialAtomisationState(source),
    working: {
      phase: "assessed",
      items: assessed([
        { claim: "Accept.", integrity: decision() },
        { claim: "Unsupported.", integrity: decision({ supported: false, reason: "unsupported" }) },
        {
          claim: "The dog is lazy.",
          integrity: decision({
            meaning_preserved: false,
            standalone: false,
            atomic: false,
            reason: "meaning_changed",
          }),
        },
      ]),
    },
  });
  assert.equal(result.succeeded, true, result.summary ?? "failed");
  assert.deepEqual(
    result.state.working.items.map((candidate) => candidate.proposition),
    ["Accept."],
  );
  assert.deepEqual(
    candidateRejections(result.state.outcomes, result.state.source).map(
      (rejection) => rejection.reason,
    ),
    ["unsupported", "meaning_changed"],
  );
});

test(
  "resolution splits atomicity failures, rechecks every child and assigns unique child indices",
  { timeout: 60000 },
  async (t) => {
    const server = await chatServer(t, (request) =>
      request.messages.at(-1)!.content === "Compound A."
        ? "PROPOSITIONS:\n- Child good.\n- Child unsupported.\n- Child compound."
        : "PROPOSITIONS:\n- Child later.",
    );
    const checks: string[] = [];
    const classify: IntegrityClassifier = async (_source, candidates) =>
      candidates.map((candidate) => {
        checks.push(candidate.claim);
        assert.equal(candidate.parentProposition, "Compound A.");
        if (candidate.claim === "Child unsupported.") {
          return decision({ supported: false, reason: "unsupported child" });
        }
        if (candidate.claim === "Child compound.") {
          return decision({ atomic: false, reason: "compound child" });
        }
        return decision();
      });
    const result = await run(
      oneStage(resolveNode({ classifyIntegrity: classify, apsClient: server.client("aps") })),
      {
        ...initialAtomisationState(source),
        working: {
          phase: "assessed",
          items: assessed([
            { claim: "Accepted.", integrity: decision() },
            { claim: "Unsupported.", integrity: decision({ supported: false, reason: "no" }) },
            { claim: "Compound A.", integrity: decision({ atomic: false, reason: "compound" }) },
            { claim: "Compound B.", integrity: decision({ atomic: false, reason: "compound" }) },
          ]),
        },
        outcomes: [
          {
            outcome: "duplicate",
            candidate: { discoveryIndex: 9, proposition: "Earlier duplicate." },
            reason: "duplicate",
          },
        ],
      },
      { signal: AbortSignal.timeout(45000) },
    );
    assert.equal(result.succeeded, true, result.summary ?? "failed");
    assert.ok(result.state.working.phase === "accepted");
    assert.deepEqual(
      result.state.working.items.map((candidate) => [candidate.claim, candidate.discoveryIndex]),
      [
        ["Accepted.", 0],
        ["Child good.", 10],
      ],
    );
    assert.equal(result.state.working.items[1]?.recovery, "split");
    assert.deepEqual(checks, ["Child good.", "Child unsupported.", "Child compound."]);
    assert.deepEqual(
      candidateRejections(result.state.outcomes, result.state.source).map((rejection) => [
        rejection.proposition,
        rejection.reason,
      ]),
      [
        ["Earlier duplicate.", "duplicate"],
        ["Unsupported.", "no"],
        ["Child unsupported.", "unsupported child"],
        ["Child compound.", "compound child"],
        ["Compound B.", "compound; APS did not split the claim"],
      ],
    );
    assert.equal(server.requests.length, 2);
    const indices = [
      ...result.state.working.items.map((candidate) => candidate.discoveryIndex),
      ...candidateRejections(result.state.outcomes, result.state.source).map(
        (rejection) => rejection.candidateIndex,
      ),
    ];
    assert.equal(new Set(indices).size, indices.length);
    const parent = result.state.outcomes.find((entry) => entry.candidate.discoveryIndex === 2);
    assert.equal(parent?.outcome, "split");
    assert.deepEqual(
      parent.children.map((entry) => entry.outcome),
      ["accepted", "rejected", "rejected"],
    );
    const rendered = formatDemoResult(result.state);
    assert.match(rendered, /\[3\] SPLIT/u);
    assert.match(rendered, /├─ \[3\.1\] ACCEPTED/u);
    assert.match(rendered, /├─ \[3\.2\] REJECTED/u);
    assert.match(rendered, /└─ \[3\.3\] REJECTED/u);
  },
);

test("APS failures and malformed split output fail resolution", async (t) => {
  for (const response of ["unavailable", "Sorry, I cannot split that."]) {
    const server = await chatServer(t, () => {
      if (response === "unavailable") {
        throw new Error("provider unavailable");
      }
      return response;
    });
    await assert.rejects(
      run(
        oneStage(
          resolveNode({
            classifyIntegrity: async () =>
              assert.fail("Failed splits must not reach classification"),
            apsClient: server.client("aps"),
          }),
        ),
        {
          ...initialAtomisationState(source),
          working: {
            phase: "assessed",
            items: assessed([
              { claim: "A compound fact.", integrity: decision({ atomic: false }) },
            ]),
          },
        },
        { signal: AbortSignal.timeout(15000) },
      ),
    );
  }
});

test("framing evaluates the emitted claim with the bounded source text", async () => {
  const result = await run(
    oneStage(
      nodeFromPipeline("framing", {
        classifyFraming: async (framingSource, claims) => {
          assert.deepEqual(framingSource, source);
          assert.deepEqual(claims, ["The fox jumps over the dog."]);
          return [
            {
              world: { layer: "undetermined" },
              epistemic: { source_commitment: "asserted", modal_frame: "other" },
              temporal: { instability: "stable" },
            },
          ];
        },
      }),
    ),
    {
      ...initialAtomisationState(source),
      working: {
        phase: "accepted",
        items: [
          {
            discoveryIndex: 0,
            proposition: "It jumps over the dog.",
            claim: "The fox jumps over the dog.",
            integrity: decision(),
          },
        ],
      },
    },
  );
  assert.equal(result.succeeded, true, result.summary ?? "failed");
  assert.ok(result.state.working.phase === "framed");
  assert.equal(result.state.working.items[0]?.framing.world.layer, "undetermined");
  assert.equal(result.state.working.items[0]?.framing.epistemic.modal_frame, "other");
});

test("framing rejects a mismatched classifier result count", async () => {
  await assert.rejects(
    run(oneStage(nodeFromPipeline("framing", { classifyFraming: async () => [] })), {
      ...initialAtomisationState(source),
      working: {
        phase: "accepted",
        items: [
          {
            discoveryIndex: 0,
            proposition: "The fox jumps.",
            claim: "The fox jumps.",
            integrity: decision(),
          },
        ],
      },
    }),
    /incorrect number of results/u,
  );
});

test("downstream stages reject missing or blank canonical claims before model calls", async (t) => {
  const server = await chatServer(t, () =>
    assert.fail("Invalid candidates must not reach a model"),
  );
  const classify: IntegrityClassifier = async () =>
    assert.fail("Invalid candidates must not be classified");
  const stages = [
    nodeFromPipeline("integrity", { classifyIntegrity: classify }),
    resolveNode({ classifyIntegrity: classify, apsClient: server.client("aps") }),
    nodeFromPipeline("framing", {
      classifyFraming: async () => assert.fail("Invalid candidates must not be framed"),
    }),
    nodeFromPipeline("tagging", {
      tag: async () => assert.fail("Invalid candidates must not be tagged"),
    }),
    nodeFromPipeline("finalize"),
  ];
  for (const node of stages) {
    for (const claim of [undefined, "   "]) {
      await assert.rejects(
        run(oneStage(node), {
          ...initialAtomisationState(source),
          working: {
            phase: "assessed",
            items: [
              {
                discoveryIndex: 0,
                proposition: "A fact.",
                ...(claim === undefined ? {} : { claim }),
                integrity: decision(),
              },
            ],
          },
        }),
        /\.claim:|canonical claim/u,
      );
    }
  }
  assert.equal(server.requests.length, 0);
});

test(
  "resolution bounds whole candidate sequences at six and refills a freed slot",
  { timeout: 10000 },
  async (t) => {
    const controller = new AbortController();
    t.after(() => controller.abort());
    const started = Array.from({ length: 9 }, gate);
    const finish = new Map<number, () => void>();
    let active = 0;
    let peak = 0;
    let entered = 0;
    const server = await chatServer(t, (request) => {
      const claim = request.messages.at(-1)!.content;
      return `PROPOSITIONS:\n- ${claim} a.\n- ${claim} b.`;
    });
    const classify: IntegrityClassifier = async (_source, candidates, signal) => {
      const [index, part] = candidates[0]!.claim.split(" ");
      if (part === "b.") {
        return [decision()];
      }
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        finish.set(Number(index), () => {
          signal.removeEventListener("abort", abort);
          finish.delete(Number(index));
          active -= 1;
          resolve();
        });
        started[++entered]!.resolve();
      });
      return [decision({ mean: 1 - Number(index) / 100 })];
    };
    const graph = oneStage(
      resolveNode({ classifyIntegrity: classify, apsClient: server.client("aps") }),
    );
    const running = run(
      graph,
      {
        ...initialAtomisationState(source),
        working: {
          phase: "assessed",
          items: Array.from({ length: 8 }, (_, discoveryIndex) => ({
            discoveryIndex,
            proposition: String(discoveryIndex),
            claim: String(discoveryIndex),
            integrity: decision({ atomic: false }),
          })),
        },
      },
      { signal: controller.signal },
    );
    await started[6]!.promise;
    assert.equal(entered, 6);
    assert.equal(peak, 6);
    assert.equal(finish.size, 6);
    const initial = [...finish.keys()];
    const blocked = initial[0]!;
    finish.get(initial[1]!)!();
    await started[7]!.promise;
    assert.ok(finish.has(blocked));
    const next = [...finish.keys()].find((index) => !initial.includes(index));
    assert.notEqual(next, undefined);
    finish.get(next!)!();
    await started[8]!.promise;
    for (const complete of [...finish.values()].reverse()) {
      complete();
    }
    const result = await running;
    assert.equal(result.succeeded, true, result.summary ?? "failed");
    assert.equal(peak, 6);
    assert.equal(active, 0);
    assert.ok(result.state.working.phase === "accepted");
    assert.deepEqual(
      result.state.working.items.map((candidate) => candidate.claim),
      Array.from({ length: 8 }, (_, index) => [`${index} a.`, `${index} b.`]).flat(),
    );
    assert.deepEqual(
      result.state.working.items.map((item) => item.integrity.mean),
      Array.from({ length: 8 }, (_, index) => [1 - index / 100, 1]).flat(),
    );
    assert.deepEqual(
      result.state.outcomes.map((item) => item.candidate.discoveryIndex),
      [0, 1, 2, 3, 4, 5, 6, 7],
    );
  },
);

test(
  "out-of-order splits merge identities and prior history deterministically",
  { timeout: 10000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "atomiser-split-ledger-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const ledgerPath = join(directory, "runs.sqlite3");
    const releaseFirst = gate();
    const laterChecked = gate();
    t.after(() => releaseFirst.resolve());
    const server = await chatServer(t, async (request) => {
      const message = request.messages.find((item) => item.role === "user")!.content;
      if (message === "Parent A") {
        await releaseFirst.promise;
      }
      const letter = message.endsWith("A") ? "A" : "B";
      return `PROPOSITIONS:\n- Child ${letter} good.\n- Child ${letter} compound.`;
    });
    const checks: string[] = [];
    const classify: IntegrityClassifier = async (_source, candidates) =>
      candidates.map((candidate) => {
        checks.push(candidate.proposition);
        if (candidate.proposition === "Child B compound.") {
          laterChecked.resolve();
        }
        return decision({ atomic: !candidate.proposition.endsWith("compound.") });
      });
    const graph = oneStage(
      resolveNode({ classifyIntegrity: classify, apsClient: server.client("aps") }, ledgerPath),
      true,
    );
    const input: AtomisationState = {
      ...initialAtomisationState(source),
      working: {
        phase: "assessed",
        items: [
          {
            discoveryIndex: 0,
            proposition: "Parent A",
            claim: "Parent A",
            integrity: decision({ atomic: false }),
          },
          {
            discoveryIndex: 2,
            proposition: "Parent B",
            claim: "Parent B",
            integrity: decision({ atomic: false }),
          },
        ],
      },
      outcomes: [
        {
          outcome: "duplicate",
          candidate: { discoveryIndex: 9, proposition: "Earlier duplicate" },
          reason: "duplicate",
        },
      ],
    };
    const running = run(graph, input, { ledgerPath });
    await laterChecked.promise;
    assert.deepEqual(checks, ["Child B good.", "Child B compound."]);
    releaseFirst.resolve();
    const result = await running;
    assert.equal(result.succeeded, true, result.summary ?? "failed");
    assert.deepEqual(
      result.state.working.items.map((candidate) => candidate.discoveryIndex),
      [10, 12],
    );
    assert.deepEqual(
      candidateRejections(result.state.outcomes, result.state.source).map(
        (rejection) => rejection.candidateIndex,
      ),
      [9, 11, 13],
    );
    assert.deepEqual(
      result.state.outcomes.flatMap((entry) => [
        [entry.candidate.discoveryIndex, null],
        ...(entry.outcome === "split"
          ? entry.children.map((child) => [
              child.candidate.discoveryIndex,
              entry.candidate.discoveryIndex,
            ])
          : []),
      ]),
      [
        [9, null],
        [0, null],
        [10, 0],
        [11, 0],
        [2, null],
        [12, 2],
        [13, 2],
      ],
    );
    assert.deepEqual(result.state.outcomes[0], input.outcomes[0]);
    assert.equal(server.requests.length, 2);
    const single = await run(
      graph,
      {
        ...input,
        working: { phase: "assessed", items: input.working.items.slice(0, 1) },
      },
      { ledgerPath },
    );
    assert.deepEqual(
      single.state.working.items.map((candidate) => candidate.discoveryIndex),
      [10],
    );
    assert.deepEqual(
      candidateRejections(single.state.outcomes, single.state.source).map(
        (rejection) => rejection.candidateIndex,
      ),
      [9, 11],
    );
    assert.deepEqual(single.state.outcomes[0], input.outcomes[0]);
    const before = server.requests.length;
    const empty = { ...initialAtomisationState(source), working: { phase: "assessed", items: [] } };
    assert.deepEqual((await run(graph, empty, { ledgerPath })).state, {
      ...empty,
      working: { phase: "accepted", items: [] },
    });
    assert.equal(server.requests.length, before);
    const database = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      const batches = database
        .prepare("SELECT run_id FROM runs WHERE composition = 'stage-test'")
        .all();
      assert.equal(batches.length, 3);
      for (const batch of batches) {
        assert.ok((await inspectAccepted({ ledgerPath, runId: String(batch.run_id) })).length > 0);
      }
    } finally {
      database.close();
    }
  },
);

test(
  "parallel resolution propagates cancellation and operational failure",
  { timeout: 10000 },
  async (t) => {
    const server = await chatServer(t, (request) => {
      const claim = request.messages.at(-1)!.content;
      return `PROPOSITIONS:\n- ${claim} a.\n- ${claim} b.`;
    });
    for (const cancel of [true, false]) {
      const controller = new AbortController();
      t.after(() => controller.abort());
      const started = gate();
      const release = gate();
      const signals: AbortSignal[] = [];
      let entered = 0;
      const classify: IntegrityClassifier = async (_source, candidates, signal) => {
        signals.push(signal);
        if (++entered === 6) {
          started.resolve();
        }
        if (cancel) {
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        } else {
          await release.promise;
          if (candidates[0]!.claim === "0 a.") {
            throw new Error("Split classifier unavailable");
          }
        }
        return [decision()];
      };
      const graph = oneStage(
        resolveNode({ classifyIntegrity: classify, apsClient: server.client("aps") }),
      );
      const running = run(
        graph,
        {
          ...initialAtomisationState(source),
          working: {
            phase: "assessed",
            items: Array.from({ length: 8 }, (_, discoveryIndex) => ({
              discoveryIndex,
              proposition: String(discoveryIndex),
              claim: String(discoveryIndex),
              integrity: decision({ atomic: false }),
            })),
          },
        },
        { signal: controller.signal },
      );
      const rejected = assert.rejects(
        running,
        cancel ? /cancel|abort/iu : /Split classifier unavailable/u,
      );
      await started.promise;
      if (cancel) {
        controller.abort();
        await rejected;
        assert.equal(entered, 6);
        assert.ok(signals.every((signal) => signal.aborted));
      } else {
        release.resolve();
        await rejected;
      }
    }
  },
);

test("working phases reject incomplete records and stages reject the wrong phase", async () => {
  const candidate = {
    discoveryIndex: 0,
    proposition: "A fact.",
    claim: "A fact.",
    integrity: decision(),
  };
  assert.equal(
    AtomisationState.safeParse({
      ...initialAtomisationState(source),
      working: {
        phase: "accepted",
        items: [{ ...candidate, integrity: decision({ atomic: false }) }],
      },
    }).success,
    false,
  );
  assert.equal(
    AtomisationState.safeParse({
      ...initialAtomisationState(source),
      working: {
        phase: "assessed",
        items: [{ ...candidate, integrity: { ...decision(), probabilities: { supported: 1 } } }],
      },
    }).success,
    false,
  );
  assert.equal(
    AtomisationState.safeParse({
      ...initialAtomisationState(source),
      working: { phase: "tagged", items: [candidate] },
    }).success,
    false,
  );
  await assert.rejects(
    run(
      oneStage(
        nodeFromPipeline("integrity", {
          classifyIntegrity: async () => assert.fail("Wrong phase must not reach classification"),
        }),
      ),
      initialAtomisationState(source),
    ),
    /requires canonicalised candidates/u,
  );
  await assert.rejects(
    run(
      oneStage(
        nodeFromPipeline("framing", {
          classifyFraming: async () => assert.fail("Wrong phase must not reach framing"),
        }),
      ),
      {
        ...initialAtomisationState(source),
        working: { phase: "assessed", items: [candidate] },
      },
    ),
    /requires accepted candidates/u,
  );
});

test("integrity refuses missing and extra classifier decisions", async () => {
  for (const decisions of [[], [decision(), decision()]]) {
    await assert.rejects(
      run(oneStage(nodeFromPipeline("integrity", { classifyIntegrity: async () => decisions })), {
        ...initialAtomisationState(source),
        working: {
          phase: "canonicalised",
          items: [{ discoveryIndex: 0, proposition: "A fact.", claim: "A fact." }],
        },
      }),
      /incorrect number of decisions/u,
    );
  }
});

test("finalisation keeps each survivor's scores, framing and tags when candidates are reordered", async () => {
  const first = {
    discoveryIndex: 0,
    proposition: "First.",
    claim: "First claim.",
    integrity: decision({ mean: 0.8 }),
    recovery: "split" as const,
    framing: {
      world: { layer: "real_world" as const },
      epistemic: { source_commitment: "asserted" as const, modal_frame: "actual" as const },
      temporal: { instability: "mutable" as const },
    },
    tags: ["First"],
  };
  const second = {
    ...first,
    discoveryIndex: 2,
    proposition: "Second.",
    claim: "Second claim.",
    integrity: decision({ mean: 0.9 }),
    tags: ["Second"],
  };
  const result = await run(oneStage(nodeFromPipeline("finalize")), {
    ...initialAtomisationState(source),
    working: { phase: "tagged", items: [second, first] },
    outcomes: [
      {
        outcome: "duplicate",
        candidate: { discoveryIndex: 1, proposition: "First." },
        reason: "duplicate of candidate 0",
      },
    ],
  });
  assert.deepEqual(result.state.output, {
    status: "completed",
    atoms: [second, first].map((candidate) => ({
      proposition: candidate.proposition,
      claim: candidate.claim,
      tags: candidate.tags,
      evidence: {
        sourceId: source.id,
        sourceVersion: source.version,
        title: source.title,
        kind: source.kind,
        passages: source.passages,
      },
      framing: candidate.framing,
      scores: { probabilities: candidate.integrity.probabilities, mean: candidate.integrity.mean },
      recovery: "split",
    })),
    candidateRejections: [
      {
        candidateIndex: 1,
        stage: "deduplication",
        proposition: "First.",
        reason: "duplicate of candidate 0",
        support: source.passages,
      },
    ],
  });
});

test("the source pipeline exposes seven processing nodes and one terminal", () => {
  const graph = createClaimExtractorAtomisationPipeline({
    extractClaims: async () => [],
    apsClient: unusedClient,
    classifyIntegrity: async () => [],
    classifyFraming: async () => assert.fail("No execution"),
    tag: async () => [],
  });
  const inspection = inspectPipeline(graph);
  assert.deepEqual(
    inspection.nodes.map((node) => [node.id, node.kind]),
    [
      ["claim-extract", "stage"],
      ["dedupe", "stage"],
      ["integrity", "stage"],
      ["resolve-claims", "collection"],
      ["framing", "stage"],
      ["tagging", "stage"],
      ["finalize", "stage"],
      ["done", "completion"],
    ],
  );
  assert.deepEqual(
    inspection.nodes.filter((node) => node.kind === "collection").map((node) => node.max),
    [6],
  );
  assert.deepEqual(inspection.outputs, ["done"]);
});
