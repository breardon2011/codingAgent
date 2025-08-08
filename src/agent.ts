import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import dotenv from "dotenv";
import { readFile, writeFile, mkdir } from "fs/promises";
import { conversationHistory } from "./utils/conversationHistory";
import { logger } from "./utils/logger";
import { executeShellCommand, isCommandSafe } from "./commands/shell";
import { getFileReference } from "./utils/fileReference";
import path from "path";
import crypto from "crypto";
import {
  proposalSchema,
  type ProposalType,
  type IntentType,
} from "./domain/intent";
import { classifyIntent } from "./services/intentClassifier";

// Re-export types for test imports
export type { ProposalType, IntentType } from "./domain/intent";

// Load environment variables from .env file
dotenv.config();

export async function extractIntentWithContext(
  prompt: string
): Promise<IntentType> {
  const context = conversationHistory.getContextForPrompt();

  try {
    return await classifyIntent(prompt, context);
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
): Promise<ProposalType[]> {
  const context = conversationHistory.getContextForPrompt();
  const relatedChanges = conversationHistory.getRelatedChanges(match.file);

  let contextPrompt = context;
  if (relatedChanges.length > 0) {
    contextPrompt += `\nRecent changes to ${match.file}:\n`;
    relatedChanges.slice(-3).forEach((change) => {
      contextPrompt += `- ${change.userInput} → ${change.outcome}\n`;
    });
  }

  if (intent.intentType !== "edit") {
    throw new Error(
      "proposeEditWithContext can only be called with edit intents"
    );
  }

  try {
    /* ── NEW: attach a file reference for the full file that matched ── */
    let fileRef = "";
    try {
      const full = await readFile(match.file, "utf8");
      fileRef = await getFileReference(full);
    } catch {
      /* ignore – best effort */
    }

    const result = await generateText({
      model: openai("gpt-4o"),
      prompt: `${contextPrompt}Generate code change proposals based on this request.

User Intent: ${JSON.stringify(intent)}
Code Match: ${JSON.stringify(match)}
File Reference: ${fileRef}

Create specific, actionable code change proposals. Consider whether this requires:
- Creating new files (original: "", lineNumber: null)
- Modifying existing code (original: current code, lineNumber: specific line)
- Adding to existing file (choose appropriate location)

Important:
- Propose edits ONLY for the current target file relevant to this match: ${
        match.file
      }.
- Do NOT propose duplicates for the same file.

Return ONLY raw JSON as ONE proposal object for this step, unless multiple edits in THIS SAME file are absolutely necessary (e.g., different lineNumber blocks). Prefer a single consolidated proposal per file.

Each proposal must have exactly:
{
  "file": "path/to/target/file",
  "original": "code to replace OR empty string for new files", 
  "replacement": "new code content",
  "lineNumber": number_or_null,
  "explanation": "clear explanation of the change"
}`,
    });

    const cleaned = result.text
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    logger.debug("Raw AI response", { response: cleaned });

    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      // Even if the model returns an array, keep only proposals for the match.file
      const filtered = parsed.filter((p: any) => p && p.file === match.file);
      const arr = (filtered.length ? filtered : parsed).map((p: any) =>
        proposalSchema.parse(p)
      );
      return arr;
    }
    return [proposalSchema.parse(parsed)];
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
): Promise<ProposalType[]> {
  if (intent.intentType !== "edit") {
    throw new Error("reviseProposal can only be called with edit intents");
  }

  try {
    let fileRef = "";
    try {
      const full = await readFile(match.file, "utf8");
      fileRef = await getFileReference(full);
    } catch {}

    const result = await generateText({
      model: openai("gpt-4o"),
      prompt: `Revise the code change(s) based on this user feedback: "${feedback}"

Original Intent: ${JSON.stringify(intent)}
Code Match: ${JSON.stringify(match)}
File Reference: ${fileRef}

Revise only the proposal for this same target file: ${
        match.file
      }. Do NOT introduce new files here.

Return ONLY raw JSON, either an array of proposals or a single proposal. Each proposal must have:
{
  "file": "path/to/target/file",
  "original": "code to replace OR empty string for new files", 
  "replacement": "revised code content",
  "lineNumber": number_or_null,
  "explanation": "explanation of the revision"
}`,
    });

    const cleaned = result.text
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    logger.debug("Raw revision response", { response: cleaned });

    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed.map((p: any) => proposalSchema.parse(p));
    }
    return [proposalSchema.parse(parsed)];
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
    const projectRoot = process.cwd();
    if (!path.resolve(edit.file).startsWith(projectRoot)) {
      throw new Error("Edit path escapes project root");
    }

    let content: string;
    try {
      content = await readFile(edit.file, "utf8");
    } catch {
      content = "";
    }

    let newContent: string;

    if (edit.lineNumber === null) {
      // simple append
      const needsNl = content && !content.endsWith("\n") ? "\n" : "";
      newContent = content + needsNl + edit.replacement + "\n";
    } else {
      // targeted replace; fall back to whole-file diff when multi-line
      const lines = content.split("\n");
      const targetLine = lines[edit.lineNumber - 1];

      if (targetLine && targetLine.includes(edit.original)) {
        lines[edit.lineNumber - 1] = targetLine.replace(
          edit.original,
          edit.replacement
        );
        newContent = lines.join("\n");
      } else {
        const idx = content.indexOf(edit.original);
        if (idx === -1) {
          throw new Error("Original snippet not found in file");
        }
        newContent =
          content.slice(0, idx) +
          edit.replacement +
          content.slice(idx + edit.original.length);
      }
    }

    // Ensure destination directory exists for new files/nested paths
    await mkdir(path.dirname(edit.file), { recursive: true });

    await writeFile(edit.file, newContent, "utf8");

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

export async function applyEdits(edits: ProposalType[]) {
  for (const e of edits) {
    await applyEdit(e);
  }
}
function sha256(text: string) {
  return crypto.createHash("sha256").update(text).digest("hex");
}
