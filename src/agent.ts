import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import "dotenv/config";

export async function callAgent(prompt: string): Promise<string> {
  const result = await generateText({
    model: openai("gpt-4"),
    prompt,
  });
  return result.text;
}
