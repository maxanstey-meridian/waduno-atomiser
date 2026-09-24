import { spawnSync } from "node:child_process";

const python = process.env.PYTHON ?? "python3.13";
if (!python.trim()) {
  throw new Error("PYTHON must name the Python executable used to create .venv.");
}

function run(executable, args) {
  const result = spawnSync(executable, args, { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(python, ["-m", "venv", "--clear", ".venv"]);
const venvPython = ".venv/bin/python";
run(venvPython, ["-m", "pip", "install", "-r", "python/requirements.txt"]);
run(venvPython, ["python/gliner.py", "--setup", ".data/gliner2.5-base-v1"]);
