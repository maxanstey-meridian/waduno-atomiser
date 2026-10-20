import { run, type Pipeline } from "@maxanstey-meridian/tandem";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { AtomizationOutput } from "../../contracts/atomise.js";
import { SourceEnvelope } from "../../contracts/source.js";
import type { AtomiserPipelines } from "../../pipeline/pipelines.js";
import { initialAtomisationState, type AtomisationState } from "../../pipeline/state.js";

export type AtomiserServerOptions = {
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly queueLimit: number;
  readonly ledgerPath?: string;
};

export type AtomiserServer = {
  readonly app: FastifyInstance;
  readonly cancel: () => void;
};

export const createAtomiserServer = (
  pipelines: AtomiserPipelines,
  options: AtomiserServerOptions,
): AtomiserServer => {
  const app = Fastify({ bodyLimit: 2_000_000 });
  const shutdown = new AbortController();
  let active = 0;
  const waiting: {
    resolve: () => void;
    reject: (reason: unknown) => void;
    signal: AbortSignal;
    abort: () => void;
  }[] = [];
  const acquire = (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (active < options.concurrency && waiting.length === 0) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = waiting.indexOf(waiter);
          if (index >= 0) {
            waiting.splice(index, 1);
          }
          reject(signal.reason);
        },
      };
      waiting.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
    });
  };
  const release = () => {
    const next = waiting.shift();
    if (next) {
      next.signal.removeEventListener("abort", next.abort);
      next.resolve();
    } else {
      active--;
    }
  };
  app.get("/health", async () => ({
    ready: !shutdown.signal.aborted,
    active,
    waiting: waiting.length,
  }));
  const atomise =
    (pipeline: Pipeline<AtomisationState>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = SourceEnvelope.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "invalid_source", message: parsed.error.message });
      }
      if (waiting.length >= options.queueLimit) {
        return reply.code(503).send({ code: "busy", message: "Atomiser queue is full" });
      }
      const cancelled = new AbortController();
      const disconnect = () => {
        if (!reply.raw.writableFinished) {
          cancelled.abort();
        }
      };
      reply.raw.on("close", disconnect);
      const queued = AbortSignal.any([shutdown.signal, cancelled.signal]);
      let timeout: AbortSignal | undefined;
      let acquired = false;
      try {
        await acquire(queued);
        acquired = true;
        // The pipeline budget starts once a slot is held, not while queued.
        timeout = AbortSignal.timeout(options.timeoutMs);
        const signal = AbortSignal.any([queued, timeout]);
        const result = await run(pipeline, initialAtomisationState(parsed.data), {
          signal,
          ledgerPath: options.ledgerPath,
          enableLedgerTools: false,
        });
        if (!result.succeeded || result.state.output === null) {
          return reply.code(502).send({
            code: "atomisation_failed",
            message: result.summary ?? "Pipeline did not produce a result",
          });
        }
        return AtomizationOutput.parse(result.state.output);
      } catch (error) {
        const timedOut = timeout?.aborted === true;
        return reply.code(timedOut ? 504 : shutdown.signal.aborted ? 503 : 502).send({
          code: timedOut ? "atomisation_timeout" : "atomisation_failed",
          message: error instanceof Error ? error.message : "Atomisation failed",
        });
      } finally {
        if (acquired) {
          release();
        }
        reply.raw.off("close", disconnect);
      }
    };
  app.post("/atomise", atomise(pipelines.passage));
  app.post("/atomise-item", atomise(pipelines.item));
  app.addHook("onClose", async () => {
    shutdown.abort();
  });
  return { app, cancel: () => shutdown.abort() };
};
