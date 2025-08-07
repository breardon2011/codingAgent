import { readFile, writeFile } from "fs/promises";

export async function readFileContent(path: string) {
  return await readFile(path, "utf8");
}

export async function writeFileContent(path: string, content: string) {
  await writeFile(path, content, "utf8");
}
