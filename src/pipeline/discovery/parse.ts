import { z } from "zod";
export const DiscoveryOutput = z.strictObject({
  items: z.array(z.strictObject({ proposition: z.string().min(1) })).readonly(),
});
export type DiscoveryOutput = z.infer<typeof DiscoveryOutput>;

export const parseApsPropositions = (response: string): DiscoveryOutput => {
  const items: { proposition: string }[] = [];
  let header = false;
  for (const raw of response.split("\n")) {
    const line = raw.trim();
    if (line === "" || line === "<s>" || line === "</s>" || line === "- </s>") {
      continue;
    }
    if (line === "PROPOSITIONS:" && !header && items.length === 0) {
      header = true;
      continue;
    }
    if (!line.startsWith("- ") || line.slice(2).trim() === "") {
      throw new Error("APS returned malformed proposition output.");
    }
    items.push({ proposition: line.slice(2).trim() });
  }
  if (!header && items.length === 0) {
    throw new Error("APS returned no proposition output.");
  }
  return { items };
};
