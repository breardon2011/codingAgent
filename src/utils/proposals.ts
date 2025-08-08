import path from "path";
import crypto from "crypto";
import type { ProposalType } from "../domain/intent";

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Removes exact duplicate proposals based on file, lineNumber, original, and replacement.
 * Keeps the first occurrence and preserves original order for non-duplicates.
 */
export function dedupeProposals(proposals: ProposalType[]): ProposalType[] {
  const seen = new Set<string>();
  const result: ProposalType[] = [];
  for (const p of proposals) {
    const fileKey = path.resolve(p.file);
    const ln = p.lineNumber === null ? "null" : String(p.lineNumber);
    const key = `${fileKey}|${ln}|${sha256(p.original || "")}|${sha256(
      p.replacement || ""
    )}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(p);
  }
  return result;
}
