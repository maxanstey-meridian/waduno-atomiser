import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("GLiNER setup uses PYTHON to create the venv and its interpreter afterwards", () => {
  const directory = mkdtempSync(join(tmpdir(), "atomiser-python-"));
  try {
    const python = join(directory, "chosen-python");
    writeFileSync(
      python,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync("calls.jsonl", JSON.stringify({ executable: process.argv[1], args }) + "\\n");
if (args[0] === "-m" && args[1] === "venv") {
  fs.mkdirSync(".venv/bin", { recursive: true });
  fs.copyFileSync(process.argv[1], ".venv/bin/python");
  fs.chmodSync(".venv/bin/python", 0o755);
}
`,
    );
    chmodSync(python, 0o755);
    writeFileSync(join(directory, ".env"), `PYTHON=${python}\n`);
    const environment = { ...process.env };
    delete environment.PYTHON;
    execFileSync(
      process.execPath,
      [
        "--env-file-if-exists=.env",
        fileURLToPath(new URL("../scripts/setup-gliner.mjs", import.meta.url)),
      ],
      {
        cwd: directory,
        env: environment,
      },
    );
    const calls = readFileSync(join(directory, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(calls, [
      { executable: python, args: ["-m", "venv", "--clear", ".venv"] },
      {
        executable: realpathSync(join(directory, ".venv/bin/python")),
        args: ["-m", "pip", "install", "-r", "python/requirements.txt"],
      },
      {
        executable: realpathSync(join(directory, ".venv/bin/python")),
        args: ["python/gliner.py", "--setup", ".data/gliner2.5-base-v1"],
      },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
