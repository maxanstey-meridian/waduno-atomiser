import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { bootstrapAtomiser } from "./bootstrap.js";
import { parseAtomiserEnv, parseServerEnv } from "./config.js";
import { createAtomiserServer } from "./interface/http/server.js";

const config = parseAtomiserEnv();
const host = parseServerEnv();
if (config.ledgerPath) {
  await mkdir(dirname(config.ledgerPath), { recursive: true });
}
const { pipeline, close } = bootstrapAtomiser(config);
const { app, cancel } = createAtomiserServer(pipeline, {
  concurrency: host.ATOMISER_CONCURRENCY,
  timeoutMs: host.ATOMISER_TIMEOUT_MS,
  ledgerPath: config.ledgerPath,
});
app.addHook("onClose", async () => {
  close();
});
await app.listen({ host: host.ATOMISER_HOST, port: host.ATOMISER_PORT });
const stop = () => {
  cancel();
  void app.close();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
console.log(`Atomiser listening at ${app.listeningOrigin}`);
