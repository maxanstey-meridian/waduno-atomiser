import { SourceEnvelope } from "../../src/contracts/source.js";
import { SourceSearchResponse, type SourceLookup, type SourceSearchRequest } from "./contract.js";

const post = async (
  baseUrl: string,
  path: string,
  body: SourceLookup | SourceSearchRequest,
  signal: AbortSignal,
): Promise<unknown> => {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Example corpus ${path}: HTTP ${response.status}`);
  }
  return response.json();
};

export const fetchExampleSources = async (
  baseUrl: string,
  signal = AbortSignal.timeout(10_000),
) => {
  const search = SourceSearchResponse.parse(
    await post(baseUrl, "/source-candidates/search", { queries: ["not-used"] }, signal),
  );
  const sources: SourceEnvelope[] = [];
  for (const result of search.results) {
    for (const { id, version } of result.candidates) {
      const source = SourceEnvelope.parse(
        await post(baseUrl, "/source-envelope", { id, version }, signal),
      );
      if (source.id !== id || source.version !== version) {
        throw new Error("Example corpus returned a different source than requested.");
      }
      sources.push(source);
    }
  }
  return sources;
};
