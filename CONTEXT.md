# Atomiser context

The corpus owns source selection, provenance, atom persistence, jobs and retries.
This package accepts a source-neutral envelope and returns one transformation.
It has no corpus client or reverse callback. See README.md for setup and operation.

Gemma-APS owns extraction and splitting. Send the selected text unchanged through
its plain-user/raw-output interface; never add sentence segmentation. Source kind
does not filter content. Deduplication removes exact proposition strings only.

All five independent Jev integrity checks must pass at 0.6. Standalone sees the
claim alone; contextual operations receive bounded source context. Repair changes
only the current claim, retains its original proposition and split-parent scope,
and rejects unchanged output without another verdict. Recovery remains bounded.

Domain owns the acceptance threshold and recovery eligibility. Application ports
own their narrow source-context inputs; the pipeline assembles public output.\nIts working phase carries discovered, canonicalised, assessed, accepted, framed\nor tagged candidate records, each carrying its own metadata. Operation folders\nkeep prompts, agents and small child graphs together.
All downstream stages require a nonblank canonical claim. Deduplication rejections
use their own stage and omit scores; they never received an integrity verdict.
Generation agents explicitly request reasoning effort `none`.
Model roles are APS for discovery/splitting, Jev for integrity/framing, and the
configurable LLM for all canonicalisation and repair. `LLM_*` configuration owns
that shared generation client; GLiNER provides entity tags separately.
Canonicalisation and recovery use native Tandem concurrency, each bounded at six
per source run. Recovery branches keep their child work serial and their results
isolated. Branch-local child indices become source-wide identities only during
the ordered merge. Candidate outcomes retain original assessments, repair attempts\nand nested split children; finalisation derives wire rejections from them.

Infrastructure and malformed-output failures fail the run. Never present them as
empty extraction, negative model probabilities or successful fallback claims.
Framing evaluates the complete emitted assertion. Fictional narrative assertions
are fixed relative to the narrative, not the reader's moving present; incompatible
world/temporal classifications fail visibly. Work identification remains deferred.

Native Tandem owns execution, concurrency and the ledger. GLiNER uses a warm local
subprocess; its protocol/lifecycle is not an additional background-job system.
The demo owns its watched example API process and obtains every catalogue entry
over HTTP. No global process matching, detached daemon or corpus import shortcut.

Live canaries are evidence for their labelled cases, not general calibration.
Offline tests establish deterministic contracts, failure handling and execution
boundaries; they do not establish model quality. Repairs can still be rejected.
