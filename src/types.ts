import { z } from 'zod';

export const InstructionsSchema = z.string().brand<'Instructions'>();
export type Instructions = z.infer<typeof InstructionsSchema>;

export const DataRegexSchema = z.string().brand<'DataRegex'>();
export type DataRegex = z.infer<typeof DataRegexSchema>;

export const ScriptIdSchema = z.string().brand<'ScriptId'>();
export type ScriptId = z.infer<typeof ScriptIdSchema>;

export const MetadataSchema = z.object({
  instructionsToRegexToScriptId: z.record(
    z.string(),
    z.record(z.string(), z.string())
  ),
});
export type Metadata = z.infer<typeof MetadataSchema>;