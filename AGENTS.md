# Atomiser

Single-capability, source-neutral content-to-atoms package with a minimal HTTP
host. One module, no corpus client, storage or background worker.

## Architecture

Public wire schemas live in src/contracts and are published through ./contracts.
Domain owns pure decision types, integrity thresholds and recovery eligibility; pipeline owns internal state schemas
and consumes the public source/output schemas directly. Contracts never import
Domain or pipeline internals. Application owns narrow model ports, with no
contracts or Tandem imports. Pipeline owns
one native graph with two collections and inline stages; infrastructure implements model ports. Bootstrap's bootstrapAtomiser returns an explicit AtomiserRuntime
{ pipeline: Pipeline<AtomisationState>, close }. The graph factory lives in pipeline/;
HTTP accepts the pipeline directly. Agent definitions live in agents/ and declare
explicit input/output types; state types are inferred from their owning Zod schemas. Candidate records carry their own
assessment and enrichment under a discriminated working phase. Recovery takes one
assessed candidate and returns an outcome; the recovery collection applies ordered child identities. HTTP host and CLI invoke native Tandem run directly and close
the GLiNER subprocess when their lifecycle ends.

The published source schema has opaque id/version, title, text, kind, context
and evidence passages. No Wikipedia article/revision fields or corpus endpoints.
The corpus owns source provenance and persistence. Atomisation version is 10;
ATOMIZATION_VERSION in contracts/atomise.ts is the only owner.

## Model/runtime constraints

- Gemma-APS takes plain user messages only. Any response_format destroys output.
- All four generation agents explicitly request reasoning effort `none`.
- Downstream stages require canonical claims; missing claims fail rather than use propositions.
- Deduplication rejections are unscored; only integrity rejections carry scores.
- Send selected text unchanged; no sentence segmenter or source-kind exclusion.
- Deduplicate exact proposition strings only; never strip semantic punctuation.
- Operational failures fail the run; do not replace failed transformations with
  unchanged claims, empty results or synthetic probabilities.
- Tandem raw parse receives raw text; validateFor/apply receive parsed candidates.
- Skip streamed </s> wrapper bullets in the APS parser.
- Pipeline state uses canonical Zod schemas; never mirror them.
- Every route has a meaningful nonblank label.
- Graphs capture configuration only. Stages read source/signal from execution.
- Native Tandem max owns child concurrency; do not add striped worker pools.
- Recovery runs at most six original-candidate sequences per source; child work
  remains serial within each branch. Merge in input order and assign source-wide
  split-child identities there, never from concurrent shared mutation.
- Native ledger/reporting owns execution observability, not custom collectors.
- Preserve discovery/integrity/recovery/framing semantics when changing hosting.
- GLiNER extracts entities from surviving canonical claims with source-title context.
  Atoms expose original entity text, type and confidence; no spans or resolution.
- `pnpm setup:gliner` installs the local Python 3.13 environment and pinned model.
  Runtime loads local weights once per subprocess; stdout is JSON lines and
  diagnostics go to stderr. Tagger failures fail the run, not empty tags.

## Work

The demo catalogue lives in `examples/corpus/passages.ts`. Users append `{ id,
title, text }` entries there. The example corpus API serves every entry; the demo
fetches them over HTTP and runs each separately. Never replace this flow with test
fixtures or import the catalogue directly into the demo runner. `task demo` starts
the watched example API, always enables recovery, and retains pretty reporting
and local JSON output. Corpus integration belongs in the example harness, not `src/`.
The demo owns and closes its watched corpus process; never use global process-name
matching to kill another checkout's server.

pnpm, strict TS, oxlint/oxfmt golden configs, node:test. pnpm check runs build,
lint, format:check and tests. Run Plumb for changed code; document real exceptions.
No comments unless asked. No commits unless explicitly asked.

Plumb MER-BT-017 exceptions: examples/corpus/config.ts is the example host's
configuration edge; examples/corpus/start.ts inherits the environment for its owned
child process; scripts/demo.ts reads NO_COLOR for terminal presentation. These
reads belong to the example harness and do not move into the package core.
