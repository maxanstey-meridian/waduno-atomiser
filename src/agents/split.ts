import { taskAgent, type TaskAgent, type ChatClient } from "@maxanstey-meridian/tandem";
import { z } from "zod";
import { DiscoveryOutput, parseApsPropositions } from "./parse-propositions.js";

export const createSplitAgent = (client: ChatClient): TaskAgent<string, DiscoveryOutput> =>
  taskAgent<string, DiscoveryOutput>({
    id: "aps-re-split",
    instructions: "",
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
      parse: parseApsPropositions,
      validateFor: () => [],
    },
  });
