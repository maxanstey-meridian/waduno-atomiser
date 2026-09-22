import { z } from "zod";

export const parseExampleCorpusEnv = (environment: NodeJS.ProcessEnv = process.env) => {
  const { CORPUS_BASE_URL } = z
    .object({
      CORPUS_BASE_URL: z.url().default("http://127.0.0.1:8098"),
    })
    .parse(environment);
  const address = new URL(CORPUS_BASE_URL);
  if (
    address.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(address.hostname) ||
    address.pathname !== "/" ||
    address.search ||
    address.hash ||
    address.username ||
    address.password
  ) {
    throw new Error(
      "The example corpus requires a loopback HTTP CORPUS_BASE_URL with no path, query or credentials.",
    );
  }
  return address;
};
