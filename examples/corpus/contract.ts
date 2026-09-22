import { z } from "zod";
import { SourceEnvelope } from "../../src/contracts/source.js";

export const SourceLookup = SourceEnvelope.pick({ id: true, version: true });
export type SourceLookup = z.infer<typeof SourceLookup>;
export const SourceSearchRequest = z.strictObject({
  queries: z.array(z.string()).min(1),
  limit: z.number().int().positive().optional(),
});
export type SourceSearchRequest = z.infer<typeof SourceSearchRequest>;
export const SourceSearchResponse = z.strictObject({
  results: z.array(
    z.strictObject({
      query: z.string(),
      candidates: z.array(SourceEnvelope.pick({ id: true, version: true, title: true })),
    }),
  ),
});
