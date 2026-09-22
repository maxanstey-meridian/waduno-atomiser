import type {
  FramingSubject,
  FramingResult,
} from "../../src/application/ports/framing-classifier.js";
import type { IntegrityCandidate } from "../../src/application/ports/integrity-classifier.js";
import type { IntegrityScoreKey } from "../../src/domain/integrity.js";

type IntegrityCanary = IntegrityCandidate & {
  name: string;
  why: string;
  source: string;
  expected: Record<Exclude<IntegrityScoreKey, "context_complete">, boolean>;
};

type FramingCanary = Omit<FramingSubject, "sourceContext"> & {
  name: string;
  why: string;
  expected: {
    world?: Partial<FramingResult["world"]>;
    epistemic?: Partial<FramingResult["epistemic"]>;
    temporal?: Partial<FramingResult["temporal"]>;
  };
};

const source =
  "On 12 March 2024, Mira delivered three red crates to North Depot. On 13 March 2024, Mira inspected South Depot.";
const delivery = "Mira delivered three red crates to North Depot on 12 March 2024.";
const unresolved = "She delivered three red crates to North Depot on 12 March 2024.";
const wrongQuantity = "Mira delivered seven red crates to North Depot on 12 March 2024.";
const inspection = "Mira inspected South Depot on 13 March 2024.";
const compound =
  "Mira delivered three red crates to North Depot on 12 March 2024, and Mira inspected South Depot on 13 March 2024.";
const valid = { supported: true, meaning_preserved: true, standalone: true, atomic: true };

export const integrityCanaries: readonly IntegrityCanary[] = [
  {
    name: "negation removed",
    why: "Removing did not contradicts the source and reverses the selected assertion.",
    source: "Mira did not inspect South Depot on 13 March 2024.",
    proposition: "Mira did not inspect South Depot on 13 March 2024.",
    claim: inspection,
    expected: { ...valid, supported: false, meaning_preserved: false },
  },
  {
    name: "allegation promoted to fact",
    why: "An allegation establishes what was alleged, not that the alleged theft occurred.",
    source: "Mira alleged that Tomas stole three crates from North Depot on 12 March 2024.",
    proposition: "Mira alleged that Tomas stole three crates from North Depot on 12 March 2024.",
    claim: "Tomas stole three crates from North Depot on 12 March 2024.",
    expected: { ...valid, supported: false, meaning_preserved: false },
  },
  {
    name: "possibility promoted to fact",
    why: "A possible inspection does not establish an actual inspection; removing might strengthens the assertion.",
    source: "Mira might have inspected South Depot on 13 March 2024.",
    proposition: "Mira might have inspected South Depot on 13 March 2024.",
    claim: inspection,
    expected: { ...valid, supported: false, meaning_preserved: false },
  },
  {
    name: "split loses allegation scope",
    why: "The child matches its claim but extracts alleged content as an independent fact, losing the parent's attribution.",
    source: "Mira alleged that Tomas stole three crates from North Depot on 12 March 2024.",
    parentProposition:
      "Mira alleged that Tomas stole three crates from North Depot on 12 March 2024.",
    proposition: "Tomas stole three crates from North Depot on 12 March 2024.",
    claim: "Tomas stole three crates from North Depot on 12 March 2024.",
    expected: { ...valid, supported: false, meaning_preserved: false },
  },
  {
    name: "clean positive",
    why: "One explicit fact is supported and unchanged.",
    source,
    proposition: delivery,
    claim: delivery,
    expected: valid,
  },
  {
    name: "resolved reference",
    why: "The source establishes Mira as the referent of she.",
    source,
    proposition: unresolved,
    claim: delivery,
    expected: valid,
  },
  {
    name: "unsupported but preserved",
    why: "Seven is unsupported, but retaining it preserves the selected proposition.",
    source,
    proposition: wrongQuantity,
    claim: wrongQuantity,
    expected: { ...valid, supported: false },
  },
  {
    name: "changed quantity",
    why: "Changing three to seven fails both support and preservation.",
    source,
    proposition: delivery,
    claim: wrongQuantity,
    expected: { ...valid, supported: false, meaning_preserved: false },
  },
  {
    name: "different supported fact",
    why: "The inspection is supported but replaces the selected delivery fact.",
    source,
    proposition: delivery,
    claim: inspection,
    expected: { ...valid, meaning_preserved: false },
  },
  {
    name: "unresolved reference",
    why: "The source resolves she, but the claim alone does not.",
    source,
    proposition: unresolved,
    claim: unresolved,
    expected: { ...valid, standalone: false },
  },
  {
    name: "two assertions",
    why: "Delivery and inspection are separately asserted events.",
    source,
    proposition: compound,
    claim: compound,
    expected: { ...valid, atomic: false },
  },
  {
    name: "split component",
    why: "A faithful asserted component need not preserve the entire compound parent.",
    source,
    parentProposition: compound,
    proposition: inspection,
    claim: inspection,
    expected: valid,
  },
  {
    name: "he does just that",
    why: "One supported action is preserved, but he and that require outside context.",
    source: "Cartman decides to hide the key. He does just that.",
    proposition: "He does just that.",
    claim: "He does just that.",
    expected: { ...valid, standalone: false },
  },
  {
    name: "he does just that resolved",
    why: "The claim explicitly names the actor and action established by the source.",
    source: "Cartman decides to hide the key. He does just that.",
    proposition: "He does just that.",
    claim: "Cartman hides the key.",
    expected: valid,
  },
  {
    name: "all four fail",
    why: "Two unsupported actions replace the selected fact and have unresolved referents.",
    source,
    proposition: delivery,
    claim: "He burned it down, and she stole those.",
    expected: { supported: false, meaning_preserved: false, standalone: false, atomic: false },
  },
];

export const framingCanaries: readonly FramingCanary[] = [
  {
    name: "attributed assertion",
    why: "The source attributes the closure to Mira without adopting it; the claim is the embedded closure, not the act of claiming.",
    sourceTitle: "",
    sourceText:
      "According to Mira, North Depot was closed on 12 March 2024. This account has not been independently verified.",
    claim: "North Depot was closed on 12 March 2024.",
    expected: { epistemic: { source_commitment: "reported" } },
  },
  {
    name: "fictional event",
    why: "The source explicitly establishes a fictional narrative and a completed event.",
    sourceTitle: "The Glass Harbour",
    sourceText:
      "The Glass Harbour is a fictional novel. In its story, Captain Iona destroyed Beacon Bridge.",
    claim: "Captain Iona destroyed Beacon Bridge.",
    expected: {
      world: { layer: "fictional_world" },
      epistemic: { modal_frame: "actual" },
      temporal: { instability: "stable" },
    },
  },
  {
    name: "publication of fiction",
    why: "Publication is a real-world event even when the work is fictional.",
    sourceTitle: "The Glass Harbour",
    sourceText: "The Glass Harbour is a fictional novel published in 2018.",
    claim: "The novel The Glass Harbour was published in 2018.",
    expected: {
      world: { layer: "real_world" },
      epistemic: { modal_frame: "actual" },
      temporal: { instability: "stable" },
    },
  },
  {
    name: "world not established",
    why: "A name and an illustrative sentence alone do not establish a setting.",
    sourceTitle: "",
    sourceText: "Iona opened the gate.",
    claim: "Iona opened the gate.",
    expected: { world: { layer: "undetermined" } },
  },
  {
    name: "completed act of claiming",
    why: "The source asserts the completed act of claiming, not the embedded closure.",
    sourceTitle: "",
    sourceText: "On 12 March 2024, Mira claimed that North Depot was closed.",
    claim: "On 12 March 2024, Mira claimed that North Depot was closed.",
    expected: {
      epistemic: { source_commitment: "asserted", modal_frame: "claim" },
      temporal: { instability: "stable" },
    },
  },
  {
    name: "current state",
    why: "An assertion about the moving present can cease to hold.",
    sourceTitle: "",
    sourceText: "North Depot is currently open.",
    claim: "North Depot is currently open.",
    expected: {
      epistemic: { modal_frame: "actual" },
      temporal: { instability: "mutable" },
    },
  },
  {
    name: "historical event",
    why: "An opening on a fixed date does not change with the present.",
    sourceTitle: "",
    sourceText: "North Depot opened on 12 March 2024.",
    claim: "North Depot opened on 12 March 2024.",
    expected: {
      epistemic: { modal_frame: "actual" },
      temporal: { instability: "stable" },
    },
  },
];
