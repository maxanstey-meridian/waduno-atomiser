import type { ChatClient } from "@maxanstey-meridian/tandem";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { TestContext } from "node:test";
import { z } from "zod";

const ChatRequest = z
  .object({
    model: z.string(),
    messages: z.array(z.object({ role: z.string(), content: z.string() })),
    stream: z.boolean(),
  })
  .passthrough();
type ChatRequest = z.infer<typeof ChatRequest>;

export const chatServer = async (
  t: TestContext,
  respond: (request: ChatRequest) => string | Promise<string>,
) => {
  const requests: ChatRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      const body = ChatRequest.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      requests.push(body);
      const content = await respond(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = { id: "test", object: "chat.completion.chunk", created: 1, model: body.model };
      response.write(
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    })().catch((error) => response.writeHead(500).end(String(error)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = (model: string): ChatClient => ({
    kind: "openai-compatible",
    version: 1,
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    wireApi: "completions",
    model,
    verifyModel: false,
    maxAttempts: 1,
    requestTimeoutMs: 5000,
  });
  return { requests, client };
};
