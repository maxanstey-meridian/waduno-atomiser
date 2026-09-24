import { run } from "@maxanstey-meridian/tandem";
import { OpenRouter } from "@openrouter/sdk";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fetchExampleSources } from "../examples/corpus/client.js";
import { parseExampleCorpusEnv } from "../examples/corpus/config.js";
import { startExampleCorpus } from "../examples/corpus/start.js";
import { bootstrapAtomiser } from "../src/bootstrap.js";
import { parseAtomiserEnv } from "../src/config.js";
import { initialAtomisationState } from "../src/pipeline/state.js";
import { formatDemoInput, formatDemoResult, saveDemoResult } from "./demo-report.js";
import {
  ACCOUNTING_WAIT_MS,
  formatOpenRouterSpend,
  measureOpenRouterSpend,
  readOpenRouterUsage,
} from "./openrouter-spend.js";

const config = {
  ...parseAtomiserEnv(),
  apsRecovery: true,
};
const address = parseExampleCorpusEnv();
if (config.ledgerPath) {
  await mkdir(dirname(config.ledgerPath), { recursive: true });
}
const { pipeline, close } = bootstrapAtomiser(config);
const billing = new OpenRouter({
  apiKey: config.openRouterApiKey,
  retryConfig: { strategy: "none" },
});
const shutdown = new AbortController();
const stop = () => shutdown.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const width = process.stdout.columns ?? 100;
const color = process.stdout.isTTY && process.stdout.hasColors() && !("NO_COLOR" in process.env);
try {
  const corpus = await startExampleCorpus(address, shutdown.signal);
  try {
    const sources = await fetchExampleSources(
      corpus.origin,
      AbortSignal.any([shutdown.signal, AbortSignal.timeout(10_000)]),
    );
    console.log(`Loaded ${sources.length} sources from ${corpus.origin} · ${config.pipeline}`);
    const firstUsage = await readOpenRouterUsage(billing, shutdown.signal);
    let previousUsage = firstUsage;
    try {
      for (const source of sources) {
        console.log(formatDemoInput(source, width, color));
        const before = previousUsage;
        const result = await run(pipeline, initialAtomisationState(source), {
          signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(600_000)]),
          ledgerPath: config.ledgerPath,
          enableLedgerTools: false,
        }).finally(async () => {
          previousUsage = await readOpenRouterUsage(billing, shutdown.signal, ACCOUNTING_WAIT_MS);
          console.log(
            `\nOpenRouter · ${formatOpenRouterSpend(measureOpenRouterSpend(before, previousUsage))}`,
          );
        });
        if (!result.succeeded || result.state.output === null) {
          throw new Error(result.summary ?? "Atomisation failed");
        }
        console.log(formatDemoResult(result.state, width, color));
        const { atomsPath, reportPath } = await saveDemoResult(
          result.state,
          `.data/demo/${config.pipeline}`,
          measureOpenRouterSpend(before, previousUsage),
        );
        console.log(`\nAtoms saved to: ${atomsPath}\nReport saved to: ${reportPath}`);
      }
    } finally {
      console.log(
        `\nOpenRouter demo total · ${formatOpenRouterSpend(measureOpenRouterSpend(firstUsage, previousUsage))}`,
      );
    }
  } finally {
    await corpus.close();
  }
} finally {
  close();
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
