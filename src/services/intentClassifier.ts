import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { intentSchema, type IntentType } from "../domain/intent";
import { logger } from "../utils/logger";

async function callLLM(prompt: string) {
  const result = await generateText({
    model: openai("gpt-4o"),
    prompt,
    temperature: 0,
  });
  return result.text.trim();
}

export async function classifyIntent(
  userPrompt: string,
  context: string
): Promise<IntentType> {
  const baseInstruction = `${context}Classify the user input as either an edit intent or a question.

User input: "${userPrompt}"

Rules:
- If the user wants to modify/add/fix/refactor/configure code or execute shell/terminal commands, classify as EDIT INTENT.
- If the user asks for information/explanations, classify as QUESTION INTENT.
- If the input includes package install phrasing (e.g., "install X", "add X", "setup X") or mentions tools like npm/yarn/pnpm/npx/pip/brew/apt, classify as EDIT with action "shell_command".
- For Node.js tasks, prefer npm by default: npm install <package>.
- For EDIT INTENT, action MUST be one of exactly:
  "add_code" | "modify_code" | "fix_error" | "refactor" | "config_change" | "shell_command" | "compound_action"
- For "shell_command", you MUST include a concrete command string in "command".
- Return ONLY raw JSON. No markdown. No comments.

Few-shot examples:
Input: "install express please"
Output:
{"intentType":"edit","action":"shell_command","target":"project","description":"Install express","command":"npm install express"}

Input: "can you install typescript"
Output:
{"intentType":"edit","action":"shell_command","target":"project","description":"Install TypeScript","command":"npm install typescript"}

Input: "run npm install"
Output:
{"intentType":"edit","action":"shell_command","target":"project","description":"Run npm install","command":"npm install"}

Return exactly one of:
EDIT:
{"intentType":"edit","action":"<one of the above>","target":"...","description":"...","command":"... (required for shell_command)","steps":[...](optional for compound_action)}

QUESTION:
{"intentType":"question","question":"..."}
`;

  // First attempt
  let text = await callLLM(baseInstruction);
  let cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "");
  try {
    const parsed = JSON.parse(cleaned);
    const validated = intentSchema.parse(parsed);
    logger.debug("LLM intent classified", {
      classified: validated.intentType,
      action: validated.intentType === "edit" ? validated.action : "N/A",
    });
    return validated;
  } catch (e: any) {
    // Retry with correction instruction (still LLM-led, no keyword heuristics)
    const correctionPrompt = `${baseInstruction}

Your previous output was invalid or did not match the schema:
${text}

Correct it to valid JSON matching the allowed enum exactly. Return ONLY the corrected JSON object.`;
    const retryText = await callLLM(correctionPrompt);
    const retryCleaned = retryText
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "");
    const parsed = JSON.parse(retryCleaned);
    const validated = intentSchema.parse(parsed);
    logger.debug("LLM intent classified (retry)", {
      classified: validated.intentType,
      action: validated.intentType === "edit" ? validated.action : "N/A",
    });
    return validated;
  }
}
