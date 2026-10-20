import type { Pipeline } from "@maxanstey-meridian/tandem";
import type { AtomisationState } from "./state.js";

export type AtomiserPipelines = {
  readonly passage: Pipeline<AtomisationState>;
  readonly item: Pipeline<AtomisationState>;
};
