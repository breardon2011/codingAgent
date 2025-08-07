import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import dotenv from "dotenv";
import { readFile, writeFile } from "fs/promises";

// Load environment variables from .env file
dotenv.config();

// Define the proposal schema type
export const proposalSchema = z.object({
  file: z.string(),
  original: z.string(),
  replacement: z.string(),
  lineNumber: z.number().nullable(),
  explanation: z.string(),
});

export type ProposalType = z.infer<typeof proposalSchema>;

export const editIntentSchema = z
  .object({
    intentType: z.literal("edit"),
    action: z.enum([
      "add_code", // For new additions
      "modify_code", // For changes to existing code
      "fix_error", // For error fixes
      "refactor", // For restructuring
      "config_change", // For configuration updates
    ]),
    target: z.string(),
    description: z.string(),
    // Remove newName as it's too specific
  })
  .strict();

const questionIntentSchema = z
  .object({
    intentType: z.literal("question"),
    question: z.string(),
  })
  .strict();

const intentSchema = z.discriminatedUnion("intentType", [
  editIntentSchema,
  questionIntentSchema,
]);

export type IntentType = z.infer<typeof intentSchema>;

export async function extractIntent(prompt: string): Promise<IntentType> {
  try {
    const result = await generateText({
      model: openai("gpt-4o"),
      prompt: `Generate a JSON object classifying this input: "${prompt}"

IMPORTANT: Return ONLY a raw JSON object, no markdown, no backticks.

For edits use:
{"intentType": "edit", "action": "add_code" | "modify_code" | "fix_error" | "refactor" | "config_change", "target": "file", "description": "what to do"}

For questions use:
{"intentType": "question", "question": "the query"}

Example:
Input: "Add .pyc to gitignore"
Output: {"intentType": "edit", "action": "config_change", "target": ".gitignore", "description": "add .pyc files to gitignore"}`,
    });

    const cleaned = result.text
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    const parsed = JSON.parse(cleaned);
    return intentSchema.parse(parsed);
  } catch (error) {
    console.error("Intent extraction error:", error);
    if (error instanceof Error) {
      console.error("Error details:", error.message);
    }
    return {
      intentType: "question",
      question: prompt,
    };
  }
}

export async function proposeEdit(
  intent: IntentType,
  match: any
): Promise<ProposalType> {
  try {
    const result = await generateText({
      model: openai("gpt-4o"),
      prompt: `Generate a code change proposal as a JSON object.

IMPORTANT: Return ONLY a raw JSON object, no markdown, no backticks.

For appending to files like .gitignore, use:
{"file": ".gitignore", "original": "", "replacement": "*.pyc", "lineNumber": null, "explanation": "why"}

For modifying existing code, use:
{"file": "path/to/file", "original": "existing code", "replacement": "new code", "lineNumber": 123, "explanation": "why"}

Context:
${JSON.stringify({ intent, match }, null, 2)}`,
    });

    const cleaned = result.text
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    const parsed = JSON.parse(cleaned);
    return proposalSchema.parse(parsed);
  } catch (error) {
    console.error("Proposal generation error:", error);
    throw error;
  }
}

export async function reviseProposal(
  feedback: string,
  intent: IntentType,
  match: any
) {
  const result = await generateText({
    model: openai("gpt-4o"),
    prompt: `Revise the previous code change based on this feedback: "${feedback}".\nIntent: ${JSON.stringify(
      intent
    )}.\nMatch: ${JSON.stringify(match)}.`,
  });
  return JSON.parse(result.text);
}

export async function chatFallback(prompt: string) {
  const result = await generateText({
    model: openai("gpt-4o"),
    prompt,
  });
  return result.text;
}

export async function applyEdit(edit: {
  file: string;
  original: string;
  replacement: string;
  lineNumber: number | null;
}) {
  try {
    let content: string;
    try {
      content = await readFile(edit.file, "utf8");
    } catch (error) {
      // If file doesn't exist, start with empty content
      content = "";
    }

    const lines = content.split("\n");

    // If lineNumber is null, append to the end
    if (edit.lineNumber === null) {
      // If the file is not empty and doesn't end with newline, add one
      if (content && !content.endsWith("\n")) {
        lines.push("");
      }
      lines.push(edit.replacement);
    } else {
      // Replace existing content
      const targetLine = lines[edit.lineNumber - 1];
      if (!targetLine?.includes(edit.original)) {
        throw new Error(
          `Original content not found at specified line in ${edit.file}`
        );
      }
      lines[edit.lineNumber - 1] = targetLine.replace(
        edit.original,
        edit.replacement
      );
    }

    // Ensure file ends with a newline
    const lastLine = lines[lines.length - 1];
    if (lastLine && !lastLine.endsWith("\n")) {
      lines.push("");
    }

    await writeFile(edit.file, lines.join("\n"), "utf8");

    console.log(
      `✅ Change applied to ${edit.file}${
        edit.lineNumber ? ` at line ${edit.lineNumber}` : ""
      }`
    );
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to apply edit: ${error.message}`);
    }
    throw error;
  }
}
