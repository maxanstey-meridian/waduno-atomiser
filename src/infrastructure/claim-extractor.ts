import { spawn } from "node:child_process";
import { z } from "zod";
import type {
  ClaimExtractor,
  ClaimExtractorEndpoint,
} from "../application/ports/claim-extractor.js";

const Response = z.strictObject({
  claims: z.array(z.strictObject({ content: z.string().trim().min(1) })),
});

export const createClaimExtractor =
  (python: string, script: string, endpoint: ClaimExtractorEndpoint): ClaimExtractor =>
  async (source, signal) => {
    signal.throwIfAborted();
    const executionSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(endpoint.timeoutMilliseconds),
    ]);
    const child = spawn(
      python,
      [
        script,
        endpoint.baseUrl,
        endpoint.model,
        endpoint.apiKeyVariable,
        String(Math.ceil(endpoint.timeoutMilliseconds / 1000)),
        endpoint.reasoningEffort ?? "",
      ],
      {
        signal: executionSignal,
        stdio: "pipe",
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.stdin.once("error", (error) => {
        child.kill();
        reject(error);
      });
      child.once("close", (code) => resolve(code ?? -1));
      child.stdin.end(
        JSON.stringify({ text: source.text, title: source.title, context: source.context }),
      );
    });
    if (code !== 0) {
      throw new Error(`ClaimExtractor failed (${code}): ${Buffer.concat(stderr).toString("utf8")}`);
    }
    return Response.parse(JSON.parse(Buffer.concat(stdout).toString("utf8"))).claims.map(
      (claim) => claim.content,
    );
  };
