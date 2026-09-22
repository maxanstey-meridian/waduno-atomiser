import {
  output,
  pipeline,
  route,
  run,
  stage,
  inspectAccepted,
  type Stage,
} from "@maxanstey-meridian/tandem";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { formatDemoResult, saveDemoResult } from "../scripts/demo-report.js";
import { measureOpenRouterSpend } from "../scripts/openrouter-spend.js";
import type { IntegrityClassifier } from "../src/application/ports/integrity-classifier.js";
import { CandidateRejection } from "../src/contracts/atomise.js";
import { SourceEnvelope } from "../src/contracts/source.js";
import type { IntegrityDecision } from "../src/domain/integrity.js";
import { createAtomisationPipeline } from "../src/pipeline/atomise-source.js";
import { createCanonicalisationBatchPipeline } from "../src/pipeline/canonicalisation/batch.js";
import {
  createCanonicalisationPipeline,
  CanonicalisationState,
} from "../src/pipeline/canonicalisation/claim.js";
import { createCanonicalisationStage } from "../src/pipeline/canonicalisation/stage.js";
import { createDeduplicationStage } from "../src/pipeline/deduplicate.js";
import { candidateRejections, createFinalisationStage } from "../src/pipeline/finalize.js";
import { createFramingStage } from "../src/pipeline/framing.js";
import { createIntegrityStage } from "../src/pipeline/integrity.js";
import { createRepairPipeline } from "../src/pipeline/recovery/repair.js";
import { createSplitPipeline } from "../src/pipeline/recovery/split.js";
import { createRecoveryStage, createResolutionStage } from "../src/pipeline/recovery/stage.js";
import { AtomisationState, initialAtomisationState } from "../src/pipeline/state.js";
import { createTaggingStage } from "../src/pipeline/tagging.js";
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

const oneStage = (node: Stage<AtomisationState>) => {
  const done = output<AtomisationState>({ id: "done", summary: () => "done" });
  return pipeline({
    name: "stage-test",
    state: AtomisationState,
    start: node,
    nodes: [node, done],
    outputs: [done],
    routes: [route({ from: node, to: done, label: "done" })],
  });
};

const gate = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test(
  "one native graph isolates concurrent sources and persists parent and child runs in the ledger",
  { timeout: 60000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "atomiser-ledger-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const ledgerPath = join(directory, "runs.sqlite3");
    const server = await chatServer(t, (request) => {
      if (request.model === "aps-test") {
        return `PROPOSITIONS:\n${Array.from({ length: 8 }, (_, index) => `- Fact ${index}.`).join("\n")}`;
      }
      const message = request.messages.find((message) =>
        message.content.includes("PROPOSITION\n"),
      )!.content;
      const title = message.includes("Alpha") ? "Alpha" : "Beta";
      const fact = message.match(/Fact \d+\./u)![0];
      return JSON.stringify({ claim: `${title}: ${fact}` });
    });
    const graph = createAtomisationPipeline(
      {
        tag: async (title, claims) =>
          claims.map((claim) => [title.toLowerCase(), claim.toLowerCase()]),
        apsClient: server.client("aps-test"),
        llmClient: server.client("claim-test"),
        classifyIntegrity: async (_source, candidates) => candidates.map(() => decision()),
        classifyFraming: async () => ({
          world: { layer: "real_world", fictional_work: null },
          epistemic: { source_commitment: "asserted", modal_frame: "actual" },
          temporal: { instability: "stable" },
        }),
      },
      { recovery: false, ledgerPath },
    );
    assert.equal("atomize" in graph, false);
    assert.equal(graph.nodes.find((node) => node.id === "aps-discovery")?.kind, "agent");
    const results = await Promise.all(
      ["Alpha", "Beta"].map(async (title) => {
        const input = {
          ...initialAtomisationState({
            ...source,
            title,
          }),
        };
        const result = await run(graph, input, {
          signal: AbortSignal.timeout(45000),
          ledgerPath,
        });
        assert.equal(result.succeeded, true, result.summary ?? "failed");
        assert.equal(result.state.output?.atoms.length, 8);
        assert.deepEqual(
          result.state.output?.atoms.map((atom) => atom.tags),
          Array.from({ length: 8 }, (_, index) => [
            title.toLowerCase(),
            `${title.toLowerCase()}: fact ${index}.`,
          ]),
        );
        assert.deepEqual(
          result.state.output?.atoms.map((atom) => atom.claim),
          Array.from({ length: 8 }, (_, index) => `${title}: Fact ${index}.`),
        );
        assert.equal("childRunIds" in result.state, false);
        assert.equal("internalCalls" in result.state, false);
        assert.ok((await inspectAccepted({ ledgerPath, runId: result.runId })).length > 0);
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
      assert.equal(report.outcomes.length, 8);
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
        formatDemoResult(state).includes(`tags: ${JSON.stringify(state.output!.atoms[0]!.tags)}`),
      );
    }
    assert.equal(server.requests.length, 18);
    const database = new DatabaseSync(ledgerPath, { readOnly: true });
    const recordedRuns = database.prepare("SELECT run_id FROM runs").all();
    database.close();
    assert.equal(recordedRuns.length, 20);
    for (const record of recordedRuns) {
      const runId = String(record.run_id);
      assert.ok((await inspectAccepted({ ledgerPath, runId })).length > 0);
    }
  },
);

test("dedupe reports the original discovery index after earlier duplicates were removed", async () => {
  const input = {
    ...initialAtomisationState(source),
    working: {
      phase: "discovered",
      items: ["First.", "First.", "Second.", "Second."].map((proposition, discoveryIndex) => ({
        proposition,
        discoveryIndex,
      })),
    },
  };
  const result = await run(oneStage(createDeduplicationStage()), input);
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

test(
  "native max starts the next candidate when any slot frees, without waiting for a striped worker",
  { timeout: 10000 },
  async (t) => {
    const controller = new AbortController();
    t.after(() => controller.abort());
    const started = Array.from({ length: 9 }, () => {
      let resolve = () => {};
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    });
    const finish = new Map<number, () => void>();
    let active = 0;
    let peak = 0;
    let entered = 0;
    const claim = stage<CanonicalisationState>({
      id: "controlled-claim",
      execute: (state, { signal }) =>
        new Promise<CanonicalisationState>((resolve, reject) => {
          const index = Number(state.proposition);
          active += 1;
          peak = Math.max(peak, active);
          finish.set(index, () => {
            finish.delete(index);
            active -= 1;
            resolve({ ...state, claim: `claim ${index}` });
          });
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          entered += 1;
          started[entered]!.resolve();
        }),
    });
    const done = output<CanonicalisationState>({ id: "done", summary: () => "done" });
    const child = pipeline({
      name: "controlled",
      state: CanonicalisationState,
      start: claim,
      nodes: [claim, done],
      outputs: [done],
      routes: [route({ from: claim, to: done, label: "done" })],
    });
    const batch = createCanonicalisationBatchPipeline(child, 8);
    const running = run(
      batch,
      {
        source,
        candidates: Array.from({ length: 8 }, (_, discoveryIndex) => ({
          discoveryIndex,
          proposition: String(discoveryIndex),
        })),
        canonicalised: [],
      },
      { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) },
    );
    void running.catch(() => {});
    await started[6]!.promise;
    assert.equal(active, 6);
    const [held, released] = [...finish.keys()];
    finish.get(released!)!();
    await started[7]!.promise;
    assert.ok(finish.has(held!), "a slow candidate must still be pending");
    assert.equal(active, 6);
    for (const complete of finish.values()) {
      complete();
    }
    await started[8]!.promise;
    for (const complete of finish.values()) {
      complete();
    }
    const result = await running;
    assert.equal(result.succeeded, true);
    assert.equal(peak, 6);
    assert.deepEqual(
      result.state.canonicalised.map((candidate) => candidate.claim),
      Array.from({ length: 8 }, (_, index) => `claim ${index}`),
    );
  },
);

test("canonicalisation fails rather than substituting the proposition when its child graph fails", async () => {
  const unchanged = stage<CanonicalisationState>({ id: "unchanged", execute: (state) => state });
  const failed = output<CanonicalisationState>({
    id: "failed",
    failed: true,
    summary: () => "no claim",
  });
  const child = pipeline({
    name: "failed-claim",
    state: CanonicalisationState,
    start: unchanged,
    nodes: [unchanged, failed],
    outputs: [failed],
    routes: [route({ from: unchanged, to: failed, label: "failed" })],
  });
  const graph = oneStage(createCanonicalisationStage(child));
  await assert.rejects(
    run(graph, {
      ...initialAtomisationState(source),
      working: {
        phase: "discovered",
        items: [{ discoveryIndex: 0, proposition: "Keep this fact." }],
      },
    }),
  );
});

test("the parent's runtime signal cancels an active child run", { timeout: 10000 }, async () => {
  let notifyStarted = () => {};
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  let childSignal: AbortSignal | undefined;
  const waiting = stage<CanonicalisationState>({
    id: "wait",
    execute: async (_state, { signal }) => {
      childSignal = signal;
      notifyStarted();
      return new Promise<CanonicalisationState>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  const childDone = output<CanonicalisationState>({ id: "done", summary: () => "done" });
  const child = pipeline({
    name: "waiting-claim",
    state: CanonicalisationState,
    start: waiting,
    nodes: [waiting, childDone],
    outputs: [childDone],
    routes: [route({ from: waiting, to: childDone, label: "done" })],
  });
  const graph = oneStage(createCanonicalisationStage(child));
  const controller = new AbortController();
  const running = run(
    graph,
    {
      ...initialAtomisationState(source),
      working: { phase: "discovered", items: [{ discoveryIndex: 0, proposition: "Wait." }] },
    },
    { signal: controller.signal },
  );
  const rejected = assert.rejects(running);
  await started;
  controller.abort();
  await rejected;
  assert.equal(childSignal?.aborted, true);
});

test("no-recovery filters candidates and decisions together without adding child runs", async () => {
  const input = {
    ...initialAtomisationState(source),
    working: {
      phase: "assessed",
      items: [
        { proposition: "Accept.", integrity: decision() },
        { proposition: "Reject.", integrity: decision({ atomic: false, reason: "compound" }) },
      ].map(({ proposition, integrity }, discoveryIndex) => ({
        proposition,
        claim: proposition,
        discoveryIndex,
        integrity,
      })),
    },
  };
  const result = await run(oneStage(createResolutionStage()), input);
  assert.deepEqual(
    result.state.working.items.map((candidate) => candidate.proposition),
    ["Accept."],
  );
  assert.equal(result.state.working.items.length, 1);
  assert.equal(
    candidateRejections(result.state.outcomes, result.state.source)[0]?.reason,
    "compound",
  );
});

test(
  "recovery rechecks repairs, bounds splitting and assigns unique child indices",
  { timeout: 60000 },
  async (t) => {
    const server = await chatServer(t, (request) => {
      const message = request.messages.map((message) => message.content).join("\n");
      if (request.model === "split-test") {
        return message.includes("Compound A")
          ? "PROPOSITIONS:\n- Child good.\n- Child unresolved.\n- Child compound."
          : "PROPOSITIONS:\n- Child later.";
      }
      if (request.model === "repair-test") {
        return JSON.stringify({
          claim: message.includes("Repair fails") ? "Still invalid." : "Repaired fact.",
        });
      }
      return JSON.stringify({ claim: "Canonical child." });
    });
    const checks: string[] = [];
    const classify: IntegrityClassifier = async (_source, candidates) =>
      candidates.map((candidate) => {
        checks.push(candidate.proposition);
        if (candidate.proposition === "Child unresolved." && candidate.claim !== "Repaired fact.") {
          assert.equal(candidate.parentProposition, "Compound A.");
          return decision({ standalone: false });
        }
        if (candidate.claim === "Repaired fact.") {
          assert.equal(candidate.proposition, "Child unresolved.");
          assert.equal(candidate.parentProposition, "Compound A.");
        }
        if (candidate.proposition === "Child compound.") {
          return decision({ atomic: false });
        }
        if (candidate.claim === "Still invalid.") {
          return decision({ meaning_preserved: false });
        }
        return decision();
      });
    const graph = oneStage(
      createRecoveryStage({
        classifyIntegrity: classify,
        repairPipeline: createRepairPipeline(server.client("repair-test")),
        splitPipeline: createSplitPipeline(server.client("split-test")),
        claimPipeline: createCanonicalisationPipeline(server.client("claim-test")),
      }),
    );
    const input = {
      ...initialAtomisationState(source),
      working: {
        phase: "assessed",
        items: [
          { proposition: "Accepted.", integrity: decision() },
          { proposition: "Unsupported.", integrity: decision({ supported: false }) },
          {
            proposition: "Repair fails.",
            integrity: decision({ standalone: false, atomic: false }),
          },
          { proposition: "Compound A.", integrity: decision({ atomic: false }) },
          { proposition: "Compound B.", integrity: decision({ atomic: false }) },
        ].map(({ proposition, integrity }, discoveryIndex) => ({
          proposition,
          claim: proposition,
          discoveryIndex,
          integrity,
        })),
      },
      outcomes: [
        {
          outcome: "duplicate",
          candidate: { discoveryIndex: 9, proposition: "Earlier duplicate." },
          reason: "duplicate",
        },
      ],
    };
    const result = await run(graph, input, { signal: AbortSignal.timeout(45000) });
    assert.equal(result.succeeded, true, result.summary ?? "failed");
    assert.deepEqual(
      result.state.working.items.map((candidate) => candidate.proposition),
      ["Accepted.", "Child good.", "Child unresolved.", "Child later."],
    );
    assert.deepEqual(
      result.state.working.items.map((candidate) => candidate.discoveryIndex),
      [0, 10, 11, 13],
    );
    assert.equal(result.state.working.items.length, 4);
    assert.ok(result.state.working.phase === "accepted");
    assert.equal(result.state.working.items[2]?.claim, "Repaired fact.");
    assert.deepEqual(
      candidateRejections(result.state.outcomes, result.state.source).map(
        (rejection) => rejection.proposition,
      ),
      ["Earlier duplicate.", "Unsupported.", "Repair fails.", "Child compound."],
    );
    assert.equal(checks.includes("Unsupported."), false);
    assert.equal(server.requests.filter((request) => request.model === "split-test").length, 2);
    assert.equal(server.requests.length, 8);
    const indices = [
      ...result.state.working.items.map((candidate) => candidate.discoveryIndex),
      ...candidateRejections(result.state.outcomes, result.state.source).map(
        (rejection) => rejection.candidateIndex,
      ),
    ];
    assert.equal(new Set(indices).size, indices.length);
    const parent = result.state.outcomes.find((entry) => entry.candidate.discoveryIndex === 3);
    assert.equal(parent?.outcome, "split");
    assert.equal(parent.candidate.integrity.atomic, false);
    const children = parent.children;
    assert.deepEqual(
      children.map((entry) => entry.candidate.proposition),
      ["Child good.", "Child unresolved.", "Child compound."],
    );
    assert.deepEqual(
      children.map((entry) => entry.outcome),
      ["accepted", "accepted", "rejected"],
    );
    assert.equal(children[1]?.candidate.integrity.standalone, false);
    assert.equal(children[1]?.repair?.claim, "Repaired fact.");
    assert.ok(children[1]?.repair?.outcome === "accepted");
    assert.equal(children[1].repair.integrity.standalone, true);
    const failedRepair = result.state.outcomes.find(
      (entry) => entry.candidate.discoveryIndex === 2,
    );
    assert.ok(failedRepair?.outcome === "rejected");
    assert.equal(failedRepair.repair?.claim, "Still invalid.");
    assert.ok(failedRepair.repair?.outcome === "rejected");
    assert.equal(failedRepair.repair.integrity.meaning_preserved, false);
    const rendered = formatDemoResult(result.state);
    assert.match(rendered, /\[4\] SPLIT/u);
    assert.match(rendered, /├─ \[4\.1\] ACCEPTED/u);
    assert.match(rendered, /├─ \[4\.2\] REPAIR → ACCEPTED/u);
    assert.match(rendered, /└─ \[4\.3\] REJECTED/u);
  },
);

test(
  "unchanged repairs cannot obtain a second favourable integrity verdict",
  { timeout: 30000 },
  async (t) => {
    const original = "It jumps over the dog.";
    const checkedClaim = "The fox jumps over it.";
    const server = await chatServer(t, (request) => {
      const message = request.messages.find((message) => message.role === "user")!;
      const input = z
        .object({
          proposition: z.string(),
          claim: z.string(),
          source: z.object({ title: z.string(), text: z.string() }),
        })
        .parse(JSON.parse(message.content));
      assert.equal(input.proposition, original);
      assert.equal(input.claim, checkedClaim);
      assert.equal(input.source.text, source.text);
      return JSON.stringify({ claim: `  ${checkedClaim}  ` });
    });
    const classify: IntegrityClassifier = async () => {
      assert.fail("An unchanged repair must not be reclassified");
    };
    const graph = oneStage(
      createRecoveryStage({
        classifyIntegrity: classify,
        repairPipeline: createRepairPipeline(server.client("repair-test")),
        splitPipeline: createSplitPipeline(server.client("split-test")),
        claimPipeline: createCanonicalisationPipeline(server.client("claim-test")),
      }),
    );
    const result = await run(
      graph,
      {
        ...initialAtomisationState(source),
        working: {
          phase: "assessed",
          items: [
            {
              discoveryIndex: 0,
              proposition: original,
              claim: checkedClaim,
              integrity: decision({ standalone: false, reason: "unresolved" }),
            },
          ],
        },
      },
      { signal: AbortSignal.timeout(20000) },
    );
    assert.equal(result.succeeded, true, result.summary ?? "failed");
    assert.equal(server.requests.length, 1);
    assert.equal(result.state.working.items.length, 0);
    const outcome = result.state.outcomes[0];
    assert.ok(outcome?.outcome === "rejected");
    assert.equal(outcome.repair?.claim, checkedClaim);
    assert.equal(outcome.repair?.outcome, "unchanged");
    assert.match(
      candidateRejections(result.state.outcomes, result.state.source)[0]!.reason,
      /repair unchanged/u,
    );
  },
);

test("context-only failures trigger repair and must pass context revalidation", async (t) => {
  const original = "Ayrton Senna won by 0.2 seconds.";
  const repaired = "Ayrton Senna won the 1992 Monaco Grand Prix by 0.2 seconds.";
  const boundedSource = {
    ...source,
    title: "1992 Monaco Grand Prix",
    text: repaired,
    passages: [
      {
        passageId: "race",
        blockId: "race",
        startOffset: 0,
        endOffset: repaired.length,
        text: repaired,
      },
    ],
  };
  const server = await chatServer(t, () => JSON.stringify({ claim: repaired }));
  for (const complete of [true, false]) {
    const classify: IntegrityClassifier = async (_source, candidates) => {
      assert.equal(candidates[0]?.proposition, original);
      assert.equal(candidates[0]?.claim, repaired);
      return [decision({ context_complete: complete })];
    };
    const graph = oneStage(
      createRecoveryStage({
        classifyIntegrity: classify,
        repairPipeline: createRepairPipeline(server.client("repair-test")),
        splitPipeline: createSplitPipeline(server.client("split-test")),
        claimPipeline: createCanonicalisationPipeline(server.client("claim-test")),
      }),
    );
    const result = await run(
      graph,
      {
        ...initialAtomisationState(boundedSource),
        working: {
          phase: "assessed",
          items: [
            {
              discoveryIndex: 0,
              proposition: original,
              claim: original,
              integrity: decision({ context_complete: false, reason: "context_incomplete" }),
            },
          ],
        },
      },
      { signal: AbortSignal.timeout(20000) },
    );
    assert.equal(result.succeeded, true, result.summary ?? "failed");
    assert.equal(result.state.working.items.length, complete ? 1 : 0);
    const outcome = result.state.outcomes[0];
    assert.ok(outcome?.outcome === "accepted" || outcome?.outcome === "rejected");
    assert.ok(outcome.repair?.outcome === "accepted" || outcome.repair?.outcome === "rejected");
    assert.equal(outcome.repair.integrity.context_complete, complete);
    assert.equal(
      candidateRejections(result.state.outcomes, result.state.source).length,
      complete ? 0 : 1,
    );
  }
  assert.equal(server.requests.length, 2);
});

test("a source-supported change of meaning is rejected without repair or split", async (t) => {
  const server = await chatServer(t, () =>
    assert.fail("A changed meaning must not reach recovery models"),
  );
  const graph = oneStage(
    createRecoveryStage({
      classifyIntegrity: async () => assert.fail("A changed meaning must not be reclassified"),
      repairPipeline: createRepairPipeline(server.client("repair-test")),
      splitPipeline: createSplitPipeline(server.client("split-test")),
      claimPipeline: createCanonicalisationPipeline(server.client("claim-test")),
    }),
  );
  const failed = decision({
    meaning_preserved: false,
    standalone: false,
    atomic: false,
    reason: "meaning_changed",
  });
  const result = await run(graph, {
    ...initialAtomisationState(source),
    working: {
      phase: "assessed",
      items: [
        {
          discoveryIndex: 0,
          proposition: "The fox jumps.",
          claim: "The dog is lazy.",
          integrity: failed,
        },
      ],
    },
  });
  assert.equal(result.state.working.items.length, 0);
  assert.equal(
    candidateRejections(result.state.outcomes, result.state.source)[0]?.reason,
    "integrity: meaning_changed",
  );
  assert.equal(server.requests.length, 0);
});

test("framing evaluates the emitted claim with the bounded source text", async () => {
  const result = await run(
    oneStage(
      createFramingStage(async (subject) => {
        assert.deepEqual(subject, {
          claim: "The fox jumps over the dog.",
          sourceTitle: source.title,
          sourceText: source.text,
          sourceContext: source.context,
        });
        return {
          world: { layer: "undetermined", fictional_work: null },
          epistemic: { source_commitment: "asserted", modal_frame: "other" },
          temporal: { instability: "stable" },
        };
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

test("APS receives untouched text and canonicalisation and repair receive bounded context", async (t) => {
  const text = "Mr. Burns paid $3 million.\nSenna won by 0.2 seconds. 🦉";
  const context = { sectionPath: ["1992", "Race"], leadIn: "The driver was Ayrton Senna." };
  const server = await chatServer(t, (request) => {
    assert.equal(request.reasoning_effort, "none");
    if (request.model === "aps") {
      assert.deepEqual(request.messages, [{ role: "user", content: text }]);
      assert.equal(request.response_format, undefined);
      assert.equal(request.reasoning, undefined);
      return "PROPOSITIONS:\n- Senna won by 0.2 seconds.";
    }
    const input = request.messages.find((message) => message.role === "user")!.content;
    if (request.model === "claim") {
      const supplied = JSON.parse(input.split("SOURCE CONTEXT\n")[1]!.split("\n\nPROPOSITION")[0]!);
      assert.deepEqual(supplied.context, context);
      assert.equal(supplied.block_text, text);
    } else {
      assert.deepEqual(JSON.parse(input).source.context, context);
    }
    return JSON.stringify({ claim: "Ayrton Senna won by 0.2 seconds." });
  });
  const bounded = { ...source, text, context };
  const graph = createAtomisationPipeline(
    {
      apsClient: server.client("aps"),
      llmClient: server.client("claim"),
      classifyIntegrity: async () => [decision()],
      classifyFraming: async (subject) => {
        assert.deepEqual(subject.sourceContext, context);
        return {
          world: { layer: "real_world", fictional_work: null },
          epistemic: { source_commitment: "asserted", modal_frame: "actual" },
          temporal: { instability: "stable" },
        };
      },
      tag: async () => [[]],
    },
    { recovery: false },
  );
  const result = await run(graph, initialAtomisationState(bounded));
  assert.equal(result.succeeded, true, result.summary ?? "failed");
  const repaired = await run(createRepairPipeline(server.client("repair")), {
    sourceTitle: bounded.title,
    blockText: text,
    context,
    proposition: "He won.",
    claim: "He won.",
    repaired: null,
  });
  assert.equal(repaired.succeeded, true);
  const split = await run(createSplitPipeline(server.client("aps")), {
    proposition: text,
    propositions: [],
  });
  assert.equal(split.succeeded, true);
});

test("dedupe preserves signs, decimal points, case and punctuation while removing exact copies", async () => {
  const propositions = [
    "It was -5°C.",
    "It was +5°C.",
    "US won.",
    "us won.",
    "It was 0.2.",
    "It was 02.",
    "US won.",
  ];
  const result = await run(oneStage(createDeduplicationStage()), {
    ...initialAtomisationState(source),
    working: {
      phase: "discovered",
      items: propositions.map((proposition, discoveryIndex) => ({
        proposition,
        discoveryIndex,
      })),
    },
  });
  assert.deepEqual(
    result.state.working.items.map((candidate) => candidate.proposition),
    propositions.slice(0, -1),
  );
  assert.equal(
    candidateRejections(result.state.outcomes, result.state.source)[0]?.candidateIndex,
    6,
  );
});

test("repair, split and split-child canonicalisation failures fail recovery", async (t) => {
  for (const failing of ["repair", "split", "claim"]) {
    const server = await chatServer(t, (request) => {
      if (request.model === failing) {
        throw new Error("provider unavailable");
      }
      if (request.model === "split") {
        return "PROPOSITIONS:\n- Child fact.";
      }
      return JSON.stringify({ claim: "A claim." });
    });
    const graph = oneStage(
      createRecoveryStage({
        classifyIntegrity: async () =>
          assert.fail("Failed transformations must not reach classification"),
        repairPipeline: createRepairPipeline(server.client("repair")),
        splitPipeline: createSplitPipeline(server.client("split")),
        claimPipeline: createCanonicalisationPipeline(server.client("claim")),
      }),
    );
    await assert.rejects(
      run(
        graph,
        {
          ...initialAtomisationState(source),
          working: {
            phase: "assessed",
            items: [
              {
                discoveryIndex: 0,
                proposition: "A compound fact.",
                claim: "A compound fact.",
                integrity: decision(
                  failing === "repair" ? { standalone: false } : { atomic: false },
                ),
              },
            ],
          },
        },
        { signal: AbortSignal.timeout(15000) },
      ),
    );
  }
});

test("downstream stages reject missing or blank canonical claims before model calls", async (t) => {
  const server = await chatServer(t, () =>
    assert.fail("Invalid candidates must not reach a model"),
  );
  const classify: IntegrityClassifier = async () =>
    assert.fail("Invalid candidates must not be classified");
  const stages = [
    createIntegrityStage(classify),
    createRecoveryStage({
      classifyIntegrity: classify,
      repairPipeline: createRepairPipeline(server.client("repair")),
      splitPipeline: createSplitPipeline(server.client("split")),
      claimPipeline: createCanonicalisationPipeline(server.client("claim")),
    }),
    createResolutionStage(),
    createFramingStage(async () => assert.fail("Invalid candidates must not be framed")),
    createTaggingStage(async () => assert.fail("Invalid candidates must not be tagged")),
    createFinalisationStage(),
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
  "recovery bounds whole candidate sequences at six and refills a freed slot",
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
      const input = JSON.parse(
        request.messages.find((message) => message.role === "user")!.content,
      );
      return JSON.stringify({ claim: `Repaired ${input.proposition}` });
    });
    const classify: IntegrityClassifier = async (_source, candidates, signal) => {
      const index = Number(candidates[0]!.proposition);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        finish.set(index, () => {
          signal.removeEventListener("abort", abort);
          finish.delete(index);
          active -= 1;
          resolve();
        });
        started[++entered]!.resolve();
      });
      return [decision({ mean: 1 - index / 100 })];
    };
    const graph = oneStage(
      createRecoveryStage({
        classifyIntegrity: classify,
        repairPipeline: createRepairPipeline(server.client("repair")),
        splitPipeline: createSplitPipeline(server.client("split")),
        claimPipeline: createCanonicalisationPipeline(server.client("claim")),
      }),
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
            claim: `Original ${discoveryIndex}`,
            integrity: decision({ standalone: false }),
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
      Array.from({ length: 8 }, (_, index) => `Repaired ${index}`),
    );
    assert.deepEqual(
      result.state.working.items.map((item) => item.integrity.mean),
      Array.from({ length: 8 }, (_, index) => 1 - index / 100),
    );
    assert.deepEqual(
      result.state.outcomes.map((item) => item.candidate.discoveryIndex),
      [0, 1, 2, 3, 4, 5, 6, 7],
    );
  },
);

test(
  "out-of-order split recovery merges identities and prior history deterministically",
  { timeout: 10000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "atomiser-recovery-ledger-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const ledgerPath = join(directory, "runs.sqlite3");
    const releaseFirst = gate();
    const laterChecked = gate();
    t.after(() => releaseFirst.resolve());
    const server = await chatServer(t, async (request) => {
      const message = request.messages.find((item) => item.role === "user")!.content;
      if (request.model === "split") {
        if (message === "Parent A") {
          await releaseFirst.promise;
        }
        const letter = message.endsWith("A") ? "A" : "B";
        return `PROPOSITIONS:\n- Child ${letter} good.\n- Child ${letter} compound.`;
      }
      assert.equal(request.model, "claim");
      return JSON.stringify({ claim: message.split("PROPOSITION\n")[1] });
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
      createRecoveryStage(
        {
          classifyIntegrity: classify,
          repairPipeline: createRepairPipeline(server.client("repair"), true),
          splitPipeline: createSplitPipeline(server.client("split"), true),
          claimPipeline: createCanonicalisationPipeline(server.client("claim"), true),
        },
        ledgerPath,
      ),
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
    assert.equal(server.requests.filter((request) => request.model === "split").length, 2);
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
    assert.deepEqual((await run(graph, empty)).state, {
      ...empty,
      working: { phase: "accepted", items: [] },
    });
    assert.equal(server.requests.length, before);
    const database = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      const batches = database
        .prepare("SELECT run_id FROM runs WHERE composition = 'aps-recover-candidates'")
        .all();
      assert.equal(batches.length, 2);
      for (const batch of batches) {
        assert.ok((await inspectAccepted({ ledgerPath, runId: String(batch.run_id) })).length > 0);
      }
    } finally {
      database.close();
    }
  },
);

test(
  "parallel recovery propagates cancellation and operational failure",
  { timeout: 10000 },
  async (t) => {
    const server = await chatServer(t, () => JSON.stringify({ claim: "Repaired fact." }));
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
          if (candidates[0]!.proposition === "0") {
            throw new Error("Recovery classifier unavailable");
          }
        }
        return [decision()];
      };
      const graph = oneStage(
        createRecoveryStage({
          classifyIntegrity: classify,
          repairPipeline: createRepairPipeline(server.client("repair")),
          splitPipeline: createSplitPipeline(server.client("split")),
          claimPipeline: createCanonicalisationPipeline(server.client("claim")),
        }),
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
              claim: `Original ${discoveryIndex}`,
              integrity: decision({ standalone: false }),
            })),
          },
        },
        { signal: controller.signal },
      );
      const rejected = assert.rejects(
        running,
        cancel ? /cancel|abort/iu : /Recovery classifier unavailable|Recovery failed/u,
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
        createIntegrityStage(async () => assert.fail("Wrong phase must not reach classification")),
      ),
      initialAtomisationState(source),
    ),
    /requires canonicalised candidates/u,
  );
  await assert.rejects(
    run(
      oneStage(createFramingStage(async () => assert.fail("Wrong phase must not reach framing"))),
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
      run(oneStage(createIntegrityStage(async () => decisions)), {
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
    recovery: "repaired" as const,
    framing: {
      world: { layer: "real_world" as const, fictional_work: null },
      epistemic: { source_commitment: "asserted" as const, modal_frame: "actual" as const },
      temporal: { instability: "mutable" as const },
    },
    tags: ["first"],
  };
  const second = {
    ...first,
    discoveryIndex: 2,
    proposition: "Second.",
    claim: "Second claim.",
    integrity: decision({ mean: 0.9 }),
    tags: ["second"],
  };
  const result = await run(oneStage(createFinalisationStage()), {
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
    atomizationVersion: 9,
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
      recovery: "repaired",
      atomizationVersion: 9,
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

test("blank split-child claims fail before integrity classification", async (t) => {
  const server = await chatServer(t, (request) =>
    request.model === "split" ? "PROPOSITIONS:\n- Child fact." : JSON.stringify({ claim: "   " }),
  );
  const graph = oneStage(
    createRecoveryStage({
      classifyIntegrity: async () => assert.fail("Blank child claims must not be classified"),
      repairPipeline: createRepairPipeline(server.client("repair")),
      splitPipeline: createSplitPipeline(server.client("split")),
      claimPipeline: createCanonicalisationPipeline(server.client("claim")),
    }),
  );
  await assert.rejects(
    run(graph, {
      ...initialAtomisationState(source),
      working: {
        phase: "assessed",
        items: [
          {
            discoveryIndex: 0,
            proposition: "Compound.",
            claim: "Compound.",
            integrity: decision({ atomic: false }),
          },
        ],
      },
    }),
  );
});
