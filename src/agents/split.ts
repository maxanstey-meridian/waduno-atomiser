import { taskAgent, type TaskAgent, type ChatClient } from "@maxanstey-meridian/tandem";
import { z } from "zod";
import { DiscoveryOutput, parsePropositions } from "./parse-propositions.js";

/**
 * Asks for a claim's atomic propositions in Gemma-APS's output format, which a general model
 * produces only when told to.
 */
export const SPLIT_INSTRUCTIONS =
  "Split the user's sentence into its atomic propositions: each a standalone, self-contained " +
  "factual statement that keeps the original wording where possible and repeats names instead " +
  "of pronouns. Reply with the line PROPOSITIONS: and then one proposition per line, each " +
  "starting with '- '. Nothing else. Plain text: no markdown, and keep the sentence's own " +
  "quotation marks.";

export const createSplitAgent = (client: ChatClient): TaskAgent<string, DiscoveryOutput> =>
  taskAgent<string, DiscoveryOutput>({
    id: "re-split",
    instructions: SPLIT_INSTRUCTIONS,
    client,
    input: z.string(),
    result: DiscoveryOutput,
    reasoning: { effort: "none" },
    temperature: 0,
    maxOutputTokens: 2048,
    message: (proposition) => proposition,
    output: {
      instructions: "",
      raw: true,
      parse: parsePropositions,
      validateFor: () => [],
    },
  });
