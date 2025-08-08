import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

export interface SearchPlan {
  includeGlobs: string[];
  excludeGlobs: string[];
  filenameKeywords: string[];
  contentKeywords: string[];
  newFileCandidates: string[];
}

async function callLLM(prompt: string) {
  const res = await generateText({
    model: openai("gpt-4o"),
    temperature: 0,
    prompt,
  });
  return res.text
    .trim()
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "");
}

export async function planSearch(input: {
  userPrompt: string;
  intent: { action: string; target: string; description: string };
  fileInventorySample: string;
}): Promise<SearchPlan> {
  const { userPrompt, intent, fileInventorySample } = input;

  const prompt = `You are planning a code search strategy for a project.

User input: ${userPrompt}
Intent: ${JSON.stringify(intent)}
Project snapshot (abbreviated):
${fileInventorySample}

Devise a search plan to locate the most relevant files/lines. If files likely do not yet exist, suggest candidate paths to create.

Return ONLY JSON with this exact shape:
{"includeGlobs":[],"excludeGlobs":[],"filenameKeywords":[],"contentKeywords":[],"newFileCandidates":[]}

Guidelines:
- Keep globs simple (e.g., "src/**", "server/**", "**/*.md").
- Exclude tests, fixtures, evaluations when the goal is user-facing behavior.
- Suggest likely filenames from the target/description. Avoid language-specific assumptions.
- Propose newFileCandidates as relative paths only, if creation seems appropriate.
 - Prefer consistent single set of files for scaffolding tasks (e.g., do not suggest duplicate paths for the same file).`;

  const text = await callLLM(prompt);
  let plan: any;
  try {
    plan = JSON.parse(text);
  } catch {
    // conservative fallback
    plan = {};
  }

  return {
    includeGlobs: Array.isArray(plan.includeGlobs) ? plan.includeGlobs : [],
    excludeGlobs: Array.isArray(plan.excludeGlobs)
      ? plan.excludeGlobs
      : [
          "**/__tests__/**",
          "**/*.test.*",
          "**/*.spec.*",
          "**/src/evaluations/**",
          "**/fixtures/**",
          "**/mocks/**",
        ],
    filenameKeywords: Array.isArray(plan.filenameKeywords)
      ? plan.filenameKeywords
      : [],
    contentKeywords: Array.isArray(plan.contentKeywords)
      ? plan.contentKeywords
      : [],
    newFileCandidates: Array.isArray(plan.newFileCandidates)
      ? plan.newFileCandidates
      : [],
  };
}
