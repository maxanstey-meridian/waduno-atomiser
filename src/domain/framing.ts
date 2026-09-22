export type WorldFraming = {
  layer: "real_world" | "fictional_world" | "undetermined";
};
export type WorldLayer = WorldFraming["layer"];
export type EpistemicFraming = {
  source_commitment: "asserted" | "reported" | "denied" | "hedged";
  modal_frame:
    | "actual"
    | "belief"
    | "claim"
    | "allegation"
    | "intention"
    | "attempt"
    | "prediction"
    | "possibility"
    | "other";
};
export type SourceCommitment = EpistemicFraming["source_commitment"];
export type ModalFrame = EpistemicFraming["modal_frame"];
export type TemporalFraming = { instability: "stable" | "mutable" };
export type Instability = TemporalFraming["instability"];
export type AtomFraming = {
  world: WorldFraming;
  epistemic: EpistemicFraming;
  temporal: TemporalFraming;
};
export const assembleFraming = (
  worldValue: WorldFraming,
  epistemicValue: EpistemicFraming,
  temporal: TemporalFraming,
): AtomFraming => {
  const world = { ...worldValue };

  if (world.layer === "fictional_world" && temporal.instability !== "stable") {
    throw new Error("fictional-world framing must be stable");
  }

  return { world, epistemic: { ...epistemicValue }, temporal };
};
