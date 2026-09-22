import { fork } from "node:child_process";
import { once } from "node:events";
import { z } from "zod";

export const startExampleCorpus = async (address: URL, signal: AbortSignal) => {
  signal.throwIfAborted();
  const child = fork(new URL("./serve.ts", import.meta.url), {
    execArgv: ["--watch", "--import", "tsx"],
    env: { ...process.env, CORPUS_BASE_URL: address.href },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const exited = once(child, "exit");
  const close = async () => {
    child.kill("SIGTERM");
    await exited;
  };
  const startup = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  let abort = () => {};
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      abort = () => reject(startup.reason);
      startup.addEventListener("abort", abort, { once: true });
      child.on("message", (message: unknown) => {
        const ready = z.object({ ready: z.url() }).safeParse(message);
        if (ready.success) {
          resolve(ready.data.ready);
        }
        const failed = z.object({ error: z.string() }).safeParse(message);
        if (failed.success) {
          reject(new Error(failed.data.error));
        }
      });
      void exited.then(() => reject(new Error("Example corpus exited before startup")), reject);
      if (startup.aborted) {
        abort();
      }
    });
    return { origin, close };
  } catch (error) {
    await close();
    throw error;
  } finally {
    startup.removeEventListener("abort", abort);
  }
};
