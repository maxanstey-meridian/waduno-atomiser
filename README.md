# Atomiser

**Source text in, individual claims out.** Atomiser breaks a passage into small,
standalone claims and keeps the source evidence with each result. These are the
atoms: claims you can inspect and reuse without having to reconstruct the
paragraph they came from. Jev scores each claim; claims that fail its integrity
checks are rejected, and compound claims are split and checked again.

## How it works

Atomiser validates a source envelope containing an opaque `id` and `version`, a
`title`, selected `text`, source `kind`, bounded `context` (section path and
lead-in), and at least one evidence passage. It does not search for sources or
store atoms: the corpus owns retrieval, provenance and persistence.

[ClaimExtractor-2605], using Orbitals' extraction prompt, extracts claims from the
selected text unchanged, without an extra sentence splitter or source-kind filter.
It receives the source title, section path and lead-in as context for resolving
references, not as additional text to extract. Exact duplicate claims are removed.

[Jev] checks five things: is the claim supported by the source, does it preserve
meaning, can it stand alone, does it express one claim, and does it retain the
context needed to understand it? The acceptance threshold is `0.6` for each check;
standalone sees only the claim. **These are model judgements, not an overall truth
score.** The initial proposition is the extracted claim itself; for split
children, meaning preservation is checked against their parent.

All five checks must pass. A claim that fails only the atomicity check is split
into propositions by a hosted model (Luna, thinking off); each child is checked
again and failed children are rejected. Any other failure rejects the claim.

Jev then classifies each retained claim's world, epistemic and temporal framing.
Fastino's [GLiNER 2.5] extracts entities using the claim and source title. Atoms
expose these as `tags: string[]`: only entities with confidence at least `0.8` are
included, and exact duplicate text is collapsed without regard to case, keeping
the first spelling. Distinct names are kept even when one contains another.
Entity types, confidence values and spans are not included in the output.

Each atom carries its claim, proposition, source evidence, integrity scores,
framing and tags, plus a `recovery: "split"` marker for split children.

Malformed model output, missing classifier answers and failed dependencies fail
the run. They are not converted into empty extraction, zero scores or unchanged
claims presented as successful transformations. A valid empty extraction is a
successful `no_propositions` result; rejecting every candidate produces
`no_valid_candidates`.

## Architecture

This is a TypeScript application on Node.js, with Zod wire contracts and a small
Fastify host exposing `POST /atomise`. [Tandem] runs the pipeline, manages
collection concurrency and, when `TANDEM_LEDGER_PATH` is set, records execution
in SQLite. The public schemas live
in [src/contracts](src/contracts) and are exported through the package's
`/contracts` entry point. Model adapters sit behind application ports; the
pipeline stages handle integrity, framing, tagging and finalisation.

ClaimExtractor runs through a Python adapter against an OpenAI-compatible model
endpoint: the local fine-tune by default, or a hosted model given the same prompt.
Splitting and Jev use OpenRouter. [GLiNER] runs locally in a Python
subprocess kept warm between requests. The host and CLI close it on shutdown.

## Getting started

Requires Node.js 22+, pnpm, Python 3.13 and an OpenRouter key with access to Jev.
The Tandem runtime bundle supports Linux x64 and macOS on Apple silicon and
requires the .NET 10 runtime. [Task] is used for the demo commands.

Serve an OpenAI-compatible ClaimExtractor endpoint. The splitter is only called for
claims that fail the atomicity check.

```sh
pnpm install
cp .env.example .env
pnpm setup:gliner
```

Setup creates `.venv`, installs the Python dependencies for GLiNER and
ClaimExtractor, and downloads the pinned GLiNER weights. Set `OPENROUTER_API_KEY`
and `CLAIM_EXTRACTOR_API_KEY` in `.env`; startup fails if either key is missing.

To send ClaimExtractor's prompt to a hosted model instead of the local fine-tune,
set `CLAIM_EXTRACTOR_BASE_URL`, `CLAIM_EXTRACTOR_MODEL`,
`CLAIM_EXTRACTOR_API_KEY_ENVIRONMENT_VARIABLE` and `CLAIM_EXTRACTOR_REASONING_EFFORT`
together. For example, `https://openrouter.ai/api/v1`, `openai/gpt-6-luna`,
`OPENROUTER_API_KEY` and `minimal`.

### Configuration

Use [.env.example](.env.example) as the starting point. Values below are defaults
unless noted otherwise.

| Variable                                       | Default / example                   | Purpose                                                                                   |
| ---------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `CLAIM_EXTRACTOR_BASE_URL`                     | `http://127.0.0.1:8092/v1`          | OpenAI-compatible ClaimExtractor endpoint.                                                |
| `CLAIM_EXTRACTOR_MODEL`                        | `claim-extractor-4B-q-2605-oQ8-MTP` | Model name exposed by the ClaimExtractor server.                                          |
| `CLAIM_EXTRACTOR_API_KEY_ENVIRONMENT_VARIABLE` | `CLAIM_EXTRACTOR_API_KEY`           | Name of the variable holding the ClaimExtractor endpoint key.                             |
| `CLAIM_EXTRACTOR_REQUEST_TIMEOUT_MILLISECONDS` | `180000`                            | ClaimExtractor request timeout.                                                           |
| `CLAIM_EXTRACTOR_REASONING_EFFORT`             | unset                               | Reasoning effort for a hosted model given the same prompt; unset for the local fine-tune. |
| `CLAIM_EXTRACTOR_API_KEY`                      | Required; example uses `local`      | Local ClaimExtractor endpoint key.                                                        |
| `SPLIT_BASE_URL`                               | `https://openrouter.ai/api/v1`      | OpenAI-compatible endpoint that splits non-atomic claims.                                 |
| `SPLIT_MODEL`                                  | `openai/gpt-6-luna`                 | Splitting model; asked with reasoning effort `none`.                                      |
| `SPLIT_API_KEY_ENVIRONMENT_VARIABLE`           | `OPENROUTER_API_KEY`                | Name of the variable holding the required splitting endpoint key.                         |
| `SPLIT_REQUEST_TIMEOUT_MILLISECONDS`           | `30000`                             | Splitting request timeout.                                                                |
| `SPLIT_IDLE_TIMEOUT_MILLISECONDS`              | `30000`                             | Splitting stream idle timeout.                                                            |
| `OPENROUTER_API_KEY`                           | Required                            | Jev key.                                                                                  |
| `ATOMISER_HOST`                                | `127.0.0.1`                         | HTTP host bind address.                                                                   |
| `ATOMISER_PORT`                                | `8099`                              | HTTP port.                                                                                |
| `ATOMISER_CONCURRENCY`                         | `2`                                 | Maximum active HTTP source runs.                                                          |
| `ATOMISER_TIMEOUT_MS`                          | `600000`                            | Timeout per HTTP source run once it holds a slot, in milliseconds.                        |
| `ATOMISER_QUEUE_LIMIT`                         | `8`                                 | Requests allowed to wait for a slot; beyond this the host answers 503 `busy`.             |
| `CORPUS_BASE_URL`                              | `http://127.0.0.1:8098`             | Example corpus API address used by the demo.                                              |
| `TANDEM_LEDGER_PATH`                           | unset                               | Optional SQLite execution ledger path; unset keeps no run history.                        |
| `PYTHON`                                       | `python3.13`                        | Executable used to create `.venv`; runtime uses `.venv/bin/python`.                       |
| `GLINER_MODEL_PATH`                            | `.data/gliner2.5-base-v1`           | Local GLiNER weights downloaded by setup.                                                 |

### HTTP and CLI

Start the HTTP host:

```sh
pnpm serve
```

In another terminal, post a source envelope:

```sh
curl -sS http://127.0.0.1:8099/atomise \
  -H 'content-type: application/json' \
  --data-binary @tests/fixtures/source-envelope-quick-brown-fox.json
```

`POST /atomise` returns `completed`, `no_propositions` or `no_valid_candidates`,
with `atoms` and `candidateRejections`. `GET /health` reports host readiness,
active runs and queued requests (`waiting`); it does not probe model dependencies.

For a single local source file:

```sh
pnpm atomize source.json
pnpm atomize source.json --demo
```

The first prints the JSON output. `--demo` prints the decision report and saves
`atoms.json` and `report.json` under `.data/demo/`.

## Try the demo

The catalogue in [passages.ts](examples/corpus/passages.ts) contains ten passages.
The demo starts its own watched example corpus API, fetches every passage over
HTTP and runs each separately. These commands make model calls for the entire
catalogue:

```sh
task demo
```

The demo prints decisions and saves atoms and reports under `.data/demo/`.

Add `{ id, title, text }` entries to the catalogue to try your own text. The demo
owns its watched corpus process and stops it on completion or interruption. An
occupied port fails startup; it never kills or silently reuses another process.
`task example-corpus` runs the watched API independently; stop it with Ctrl-C
before running the demo on the same port. [SOURCES.md](examples/corpus/SOURCES.md)
records attribution for the included Wikipedia-derived passages.

## Using the contracts

The source envelope and atomisation output schemas are published for callers:

```sh
pnpm add @maxanstey-meridian/waduno-atomiser zod
```

```ts
import { AtomizationOutput, SourceEnvelope } from "@maxanstey-meridian/waduno-atomiser/contracts";
```

Zod 4 is a peer dependency so callers share one Zod instance with the schemas.

## Development

`pnpm check` runs the TypeScript build, lint, formatting checks and tests.
`pnpm test` runs the Node tests; the live Jev checks require an OpenRouter key.
After Python setup, `.venv/bin/python tests/claim_extractor_test.py` checks the
ClaimExtractor prompt and response adapter without making model calls.

## Licence

The code is licensed under the [MIT License](LICENSE), copyright 2026 Max Anstey.
Third-party dependencies and model weights retain their respective licences.
The Wikipedia-derived examples retain their CC BY-SA 4.0 licence; see
[example attribution](examples/corpus/SOURCES.md).

[ClaimExtractor-2605]: https://huggingface.co/principled-intelligence/claim-extractor-4B-q-2605
[Jev]: https://openrouter.ai/typesafe/jev-1.13
[GLiNER]: https://github.com/fastino-ai/GLiNER2
[GLiNER 2.5]: https://huggingface.co/fastino/gliner2.5-base-v1
[Tandem]: https://github.com/maxanstey-meridian/tandem
[Task]: https://taskfile.dev
