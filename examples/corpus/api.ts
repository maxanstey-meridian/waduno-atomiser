import Fastify from "fastify";
import { z } from "zod";
import { SourceLookup, SourceSearchRequest } from "./contract.js";
import { passages, type ExamplePassage } from "./passages.js";
import { sourceEnvelope } from "./source.js";

export const createExampleCorpus = (configuredPassages: readonly ExamplePassage[] = passages) => {
  const ids = configuredPassages.map((passage) => passage.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => id.trim() === "")) {
    throw new Error("Example passage ids must be non-empty and unique.");
  }
  const envelopes = configuredPassages.map(sourceEnvelope);
  const candidates = envelopes.map(({ id, version, title }) => ({ id, version, title }));
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const httpError = z.object({ statusCode: z.number().int().min(400).max(599) }).safeParse(error);
    const status =
      error instanceof z.ZodError ? 400 : httpError.success ? httpError.data.statusCode : 500;
    return reply
      .code(status)
      .send({ detail: error instanceof Error ? error.message : "Example corpus failed" });
  });
  app.get("/health", async () => ({ service: "example-corpus", status: "ok" }));
  app.post("/source-candidates/search", async (request) => {
    SourceSearchRequest.parse(request.body);
    return { results: [{ query: "not-used", candidates }] };
  });
  app.post("/source-envelope", async (request, reply) => {
    const identity = SourceLookup.parse(request.body);
    const envelope = envelopes.find(
      (source) => source.id === identity.id && source.version === identity.version,
    );
    return envelope ?? reply.code(404).send({ detail: "Unknown source" });
  });
  return app;
};
