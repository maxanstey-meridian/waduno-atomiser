import ky, { HTTPError } from "ky";
import { z } from "zod";
import type { AtomTagger } from "../application/ports/atom-tagger.js";

const TAG_TYPES = {
  individual: "A specifically named individual person or fictional character",
  organization:
    "A specifically named organization, institution, school, company, government body, agency, band, media outlet, or organized group",
  work: "A specifically named creative work, television series, film, book, play, programme, advertisement, game, or franchise",
  installment:
    "A specifically named episode, chapter, issue, installment, or individual entry within a larger creative work",
  place: "A specifically named real or fictional geographic place or location",
  named_event_or_program:
    "A specifically named event, movement, test, programme, competition, campaign, initiative, rally, or organized activity",
  named_object:
    "A specifically named individual physical or fictional object, artifact, vehicle, toy, weapon, or item",
  topic:
    "A specific topic, cultural phenomenon, historical period, genre, theme, trend, or subject useful for identifying what the article or claim is about, such as 1990s nostalgia, Britpop, or 1990s music",
};

const schema = { entities: TAG_TYPES };

const RETRYABLE = [425, 429, 502, 503];

const Completion = z.object({
  choices: z.tuple([z.object({ message: z.object({ content: z.string() }) })]),
});

const Entity = z.object({
  text: z.string().trim().min(1),
  confidence: z.number().min(0).max(1),
});

const Extraction = z.object({ entities: z.record(z.string(), z.array(Entity)) });

const collapseTags = (entities: readonly z.infer<typeof Entity>[]): string[] => {
  const unique = new Map<string, string>();
  for (const entity of entities) {
    if (entity.confidence >= 0.8 && !unique.has(entity.text.toLowerCase())) {
      unique.set(entity.text.toLowerCase(), entity.text);
    }
  }
  return [...unique.values()];
};

export type FastinoEndpoint = {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly timeoutMilliseconds: number;
};

export const createFastinoTagger = (
  endpoint: FastinoEndpoint,
  transport: typeof fetch = fetch,
): AtomTagger => {
  const client = ky.create({
    fetch: transport,
    timeout: endpoint.timeoutMilliseconds,
    headers: { "X-API-Key": endpoint.apiKey },
    retry: {
      limit: 3,
      methods: ["post"],
      statusCodes: RETRYABLE,
      afterStatusCodes: RETRYABLE,
      maxRetryAfter: 60_000,
    },
  });
  const extract = async (title: string, claim: string, signal: AbortSignal) => {
    let body: unknown;
    try {
      body = await client
        .post(`${endpoint.baseUrl}/chat/completions`, {
          json: {
            model: endpoint.model,
            messages: [{ role: "user", content: `[Article: ${title}]\nClaim: ${claim}` }],
            schema,
            threshold: 0.5,
            include_confidence: true,
            include_spans: false,
          },
          signal,
        })
        .json();
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason;
      }
      const detail =
        error instanceof HTTPError
          ? ` (${error.response.status}): ${JSON.stringify(error.data)}`
          : "";
      throw new Error(`Fastino tagging failed${detail}`, { cause: error });
    }
    try {
      const [choice] = Completion.parse(body).choices;
      const { entities } = Extraction.parse(JSON.parse(choice.message.content));
      return collapseTags(Object.values(entities).flat());
    } catch (error) {
      throw new Error("Invalid Fastino response", { cause: error });
    }
  };

  return async (title, claims, signal) => {
    signal.throwIfAborted();
    const failed = new AbortController();
    const shared = AbortSignal.any([signal, failed.signal]);
    return await Promise.all(
      claims.map((claim) =>
        extract(title, claim, shared).catch((error: unknown) => {
          failed.abort(error);
          throw error;
        }),
      ),
    );
  };
};
