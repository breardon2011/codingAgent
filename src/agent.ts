import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import dotenv from "dotenv";
import { readFile, writeFile } from "fs/promises";
import { conversationHistory } from "./utils/conversationHistory";
import { logger } from "./utils/logger";
import { executeShellCommand, isCommandSafe } from "./commands/shell";

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

// Update the action enum to include shell commands
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
      "compound_action", // Add this new action type
    ]),
    target: z.string(),
    description: z.string(),
    command: z.string().optional(),
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

export async function extractIntentWithContext(
  prompt: string
): Promise<IntentType> {
  const context = conversationHistory.getContextForPrompt();

  try {
    const result = await generateText({
      model: openai("gpt-4o"),
      prompt: `${context}Analyze this user input and classify it as either an edit intent or a question.

User input: "${prompt}"

Classification rules:
1. EDIT INTENT if the user wants to:
   - Modify, add, remove, or change code/files
   - Fix errors or issues  
   - Implement features or functionality
   - Refactor or improve code
   - Configure settings or files
   - Execute shell/terminal commands
   - Uses phrases like: "can you edit", "please add", "fix this", "change the", "update", "implement", "make it so"
   - Command-like requests: "install", "run", "build", "start", "deploy", "test"

   For compound actions that require multiple steps (like "add a web server"):
   - Use action: "compound_action"
   - Include steps array with each required step
   - Example:
     {
       "intentType": "edit",
       "action": "compound_action",
       "target": "project",
       "description": "Add web server",
       "steps": [
         {
           "action": "shell_command",
           "target": "terminal",
           "description": "Install express",
           "command": "pnpm add express"
         },
         {
           "action": "add_code",
           "target": "src/api_server.ts",
           "description": "Create web server file"
         }
       ]
     }

2. QUESTION INTENT if the user wants to:
   - Understand how something works
   - Get explanations or information
   - Ask about concepts or processes

Return JSON:
EDIT: {"intentType": "edit", "action": "...", "target": "...", "description": "...", "steps": [...]}
QUESTION: {"intentType": "question", "question": "..."}

IMPORTANT: Return ONLY raw JSON, no markdown, no backticks.`,
    });

    const cleaned = result.text
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    const parsed = JSON.parse(cleaned);
    const validated = intentSchema.parse(parsed);

    // Log the classification for debugging
    logger.debug("Intent classification", {
      input: prompt,
      classified: validated.intentType,
      action: validated.intentType === "edit" ? validated.action : "N/A",
    });

    return validated;
  } catch (error) {
    console.error("Intent extraction error:", error);
    logger.warn("Defaulting to question intent due to extraction error");
    return {
      intentType: "question",
      question: prompt,
    };
  }
}

export async function proposeEditWithContext(
  intent: IntentType,
  match: any
): Promise<ProposalType> {
  const context = conversationHistory.getContextForPrompt();
  const relatedChanges = conversationHistory.getRelatedChanges(match.file);

  let contextPrompt = context;
  if (relatedChanges.length > 0) {
    contextPrompt += `\nRecent changes to ${match.file}:\n`;
    relatedChanges.slice(-3).forEach((change) => {
      contextPrompt += `- ${change.userInput} → ${change.outcome}\n`;
    });
  }

  // Type guard to ensure we have an edit intent
  if (intent.intentType !== "edit") {
    throw new Error(
      "proposeEditWithContext can only be called with edit intents"
    );
  }

  try {
    const result = await generateText({
      model: openai("gpt-4o"),
      prompt: `${contextPrompt}Generate a code change proposal based on this request.

User Intent: ${JSON.stringify(intent)}
Code Match: ${JSON.stringify(match)}

Create a specific, actionable code change proposal. Consider whether this requires:
- Creating a new file (original: "", lineNumber: null)
- Modifying existing code (original: current code, lineNumber: specific line)
- Adding to existing file (choose appropriate location)

Return JSON with this exact structure:
{
  "file": "path/to/target/file",
  "original": "code to replace OR empty string for new files", 
  "replacement": "new code content",
  "lineNumber": number_or_null,
  "explanation": "clear explanation of the change"
}

IMPORTANT: Return ONLY the JSON object, no markdown, no backticks.`,
    });

    const cleaned = result.text
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    logger.debug("Raw AI response", { response: cleaned });

    const parsed = JSON.parse(cleaned);
    return proposalSchema.parse(parsed);
  } catch (error) {
    console.error("Proposal generation error:", error);
    logger.error("Failed to generate proposal", { error, intent, match });
    throw error;
  }
}

export async function reviseProposal(
  feedback: string,
  intent: IntentType,
  match: any
) {
  // Type guard to ensure we have an edit intent
  if (intent.intentType !== "edit") {
    throw new Error("reviseProposal can only be called with edit intents");
  }

  try {
    const result = await generateText({
      model: openai("gpt-4o"),
      prompt: `Revise the code change based on this user feedback: "${feedback}"

Original Intent: ${JSON.stringify(intent)}
Code Match: ${JSON.stringify(match)}

The user wants you to modify the proposal based on their feedback. Generate a revised code change that incorporates their suggestions.

Return JSON with this exact structure:
{
  "file": "path/to/target/file",
  "original": "code to replace OR empty string for new files", 
  "replacement": "revised code content",
  "lineNumber": number_or_null,
  "explanation": "explanation of the revision"
}

IMPORTANT: Return ONLY the JSON object, no markdown, no backticks, no explanatory text.`,
    });

    const cleaned = result.text
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    logger.debug("Raw revision response", { response: cleaned });

    const parsed = JSON.parse(cleaned);
    return proposalSchema.parse(parsed);
  } catch (error) {
    console.error("Revision generation error:", error);
    logger.error("Failed to generate revision", {
      error,
      feedback,
      intent,
      match,
    });
    throw error;
  }
}

export async function chatFallback(prompt: string) {
  const result = await generateText({
    model: openai("gpt-4o"),
    prompt,
  });
  return result.text;
}

export async function executeCommand(intent: IntentType) {
  if (
    intent.intentType !== "edit" ||
    intent.action !== "shell_command" ||
    !intent.command
  ) {
    throw new Error("Invalid shell command intent");
  }

  // Check if the command is safe to execute
  const safetyCheck = isCommandSafe(intent.command);
  if (!safetyCheck.safe) {
    throw new Error(`Unsafe command: ${safetyCheck.reason}`);
  }

  // Execute the command
  const result = await executeShellCommand(intent.command, {
    interactive: true, // Use interactive mode for better output handling
    timeout: 60000, // Increase timeout for package installations
  });

  if (result.exitCode !== 0) {
    throw new Error(`Command failed: ${result.stderr || result.stdout}`);
  }

  return result;
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
