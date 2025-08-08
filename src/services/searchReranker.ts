import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

export async function rerankMatches(
  candidates: Array<{ file: string; line: string; lineNumber: number }>,
  query: string
): Promise<number[]> {
  const items = candidates.slice(0, 30).map((c, i) => ({
    i,
    file: c.file,
    line: c.line.slice(0, 200),
  }));

  const prompt = `Score each item from 0 to 1 for relevance to: "${query}".
Return ONLY a JSON array of numbers in the same order as input.

Items:
${JSON.stringify(items, null, 2)}`;

  try {
    const res = await generateText({
      model: openai("gpt-4o"),
      temperature: 0,
      prompt,
    });
    const cleaned = res.text
      .trim()
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "");
    const arr = JSON.parse(cleaned);
    if (Array.isArray(arr)) {
      return items.map((_, idx) =>
        typeof arr[idx] === "number" ? arr[idx] : 0
      );
    }
  } catch {}
  return items.map(() => 0.5);
}
