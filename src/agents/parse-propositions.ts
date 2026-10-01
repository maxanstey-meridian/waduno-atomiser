import { z } from "zod";
export const SplitOutput = z.strictObject({
  items: z.array(z.strictObject({ proposition: z.string().min(1) })).readonly(),
});
export type SplitOutput = z.infer<typeof SplitOutput>;

export const parsePropositions = (response: string): SplitOutput => {
  const items: { proposition: string }[] = [];
  let header = false;
  for (const raw of response.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      continue;
    }
    if (line === "PROPOSITIONS:" && !header && items.length === 0) {
      header = true;
      continue;
    }
    if (!line.startsWith("- ") || line.slice(2).trim() === "") {
      throw new Error("The splitter returned malformed proposition output.");
    }
    items.push({ proposition: line.slice(2).trim() });
  }
  if (!header && items.length === 0) {
    throw new Error("The splitter returned no proposition output.");
  }
  return { items };
};
