import { SourceEnvelope } from "../../src/contracts/source.js";
import type { ExamplePassage } from "./passages.js";

export const sourceEnvelope = (passage: ExamplePassage): SourceEnvelope =>
  SourceEnvelope.parse({
    id: `urn:example:source:${passage.id}`,
    version: "1",
    title: passage.title,
    text: passage.text,
    kind: "paragraph",
    context: { sectionPath: [], leadIn: null },
    passages: [
      {
        passageId: `urn:example:passage:${passage.id}`,
        blockId: `urn:example:block:${passage.id}`,
        text: passage.text,
      },
    ],
  });
