import { createExampleCorpus } from "./api.js";
import { parseExampleCorpusEnv } from "./config.js";
import { passages } from "./passages.js";

const address = parseExampleCorpusEnv();
const app = createExampleCorpus();
try {
  await app.listen({
    port: Number(address.port || 80),
    host: address.hostname.replace(/^\[|\]$/gu, ""),
  });
  process.send?.({ ready: app.listeningOrigin });
  console.log(
    `Example corpus listening on ${app.listeningOrigin}; serving ${passages.length} passages from examples/corpus/passages.ts`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (process.send) {
    process.send({ error: message });
  } else {
    console.error(message);
  }
  process.exitCode = 1;
  await app.close();
}
const stop = () => {
  void app.close();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
