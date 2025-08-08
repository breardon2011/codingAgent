import { z } from "zod";

export const proposalSchema = z.object({
  file: z.string(),
  original: z.string(),
  replacement: z.string(),
  lineNumber: z.number().nullable(),
  explanation: z.string(),
});
export type ProposalType = z.infer<typeof proposalSchema>;

export const proposalsSchema = z.array(proposalSchema);
export type ProposalsType = z.infer<typeof proposalsSchema>;

export const editIntentSchema = z
  .object({
    intentType: z.literal("edit"),
    action: z.enum([
      "add_code",
      "modify_code",
      "fix_error",
      "refactor",
      "config_change",
      "shell_command",
      "compound_action",
    ]),
    target: z.string(),
    description: z.string(),
    command: z.string().optional(),
    // Relaxed shape to match typical LLM output (no inner intentType requirement)
    steps: z
      .array(
        z.object({
          action: z.enum(["add_code", "modify_code", "shell_command"]),
          target: z.string(),
          description: z.string(),
          command: z.string().optional(),
        })
      )
      .optional(),
  })
  .strict();
export type EditIntent = z.infer<typeof editIntentSchema>;

export const questionIntentSchema = z
  .object({
    intentType: z.literal("question"),
    question: z.string(),
  })
  .strict();

export const intentSchema = z.discriminatedUnion("intentType", [
  editIntentSchema,
  questionIntentSchema,
]);
export type IntentType = z.infer<typeof intentSchema>;
