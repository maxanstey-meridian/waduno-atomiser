import { z } from "zod";

export const SourcePassage = z
  .strictObject({
    passageId: z.string().min(1),
    blockId: z.string().min(1),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
    text: z.string().min(1),
  })
  .refine((p) => p.endOffset - p.startOffset === [...p.text].length, {
    message: "Passage offsets must count Unicode code points",
  });
export type SourcePassage = z.infer<typeof SourcePassage>;

export const SourceEnvelope = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  title: z.string(),
  text: z.string().min(1),
  kind: z.string().min(1),
  context: z.strictObject({ sectionPath: z.array(z.string()), leadIn: z.string().nullable() }),
  passages: z.array(SourcePassage).min(1).readonly(),
});
export type SourceEnvelope = z.infer<typeof SourceEnvelope>;
