import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import path from "path";
import { logger } from "../utils/logger";
import { inlineOrRef } from "../utils/fileReference";
import type { ProposalType } from "../domain/intent";

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

const MAX_CHARS = 18000;

function chunkProposals(proposals: ProposalType[]): ProposalType[][] {
  const chunks: ProposalType[][] = [];
  let current: ProposalType[] = [];
  let size = 0;

  for (const p of proposals) {
    const pSize =
      (p.file?.length || 0) +
      (p.original?.length || 0) +
      (p.replacement?.length || 0) +
      (p.explanation?.length || 0) +
      64;

    if (size + pSize > MAX_CHARS && current.length) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(p);
    size += pSize;
  }

  if (current.length) chunks.push(current);
  return chunks;
}

function preflight(edit: ProposalType): ValidationResult | null {
  const projectRoot = process.cwd();
  const resolved = path.resolve(edit.file);

  if (!resolved.startsWith(projectRoot)) {
    return {
      isValid: false,
      errors: [`File path escapes project root: ${edit.file}`],
      warnings: [],
    };
  }

  const dangerous = ["rm -rf", "sudo", "DELETE FROM", "DROP TABLE"];
  const hit = dangerous.find((d) =>
    (edit.replacement || "").toLowerCase().includes(d.toLowerCase())
  );
  if (hit) {
    return {
      isValid: false,
      errors: [`Potentially dangerous operation detected: ${hit}`],
      warnings: [],
    };
  }

  return null;
}

async function callLLM(proposals: ProposalType[]): Promise<ValidationResult[]> {
  const prepared = await Promise.all(
    proposals.map(async (p) => ({
      ...p,
      replacement: await inlineOrRef(p.replacement, 800),
      original: await inlineOrRef(p.original, 800),
    }))
  );

  const prompt = `You are a strict but pragmatic code change validator. You are given an array of proposed file edits. Review each proposal for internal consistency and obvious mistakes. Do NOT rewrite code; just validate.

Return ONLY a JSON array where each element corresponds to the input proposal at the same index and has this exact shape:
{"isValid":boolean,"errors":string[],"warnings":string[]}

Validation guidelines:
- Check that "file" looks like a project path (no traversal like ../).
- If "lineNumber" is provided and "original" is empty, warn that location might be ambiguous.
- If "original" is non-empty but not likely to be found verbatim in the target file, warn (best-effort).
 - For JSON or config-looking changes, if content seems malformed, mark invalid.
- Flag obviously dangerous or destructive code/content if any slipped through.
- Prefer warnings over hard failures unless it's clearly unsafe or malformed.
- IMPORTANT: Do not mark new-file boilerplate as invalid. Minimal yet complete HTML documents, simple Node.js HTTP servers, or similar scaffolding are acceptable and should be VALID. If content appears short but plausible, WARN instead of failing.
- Do not reject for being "placeholder" unless the content is literally empty or contains obvious placeholders like "TODO", "...", or "<placeholder>" without substantive code.
 - Allow example/demo content (e.g., "Hello World", sample endpoints, example text) as VALID. At most emit a warning that it's example content. Do NOT fail proposals solely for being examples.

Proposals:
${JSON.stringify(prepared, null, 2)}
`;

  const result = await generateText({
    model: openai("gpt-4o"),
    prompt,
  });

  const cleaned = result.text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return parsed as ValidationResult[];
  } catch {
    logger.error("LLM validation parse error", { text: cleaned });
    return proposals.map(() => ({
      isValid: true,
      errors: [],
      warnings: ["Validator failed to parse response; proceed with caution"],
    }));
  }
}

export async function validateProposals(
  proposals: ProposalType[]
): Promise<ValidationResult[]> {
  const FALLBACK: ValidationResult = {
    isValid: true,
    errors: [],
    warnings: ["Validator returned no result; proceed with caution"],
  };

  const results: (ValidationResult | null)[] = proposals.map(preflight);
  const indicesForLLM: number[] = [];
  const toLLM: ProposalType[] = [];

  proposals.forEach((p, i) => {
    if (!results[i]) {
      indicesForLLM.push(i);
      toLLM.push(p);
    }
  });

  if (toLLM.length === 0) {
    return results.map((r) => r ?? FALLBACK);
  }

  const chunks = chunkProposals(toLLM);
  const chunkResults: ValidationResult[][] = [];
  for (const chunk of chunks) {
    const r = await callLLM(chunk);
    chunkResults.push(r);
  }
  const flat = chunkResults.flat();

  indicesForLLM.forEach((idx, pos) => {
    results[idx] = flat[pos] ?? FALLBACK;
  });

  return results.map((r) => r ?? FALLBACK);
}
