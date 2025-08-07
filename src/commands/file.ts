import { readFile, writeFile } from "fs/promises";

export async function applyEdit(edit: {
  file: string;
  original: string;
  replacement: string;
  lineNumber: number | null;
}) {
  try {
    let content: string;
    try {
      content = await readFile(edit.file, "utf8");
    } catch (error) {
      // If file doesn't exist, start with empty content
      content = "";
    }

    const lines = content.split("\n");

    // If lineNumber is null, append to the end
    if (edit.lineNumber === null) {
      // If the file is not empty and doesn't end with newline, add one
      if (content && !content.endsWith("\n")) {
        lines.push("");
      }
      lines.push(edit.replacement);
    } else {
      // Replace existing content
      const targetLine = lines[edit.lineNumber - 1];
      if (!targetLine?.includes(edit.original)) {
        throw new Error(
          `Original content not found at specified line in ${edit.file}`
        );
      }
      lines[edit.lineNumber - 1] = targetLine.replace(
        edit.original,
        edit.replacement
      );
    }

    // Ensure file ends with a newline
    const lastLine = lines[lines.length - 1];
    if (lastLine && !lastLine.endsWith("\n")) {
      lines.push("");
    }

    await writeFile(edit.file, lines.join("\n"), "utf8");

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
