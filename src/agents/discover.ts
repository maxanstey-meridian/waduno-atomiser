import { agent, type ChatClient, type Agent } from "@maxanstey-meridian/tandem";
import { ATOMIZATION_VERSION, type AtomizationOutput } from "../contracts/atomise.js";
import type { AtomisationState } from "../pipeline/state.js";
import type { DiscoveryOutput } from "./parse-propositions.js";
import { parseApsPropositions } from "./parse-propositions.js";

export const createDiscoveryAgent = (apsClient: ChatClient): Agent<AtomisationState> =>
  agent<AtomisationState, DiscoveryOutput>({
    id: "aps-discovery",
    instructions: "",
    client: apsClient,
    reasoning: { effort: "none" },
    temperature: 0,
    maxOutputTokens: 2048,
    message: (state) => state.source.text,
    output: {
      instructions: "",
      raw: true,
      parse: parseApsPropositions,
      validateFor: () => [],
      apply: (state, value) => ({
        ...state,
        working: {
          phase: "discovered",
          items: value.items.map((item, discoveryIndex) => ({
            discoveryIndex,
            proposition: item.proposition.trim(),
          })),
        },
        output: value.items.length === 0 ? noPropositionsOutput() : null,
      }),
    },
  });

export const noPropositionsOutput = (): AtomizationOutput => ({
  atomizationVersion: ATOMIZATION_VERSION,
  status: "no_propositions",
  atoms: [],
  candidateRejections: [],
});
