import { bootstrapAtomiser } from "./bootstrap.js";
import { parseAtomiserEnv, parseServerEnv } from "./config.js";
import { createAtomiserServer } from "./interface/http/server.js";

const config = parseAtomiserEnv();
const host = parseServerEnv();
const { pipelines, ledgerPath } = await bootstrapAtomiser(config);
const { app, cancel } = createAtomiserServer(pipelines, {
  concurrency: host.ATOMISER_CONCURRENCY,
  timeoutMs: host.ATOMISER_TIMEOUT_MS,
  queueLimit: host.ATOMISER_QUEUE_LIMIT,
  ledgerPath,
});
await app.listen({ host: host.ATOMISER_HOST, port: host.ATOMISER_PORT });
const stop = () => {
  cancel();
  void app.close();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
console.log(`Atomiser listening at ${app.listeningOrigin}`);
