import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stripVTControlCharacters, styleText } from "node:util";
import type { SourceEnvelope } from "../src/contracts/source.js";
import type { IntegrityDecision } from "../src/domain/integrity.js";
import type { CandidateOutcome } from "../src/pipeline/outcomes.js";
import type { AtomisationState } from "../src/pipeline/state.js";
import type { OpenRouterSpend } from "./openrouter-spend.js";

const paragraph = (text: string, prefix: string, width: number): string => {
  const lines: string[] = [];
  let line = prefix;
  for (const word of text.split(/\s+/u)) {
    if (
      line.length > prefix.length &&
      stripVTControlCharacters(line).length + stripVTControlCharacters(word).length + 1 > width
    ) {
      lines.push(line);
      line = prefix;
    }
    line += `${line.length > prefix.length ? " " : ""}${word}`;
  }
  lines.push(line);
  return lines.join("\n");
};

const palette = (enabled: boolean) => (style: Parameters<typeof styleText>[0], text: string) =>
  enabled ? styleText(style, text, { validateStream: false }) : text;

const scores = (decision: IntegrityDecision | null, paint: ReturnType<typeof palette>) => {
  if (decision === null) {
    return paint("dim", "Jev: not scored");
  }
  const checks = [
    ["supported", "supported"],
    ["meaning preserved", "meaning_preserved"],
    ["standalone", "standalone"],
    ["context complete", "context_complete"],
    ["atomic", "atomic"],
  ] as const;
  return `Jev: ${checks
    .map(([label, key]) => {
      const probability = decision.probabilities[key];
      return `${label} ${paint(decision[key] ? "green" : "red", `${probability.toFixed(2)} ${decision[key] ? "✓" : "✗"}`)}`;
    })
    .join(" · ")}`;
};

export const formatDemoInput = (source: SourceEnvelope, width = 100, color = false) =>
  `\n${palette(color)(["bold", "cyan"], `INPUT · ${source.title}`)}\n${paragraph(source.text, "  ", width)}\n`;

export const formatDemoResult = (state: AtomisationState, width = 100, color = false) => {
  const paint = palette(color);
  const roots = [...state.outcomes].sort(
    (a, b) => a.candidate.discoveryIndex - b.candidate.discoveryIndex,
  );
  const lines = [
    `\n${paint(["bold", "cyan"], `MINED · ${roots.length} propositions`)}`,
    paint("dim", "Jev checks must all pass; probabilities are not an overall truth score."),
  ];
  let produced = 0;
  const render = (entry: CandidateOutcome, label: string, prefix: string) => {
    const repair = "repair" in entry ? entry.repair : null;
    const decision = entry.outcome === "duplicate" ? null : entry.candidate.integrity;
    const outcome = entry.outcome === "duplicate" ? "rejected" : entry.outcome;
    const outcomeColor =
      outcome === "accepted" ? "green" : outcome === "rejected" ? "red" : "yellow";
    const status = `${repair === null ? "" : paint("yellow", "REPAIR → ")}${paint(["bold", outcomeColor], outcome.toUpperCase())}`;
    lines.push(`\n${prefix}[${label}] ${status}`);
    const indent = prefix === "" ? "    " : prefix === "├─ " ? "│      " : "       ";
    lines.push(paragraph(`Proposition: ${entry.candidate.proposition}`, indent, width));
    if ("claim" in entry.candidate && entry.candidate.claim !== entry.candidate.proposition) {
      lines.push(paragraph(`Claim checked: ${entry.candidate.claim}`, indent, width));
    }
    lines.push(paragraph(scores(decision, paint), indent, width));
    if (repair !== null) {
      lines.push(paint("yellow", paragraph(`Repaired claim: ${repair.claim}`, indent, width)));
      lines.push(
        paragraph(
          scores(repair.outcome === "unchanged" ? null : repair.integrity, paint),
          indent,
          width,
        ),
      );
      if (repair.outcome !== "unchanged" && repair.integrity.reason) {
        lines.push(paint("yellow", paragraph(repair.integrity.reason, indent, width)));
      }
    }
    if (entry.reason) {
      lines.push(paint(outcomeColor, paragraph(entry.reason, indent, width)));
    }
    if (entry.outcome === "accepted") {
      lines.push(
        paint(
          ["bold", "magentaBright"],
          paragraph("Produced [" + ++produced + "]: " + entry.accepted.claim, indent, width),
        ),
      );
    }
  };
  for (const [index, root] of roots.entries()) {
    const label = String(index + 1);
    render(root, label, "");
    const children = root.outcome === "split" ? root.children : [];
    for (const [childIndex, child] of children.entries()) {
      render(
        child,
        `${label}.${childIndex + 1}`,
        childIndex === children.length - 1 ? "└─ " : "├─ ",
      );
    }
  }
  const atoms = state.output?.atoms ?? [];
  lines.push(
    `\n${paint(["bold", "cyan"], `OUTPUT · ${atoms.length} atoms · ${state.output?.status ?? "failed"}`)}`,
  );
  for (const [index, atom] of atoms.entries()) {
    lines.push(paragraph(`${index + 1}. ${atom.claim}`, "  ", width));
    lines.push(
      paint("dim", paragraph(`entities: ${JSON.stringify(atom.entities)}`, "     ", width)),
    );
  }
  return lines.join("\n");
};

export const saveDemoResult = async (
  state: AtomisationState,
  directory = ".data/demo",
  openRouterSpend: OpenRouterSpend | null = null,
) => {
  if (state.output === null) {
    throw new Error("Cannot save atoms without an atomisation output.");
  }
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const runDirectory = await mkdtemp(
    join(root, `${new Date().toISOString().replaceAll(":", "-")}-`),
  );
  const atomsPath = join(runDirectory, "atoms.json");
  const reportPath = join(runDirectory, "report.json");
  await writeFile(atomsPath, `${JSON.stringify(state.output.atoms, null, 2)}\n`, { flag: "wx" });
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        source: state.source,
        outcomes: state.outcomes,
        candidates: state.working.items,
        output: state.output,
        openRouterSpend,
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  return { atomsPath, reportPath };
};
