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
 - If the input includes package install phrasing (e.g., "install X", "add X", "setup X") or mentions tools like npm/yarn/pnpm/npx/pip/brew/apt, classify as EDIT with action "shell_command".
 - If the user requests navigation or changing directories (e.g., "cd to X", "navigate to Y", "go to Z"), classify as EDIT with action "shell_command" and put the command as: cd <path>.
- For Node.js tasks, prefer npm by default: npm install <package>.
- If the task involves multiple files or a sequence of actions, use action "compound_action".
 - For EDIT INTENT, action MUST be one of exactly:
  "add_code" | "modify_code" | "fix_error" | "refactor" | "config_change" | "shell_command" | "compound_action"
- For "shell_command", you MUST include a concrete command string in "command".
 - IMPORTANT: Avoid duplicate file edits. Do not propose two edits that target the same file with the same content. Prefer consolidating into a single proposal per file, unless they clearly refer to different lineNumber positions.
- For "compound_action", "steps" MUST be an array of objects with this exact shape:
  { "action":"add_code"|"modify_code"|"shell_command", "target":string, "description":string, "command"?:string }
  Do NOT return steps as strings.
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

Input: "cd ~/development/my-app"
Output:
{"intentType":"edit","action":"shell_command","target":"project","description":"Change directory","command":"cd ~/development/my-app"}

Input: "go to ../services/server"
Output:
{"intentType":"edit","action":"shell_command","target":"project","description":"Change directory","command":"cd ../services/server"}

Input: "create a folder server with a basic node server.js and an index.html; index route / serves the file and a healthcheck route"
Output:
{"intentType":"edit","action":"compound_action","target":"server","description":"Create a basic Node.js HTTP server and index page","steps":[
  {"action":"add_code","target":"server/server.js","description":"Create HTTP server with index route and /healthcheck"},
  {"action":"add_code","target":"server/index.html","description":"Create Hello World HTML page"}
]}

Return exactly one of:
EDIT:
{"intentType":"edit","action":"<one of the above>","target":"...","description":"...","command":"... (required for shell_command)","steps":[...](only for compound_action)}

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

Correct it to valid JSON matching the allowed enums exactly.
If you returned "steps" as strings, rewrite them as an array of step objects with shape:
{"action":"add_code"|"modify_code"|"shell_command","target":string,"description":string,"command"?:string}
Return ONLY the corrected JSON object, with no markdown fences or commentary.`;
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
