# Atomiser

**Source text in, individual claims out.** Atomiser breaks a passage into small,
standalone claims and keeps the source evidence with each result. These are the
atoms: claims you can inspect and reuse without having to reconstruct the
paragraph they came from. Jev scores each claim; an optional integrity gate
controls whether failing claims are rejected or sent for recovery.

![Apollo 11 demo showing accepted claims, repairs, rejections, integrity scores and tags](demo.png)

The graphic illustrates the APS/Luna workflow. ClaimExtractor is now the default;
its different extraction and acceptance behaviour is described below.

## How it works

Atomiser validates a source envelope containing an opaque `id` and `version`, a
`title`, selected `text`, source `kind`, bounded `context` (section path and
lead-in), and at least one evidence passage. It does not search for sources or
store atoms: the corpus owns retrieval, provenance and persistence.

There are two pipelines:

| Pipeline          | Extraction                                                                   | Default integrity gate               | Recovery                                                                                      |
| ----------------- | ---------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `claim-extractor` | [ClaimExtractor-2605] using Orbitals' extraction prompt                      | Off: retain claims with their scores | With the gate enabled, eligible compound claims go to Gemma-APS for splitting; no Luna repair |
| `luna`            | [Gemma-APS] discovers propositions; the configured LLM makes them standalone | On: all five checks must pass        | Eligible failures are repaired by the LLM or split by Gemma-APS, then checked again           |

Both receive the selected text unchanged, without an extra sentence splitter or
source-kind filter. ClaimExtractor receives the source title, section path and
lead-in as context for resolving references, not as additional text to extract.
Luna uses the same bounded context during canonicalisation and repair. Exact
duplicate extracted claims or APS propositions are removed.

[Jev] checks five things: is the claim supported by the source, does it preserve
meaning, can it stand alone, does it express one claim, and does it retain the
context needed to understand it? The acceptance threshold is `0.6` for each check;
standalone sees only the claim. **These are model judgements, not an overall truth
score.** In ClaimExtractor, the initial proposition is the extracted claim itself;
for split children, meaning preservation is checked against their parent.

With the integrity gate enabled, all five checks must pass. ClaimExtractor only
splits an atomicity failure if the other four checks pass; failed children are
rejected. Luna can also repair eligible incomplete claims. With the gate disabled,
claims are retained with their scores even when checks fail, and recovery is skipped.

Jev then classifies each retained claim's world, epistemic and temporal framing.
Fastino's [GLiNER 2.5] extracts entities using the claim and source title. Atoms
expose these as `tags: string[]`: only entities with confidence at least `0.8` are
included, and exact duplicate text is collapsed without regard to case, keeping
the first spelling. Distinct names are kept even when one contains another.
Entity types, confidence values and spans are not included in the output.

Both pipelines produce atomisation contract version **11**. Each atom carries its
claim, proposition, source evidence, integrity scores, framing and tags, plus a
recovery marker when applicable. Version 11 replaces version 10's `entities`
objects with string `tags`; consumers need to update accordingly.

Malformed model output, missing classifier answers and failed dependencies fail
the run. They are not converted into empty extraction, zero scores or unchanged
claims presented as successful transformations. A valid empty extraction is a
successful `no_propositions` result; rejecting every candidate produces
`no_valid_candidates`.

## Architecture

This is a TypeScript application on Node.js, with Zod wire contracts and a small
Fastify host exposing `POST /atomise`. [Tandem] runs the pipeline, manages
collection concurrency and records execution in SQLite. The public schemas live
in [src/contracts](src/contracts) and are exported through the package's
`/contracts` entry point. Model adapters sit behind application ports; shared
pipeline stages handle integrity, framing, tagging and finalisation.

ClaimExtractor runs through a Python adapter against an OpenAI-compatible model
endpoint; the example configuration uses local oMLX. Luna defaults to [GPT-6 Luna]
through OpenRouter, but its canonicalisation and repair model can use another
OpenAI-compatible endpoint. Jev uses OpenRouter. [GLiNER] runs locally in a Python
subprocess kept warm between requests. The host and CLI close it on shutdown.

## Getting started

Requires Node.js 22+, pnpm, Python 3.13 and an OpenRouter key with access to Jev.
The Tandem runtime bundle supports Linux x64 and macOS on Apple silicon and
requires the .NET 10 runtime. [Task] is used for the demo commands.

Serve the model endpoints needed by your chosen pipeline separately:

- **ClaimExtractor:** an OpenAI-compatible ClaimExtractor endpoint. Gemma-APS is
  only needed when enabling the integrity gate and splitting eligible claims.
- **Luna:** a Gemma-APS endpoint and the configured canonicalisation/repair LLM.
  The default LLM uses your OpenRouter key; ClaimExtractor is not required.

```sh
pnpm install
cp .env.example .env
pnpm setup:gliner
```

Setup creates `.venv`, installs the Python dependencies for GLiNER and
ClaimExtractor, and downloads the pinned GLiNER weights. Set `OPENROUTER_API_KEY`
in `.env`, then choose the pipeline explicitly:

```dotenv
# Default: ClaimExtractor, with scores recorded but no rejection or splitting.
ATOMISER_PIPELINE=claim-extractor
ATOMISER_INTEGRITY_GATE=false
```

Or, to use the APS/Luna workflow for the HTTP host and CLI:

```dotenv
ATOMISER_PIPELINE=luna
ATOMISER_INTEGRITY_GATE=true
```

If `ATOMISER_INTEGRITY_GATE` is omitted, it defaults to `false` for ClaimExtractor
and `true` for Luna. An explicit value overrides either default, including when
using a demo task. The local ClaimExtractor endpoint key is optional.

### Configuration

Use [.env.example](.env.example) as the starting point. Values below are defaults
unless noted otherwise.

| Variable                                       | Default / example                   | Purpose                                                                                       |
| ---------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `ATOMISER_PIPELINE`                            | `claim-extractor`                   | Select `claim-extractor` or `luna` for the host and CLI.                                      |
| `ATOMISER_INTEGRITY_GATE`                      | Pipeline-dependent                  | `true` requires all integrity checks to pass; `false` retains scored claims without recovery. |
| `CLAIM_EXTRACTOR_BASE_URL`                     | `http://127.0.0.1:8092/v1`          | OpenAI-compatible ClaimExtractor endpoint.                                                    |
| `CLAIM_EXTRACTOR_MODEL`                        | `claim-extractor-4B-q-2605-oQ8-MTP` | Model name exposed by the ClaimExtractor server.                                              |
| `CLAIM_EXTRACTOR_API_KEY_ENVIRONMENT_VARIABLE` | `APS_API_KEY`                       | Name of the variable holding the optional endpoint key.                                       |
| `CLAIM_EXTRACTOR_REQUEST_TIMEOUT_MILLISECONDS` | `180000`                            | ClaimExtractor request timeout.                                                               |
| `APS_BASE_URL`                                 | `http://127.0.0.1:8092/v1`          | OpenAI-compatible Gemma-APS endpoint.                                                         |
| `APS_MODEL`                                    | `gemma-7b-aps-it-8bit`              | Model name exposed by the APS server.                                                         |
| `APS_API_KEY`                                  | Optional; example uses `local`      | Leave blank for an unauthenticated local endpoint.                                            |
| `APS_API_KEY_ENVIRONMENT_VARIABLE`             | `APS_API_KEY`                       | Name of the variable holding the APS endpoint key.                                            |
| `APS_REQUEST_TIMEOUT_MILLISECONDS`             | `120000`                            | APS request timeout.                                                                          |
| `APS_IDLE_TIMEOUT_MILLISECONDS`                | `30000`                             | APS stream idle timeout.                                                                      |
| `OPENROUTER_API_KEY`                           | Required                            | Jev key; also used by the default Luna configuration.                                         |
| `LLM_BASE_URL`                                 | `https://openrouter.ai/api/v1`      | Canonicalisation and repair endpoint for Luna.                                                |
| `LLM_MODEL`                                    | `openai/gpt-6-luna`                 | Shared Luna pipeline model for canonicalisation and repair, including split children.         |
| `LLM_API_KEY_ENVIRONMENT_VARIABLE`             | `OPENROUTER_API_KEY`                | Name of the variable holding the LLM endpoint key.                                            |
| `LLM_REQUEST_TIMEOUT_MILLISECONDS`             | `120000`                            | LLM request timeout.                                                                          |
| `ATOMIZER_RECOVERY`                            | `true`                              | Enable Luna repair and splitting when gated; the demo enables this setting.                   |
| `ATOMISER_HOST`                                | `127.0.0.1`                         | HTTP host bind address.                                                                       |
| `ATOMISER_PORT`                                | `8099`                              | HTTP port.                                                                                    |
| `ATOMISER_CONCURRENCY`                         | `2`                                 | Maximum active HTTP source runs.                                                              |
| `ATOMISER_TIMEOUT_MS`                          | `600000`                            | Timeout per HTTP source run, in milliseconds.                                                 |
| `CORPUS_BASE_URL`                              | `http://127.0.0.1:8098`             | Example corpus API address used by the demo.                                                  |
| `TANDEM_LEDGER_PATH`                           | `.data/atomize.sqlite3`             | SQLite execution ledger path.                                                                 |
| `PYTHON`                                       | `python3.13`                        | Executable used to create `.venv`; runtime uses `.venv/bin/python`.                           |
| `GLINER_MODEL_PATH`                            | `.data/gliner2.5-base-v1`           | Local GLiNER weights downloaded by setup.                                                     |

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
active runs and the atomisation version; it does not probe model dependencies.

For a single local source file:

```sh
pnpm atomize source.json
pnpm atomize source.json --demo
```

The first prints the JSON output. `--demo` prints the decision report and saves
`atoms.json` and `report.json` under `.data/demo/`. Both use the pipeline selected
in `.env`.

## Try the demo

The catalogue in [passages.ts](examples/corpus/passages.ts) contains ten passages.
The demo starts its own watched example corpus API, fetches every passage over
HTTP and runs each separately. These commands make model calls for the entire
catalogue:

```sh
task demo                 # ClaimExtractor
task demo:claim-extractor # Explicit ClaimExtractor selection
task demo:luna            # Gemma-APS + the configured LLM
```

Each task selects its pipeline; the integrity gate still follows the rules above.
The demo enables Luna recovery when gated, prints decisions, and saves atoms and
reports under `.data/demo/claim-extractor/` or `.data/demo/luna/`.

For example, the Luna workflow can turn a context-dependent proposition into a
standalone claim:

```text
Source: Marge vs. the Monorail
  Marge nearly persuades the townspeople to repair Springfield's heavily damaged
  Main Street, but fast-talking salesman Lyle Lanley leads a song-and-dance routine
  that convinces them to build a monorail.

Proposition:
  The song-and-dance routine convinces them to build a monorail.

Standalone claim:
  Lyle Lanley's song-and-dance routine convinces the townspeople to build a monorail.
```

The following abbreviated output is from the earlier recorded Luna demo. It
illustrates the decisions and scores, not a fresh benchmark of ClaimExtractor or
version 11; omitted results, tags, timing and costs are not implied:

```text
[1] ACCEPTED
    Proposition: The Environmental Protection Agency fines Mr. Burns $3 million.
    Claim checked: The Environmental Protection Agency fines Mr. Burns $3 million for
    dumping nuclear waste in a Springfield park.
    Jev: supported 0.98 ✓ · meaning preserved 0.70 ✓ · standalone 0.92 ✓ ·
    context complete 0.84 ✓ · atomic 0.89 ✓

[8] ACCEPTED
    Proposition: The song-and-dance routine convinces them to build a monorail.
    Claim checked: Lyle Lanley's song-and-dance routine convinces the townspeople
    to build a monorail.
    Jev: supported 0.96 ✓ · meaning preserved 0.94 ✓ · standalone 0.90 ✓ ·
    context complete 0.76 ✓ · atomic 0.91 ✓
```

Add `{ id, title, text }` entries to the catalogue to try your own text. The demo
owns its watched corpus process and stops it on completion or interruption. An
occupied port fails startup; it never kills or silently reuses another process.
`task example-corpus` runs the watched API independently; stop it with Ctrl-C
before running the demo on the same port. [SOURCES.md](examples/corpus/SOURCES.md)
records attribution for the included Wikipedia-derived passages.

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
[Gemma-APS]: https://huggingface.co/google/gemma-7b-aps-it
[GPT-6 Luna]: https://openrouter.ai/openai/gpt-6-luna
[Jev]: https://openrouter.ai/typesafe/jev-1.13
[GLiNER]: https://github.com/fastino-ai/GLiNER2
[GLiNER 2.5]: https://huggingface.co/fastino/gliner2.5-base-v1
[Tandem]: https://github.com/maxanstey-meridian/tandem
[Task]: https://taskfile.dev
