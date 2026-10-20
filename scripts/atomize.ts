import { run } from "@maxanstey-meridian/tandem";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { bootstrapAtomiser } from "../src/bootstrap.js";
import { parseAtomiserEnv } from "../src/config.js";
import { SourceEnvelope } from "../src/contracts/source.js";
import { initialAtomisationState } from "../src/pipeline/state.js";
import { formatDemoInput, formatDemoResult, saveDemoResult } from "./demo-report.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    demo: { type: "boolean", default: false },
    item: { type: "boolean", default: false },
  },
});
const [path] = positionals;
if (!path || positionals.length !== 1) {
  throw new Error("Usage: pnpm atomize <source.json> [--item] [--demo]");
}
const config = parseAtomiserEnv();
const source = SourceEnvelope.parse(JSON.parse(await readFile(path, "utf8")));
const width = process.stdout.columns ?? 100;
if (values.demo) {
  console.log(formatDemoInput(source, width));
}
const { pipelines, ledgerPath } = await bootstrapAtomiser(config);
const shutdown = new AbortController();
const stop = () => shutdown.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  const result = await run(
    values.item ? pipelines.item : pipelines.passage,
    initialAtomisationState(source),
    {
      signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(600_000)]),
      ledgerPath,
      enableLedgerTools: false,
    },
  );
  if (!result.succeeded || result.state.output === null) {
    throw new Error(result.summary ?? "Atomisation failed");
  }
  if (values.demo) {
    console.log(formatDemoResult(result.state, width));
    const { atomsPath, reportPath } = await saveDemoResult(result.state);
    console.log(`\nAtoms saved to: ${atomsPath}\nReport saved to: ${reportPath}`);
  } else {
    console.log(JSON.stringify(result.state.output, null, 2));
  }
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
