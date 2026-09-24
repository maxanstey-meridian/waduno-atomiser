import assert from "node:assert/strict";
import test from "node:test";
import { createClaimExtractor } from "../src/infrastructure/claim-extractor.js";

const source = {
  text: "She wrote the novel.",
  title: "Mary Shelley",
  context: { sectionPath: ["Frankenstein"], leadIn: "Shelley began writing in 1816." },
};
const extractor = (program: string) =>
  createClaimExtractor(process.execPath, "-e", program, "unused", "unused", 5000);

test("an extractor that exits before reading a large source rejects without crashing the host", async () => {
  await assert.rejects(
    extractor("process.exit(1)")(
      { ...source, text: "x".repeat(900_000) },
      AbortSignal.timeout(5000),
    ),
    /EPIPE|ECONNRESET|ClaimExtractor failed/u,
  );
});

test("the extractor passes unchanged text and bounded context to its worker", async () => {
  const claims = await extractor(`
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => {
      process.stdout.write(JSON.stringify({ claims: [{ content: input }] }));
    });
  `)(source, AbortSignal.timeout(5000));
  assert.deepEqual(JSON.parse(claims[0]!), source);
});
