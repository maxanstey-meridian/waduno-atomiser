# Atomiser

Single-capability, source-neutral content-to-atoms package with a minimal HTTP
host. One module, no corpus client, storage or background worker.

## Architecture

Public wire schemas live in src/contracts and are published through ./contracts.
Domain owns pure decision types, integrity thresholds and split eligibility; pipeline owns internal state schemas
and consumes the public source/output schemas directly. Contracts never import
Domain or pipeline internals. Application owns narrow model ports, with no
contracts or Tandem imports. Pipeline owns the ClaimExtractor (passage) and item graphs and their shared
integrity, framing, tagging and finalisation stages; infrastructure implements model ports. Bootstrap's async bootstrapAtomiser resolves to an explicit AtomiserRuntime
{ pipelines: { passage, item }, ledgerPath? }. The graph factory lives in pipeline/;
HTTP accepts both pipelines directly: `/atomise` runs passage, `/atomise-item` runs item. Agent definitions live in agents/ and declare
explicit input/output types; state types are inferred from their owning Zod schemas. Candidate records carry their own
assessment and enrichment under a discriminated working phase. Claim resolution takes one
assessed candidate and returns an outcome; the resolve-claims collection applies ordered split-child identities. HTTP host and CLI invoke native Tandem run directly.

The published source schema has opaque id/version, title, text, kind, context
and evidence passages. No Wikipedia article/revision fields or corpus endpoints.
The corpus owns source provenance and persistence. Atoms carry no version: a
contract change is a breaking release, and consumers migrate their stored atoms.

## Model/runtime constraints

- The split agent explicitly requests reasoning effort `none` and parses raw text, not response_format.
- ClaimExtractor uses the pinned Orbitals prompt through its Python adapter, sent to the local fine-tune or a hosted model.
- Downstream stages require claims; missing claims fail rather than use propositions.
- Deduplication rejections are unscored; only integrity rejections carry scores.
- Send selected text unchanged; no sentence segmenter or source-kind exclusion.
- Deduplicate exact claim strings only; never strip semantic punctuation.
- Operational failures fail the run; do not replace failed transformations with
  unchanged claims, empty results or synthetic probabilities.
- Tandem raw parse receives raw text; validateFor/apply receive parsed candidates.
- Pipeline state uses canonical Zod schemas; never mirror them.
- Every route has a meaningful nonblank label.
- Graphs capture configuration only. Stages read source/signal from execution.
- Native Tandem max owns child concurrency; do not add striped worker pools.
- The ClaimExtractor graph checks extracted claims with Jev first. All five checks must pass; only atomicity failures that pass the other integrity checks go to splitting; split children are checked against their parent by Jev and failed claims are rejected.
- The item graph rewrites the whole source text once with the split model (reasoning effort `low`,
  raw text), never extracts or splits, and gates on every integrity check except atomicity.
  Its candidate keeps the original text as proposition and the rewrite as claim, so
  meaning_preserved compares them. Candidates carry their origin (`extracted` or `rewritten`);
  only `rewritten` candidates are accepted without atomicity.
- Claim resolution runs at most six original-candidate sequences per source; child work
  remains serial within each branch. Merge in input order and assign source-wide
  split-child identities there, never from concurrent shared mutation.
- Native ledger/reporting owns execution observability, not custom collectors.
- Preserve extraction/integrity/splitting/framing semantics when changing hosting.
- GLiNER extracts entities from surviving canonical claims with source-title context.
  Atoms expose entity text as string tags only when confidence is at least 0.8.
  Deduplicate exact tag text without regard to case; preserve distinct names and substrings;
  no types, confidence, spans or resolution are exposed.
- GLiNER runs on Fastino's hosted API (`FASTINO_API_KEY`), one request per claim.
  `pnpm setup:python` installs the Python 3.13 environment ClaimExtractor uses.
  Tagger failures fail the run, not empty tags.

## Work

The demo catalogue lives in `examples/corpus/passages.ts`. Users append `{ id,
title, text }` entries there. The example corpus API serves every entry; the demo
fetches them over HTTP and runs each separately. Never replace this flow with test
fixtures or import the catalogue directly into the demo runner. `task demo`
starts the watched example API and retains pretty reporting and local JSON output. Corpus integration belongs in the example harness, not `src/`.
The demo owns and closes its watched corpus process; never use global process-name
matching to kill another checkout's server.

pnpm, strict TS, oxlint/oxfmt golden configs, node:test. pnpm check runs build,
lint, format:check and tests. Run Plumb for changed code; document real exceptions.
No comments unless asked. No commits unless explicitly asked.

Plumb MER-BT-017 exceptions: examples/corpus/config.ts is the example host's
configuration edge; examples/corpus/start.ts inherits the environment for its owned
child process; scripts/demo.ts reads NO_COLOR for terminal presentation. These
reads belong to the example harness and do not move into the package core.
