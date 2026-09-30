# Atomiser context

The corpus owns source selection, provenance, atom persistence, jobs and retries.
This package accepts a source-neutral envelope and returns one transformation.
It has no corpus client or reverse callback. See README.md for setup and operation.

ClaimExtractor owns extraction; Gemma-APS owns splitting. Send the selected text
unchanged to ClaimExtractor and a failing claim unchanged through APS's
plain-user/raw-output interface; never add sentence segmentation. Source kind
does not filter content. Deduplication removes exact claim strings only.

All five independent Jev integrity checks must pass at 0.6. Standalone sees the
claim alone; contextual operations receive bounded source context. Only a claim
that fails atomicity alone is split; its children are checked against their
parent and rejected if they fail. There is no repair and no recursive splitting.

Domain owns the acceptance threshold and split eligibility. Application ports
own their narrow source-context inputs; the pipeline assembles public output.
Its working phase carries discovered, canonicalised, assessed, accepted, framed
or tagged candidate records, each carrying its own metadata.
All downstream stages require a nonblank canonical claim. Deduplication rejections
use their own stage and omit scores; they never received an integrity verdict.
The APS split agent explicitly requests reasoning effort `none`.
Model roles are ClaimExtractor for extraction, APS for splitting, and Jev for
integrity/framing; GLiNER provides entity text, type and confidence separately.
Claim resolution uses native Tandem concurrency, bounded at six per source run.
Split branches keep their child work serial and their results isolated.
Branch-local child indices become source-wide identities only during the ordered
merge. Candidate outcomes retain original assessments and nested split children;
finalisation derives wire rejections from them.

Infrastructure and malformed-output failures fail the run. Never present them as
empty extraction, negative model probabilities or successful fallback claims.
Framing evaluates the complete emitted assertion. Fictional narrative assertions
are fixed relative to the narrative, not the reader's moving present; incompatible
world/temporal classifications fail visibly. Work identification remains deferred; framing exposes only the world layer.

Native Tandem owns execution, concurrency and the ledger. GLiNER uses a warm local
subprocess; its protocol/lifecycle is not an additional background-job system.
The demo owns its watched example API process and obtains every catalogue entry
over HTTP. No global process matching, detached daemon or corpus import shortcut.

Live canaries are evidence for their labelled cases, not general calibration.
Offline tests establish deterministic contracts, failure handling and execution
boundaries; they do not establish model quality. Split children can still be rejected.
