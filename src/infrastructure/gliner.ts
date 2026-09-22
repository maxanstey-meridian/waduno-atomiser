import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { AtomTagger } from "../application/ports/atom-tagger.js";

export type GlinerTagger = {
  readonly tag: AtomTagger;
  readonly close: () => void;
};

export const createGlinerTagger = (
  python: string,
  script: string,
  modelPath: string,
): GlinerTagger => {
  let child: ChildProcessWithoutNullStreams | undefined;
  let rejectActive: ((error: Error) => void) | undefined;
  let acceptLine: ((line: string) => void) | undefined;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();

  const stop = (error: Error) => {
    const process = child;
    child = undefined;
    rejectActive?.(error);
    process?.kill("SIGKILL");
  };

  const start = () => {
    if (child !== undefined) {
      return child;
    }
    const process = spawn(python, ["-u", script, modelPath], { stdio: "pipe" });
    child = process;
    process.stderr.pipe(globalThis.process.stderr, { end: false });
    const lines = createInterface({ input: process.stdout });
    lines.on("line", (line) => {
      if (child === process) {
        acceptLine?.(line);
      }
    });
    const failed = (error: Error) => {
      if (child === process) {
        stop(error);
      }
    };
    process.on("error", failed);
    process.stdin.on("error", failed);
    process.on("exit", (code, signal) => {
      lines.close();
      failed(new Error(`GLiNER exited (${signal ?? code})`));
    });
    return process;
  };

  const tag: AtomTagger = (title, claims, signal) => {
    const operation = queue.then(async () => {
      signal.throwIfAborted();
      if (closed) {
        throw new Error("GLiNER tagger is closed");
      }
      if (claims.length === 0) {
        return [];
      }
      const executionSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
      const process = start();
      return await new Promise<string[][]>((resolve, reject) => {
        const abort = () =>
          stop(new Error("GLiNER request aborted", { cause: executionSignal.reason }));
        const cleanup = () => {
          executionSignal.removeEventListener("abort", abort);
          acceptLine = undefined;
          rejectActive = undefined;
        };
        rejectActive = (error) => {
          cleanup();
          reject(error);
        };
        acceptLine = (line) => {
          try {
            const tags = z
              .array(z.array(z.string().trim().min(1)))
              .length(claims.length)
              .parse(JSON.parse(line));
            cleanup();
            resolve(tags);
          } catch (error) {
            stop(new Error("Invalid GLiNER response", { cause: error }));
          }
        };
        executionSignal.addEventListener("abort", abort, { once: true });
        process.stdin.write(`${JSON.stringify({ title, claims })}\n`);
      });
    });
    queue = operation.catch(() => {});
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
      }
      void operation
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  };

  return {
    tag,
    close: () => {
      closed = true;
      stop(new Error("GLiNER tagger closed"));
    },
  };
};
