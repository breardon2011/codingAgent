import { readdir, readFile } from "fs/promises";
import path from "path";

export async function searchCodebase(
  keyword: string
): Promise<{ file: string; line: string; lineNumber: number }[]> {
  const cwd = process.cwd();
  const files = await getAllFiles(cwd);
  const matches: any[] = [];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    const lines = content.split("\n");
    lines.forEach((line, idx) => {
      if (line.includes(keyword)) {
        matches.push({ file, line, lineNumber: idx + 1 });
      }
    });
  }

  return matches;
}

async function getAllFiles(dir: string): Promise<string[]> {
  const dirents = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    dirents.map((d) =>
      d.isDirectory()
        ? getAllFiles(path.join(dir, d.name))
        : d.name.endsWith(".ts") ||
          d.name.endsWith(".js") ||
          d.name.endsWith(".py") ||
          d.name.endsWith(".java") ||
          d.name.endsWith(".cpp") ||
          d.name.endsWith(".json") ||
          d.name.endsWith(".md") // update as needed
        ? [path.join(dir, d.name)]
        : []
    )
  );
  return files.flat();
}
