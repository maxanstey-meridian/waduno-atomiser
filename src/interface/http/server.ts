import { run, type Pipeline } from "@maxanstey-meridian/tandem";
import Fastify, { type FastifyInstance } from "fastify";
import { ATOMIZATION_VERSION, AtomizationOutput } from "../../contracts/atomise.js";
import { SourceEnvelope } from "../../contracts/source.js";
import { initialAtomisationState, type AtomisationState } from "../../pipeline/state.js";

export type AtomiserServerOptions = {
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly ledgerPath?: string;
};

export type AtomiserServer = {
  readonly app: FastifyInstance;
  readonly cancel: () => void;
};

export const createAtomiserServer = (
  pipeline: Pipeline<AtomisationState>,
  options: AtomiserServerOptions,
): AtomiserServer => {
  const app = Fastify({ bodyLimit: 2_000_000 });
  const shutdown = new AbortController();
  let active = 0;
  app.get("/health", async () => ({
    ready: !shutdown.signal.aborted,
    atomizationVersion: ATOMIZATION_VERSION,
    active,
  }));
  app.post("/atomise", async (request, reply) => {
    const parsed = SourceEnvelope.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "invalid_source", message: parsed.error.message });
    }
    if (active >= options.concurrency || shutdown.signal.aborted) {
      return reply.code(503).send({ code: "busy", message: "Atomiser capacity is occupied" });
    }
    const cancelled = new AbortController();
    const disconnect = () => {
      if (!reply.raw.writableFinished) {
        cancelled.abort();
      }
    };
    reply.raw.on("close", disconnect);
    active++;
    const timeout = AbortSignal.timeout(options.timeoutMs);
    try {
      const result = await run(pipeline, initialAtomisationState(parsed.data), {
        signal: AbortSignal.any([shutdown.signal, cancelled.signal, timeout]),
        ...(options.ledgerPath ? { ledgerPath: options.ledgerPath } : {}),
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
      return reply.code(timeout.aborted ? 504 : shutdown.signal.aborted ? 503 : 502).send({
        code: timeout.aborted ? "atomisation_timeout" : "atomisation_failed",
        message: error instanceof Error ? error.message : "Atomisation failed",
      });
    } finally {
      active--;
      reply.raw.off("close", disconnect);
    }
  });
  app.addHook("onClose", async () => {
    shutdown.abort();
  });
  return { app, cancel: () => shutdown.abort() };
};
