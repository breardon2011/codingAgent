import { readFile } from "fs/promises";
import path from "path";

interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

export async function validateEdit(edit: {
  file: string;
  original: string;
  replacement: string;
  lineNumber: number | null;
}): Promise<ValidationResult> {
  const result: ValidationResult = {
    isValid: true,
    errors: [],
    warnings: [],
  };

  try {
    // Check if file exists and is readable
    if (edit.lineNumber !== null) {
      try {
        await readFile(edit.file, "utf8");
      } catch (error) {
        result.errors.push(
          `File ${edit.file} does not exist or is not readable`
        );
        result.isValid = false;
        return result;
      }
    }

    // File type specific validation
    const fileType = getFileType(edit.file);

    switch (fileType) {
      case "javascript":
        validateJavaScript(edit, result);
        break;
      case "python":
        validatePython(edit, result);
        break;
      case "config":
        validateConfig(edit, result);
        break;
      case "json":
        validateJson(edit, result);
        break;
    }

    // Generic safety checks
    validateSafetyChecks(edit, result);
  } catch (error) {
    result.errors.push(
      `Validation error: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
    result.isValid = false;
  }

  return result;
}

function getFileType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath).toLowerCase();

  if (
    fileName.includes("config") ||
    fileName === ".gitignore" ||
    fileName === ".env"
  ) {
    return "config";
  }

  if ([".ts", ".js", ".tsx", ".jsx"].includes(ext)) {
    return "javascript";
  }

  if (ext === ".py") {
    return "python";
  }

  if (ext === ".json") {
    return "json";
  }

  return "unknown";
}

function validateJavaScript(edit: any, result: ValidationResult): void {
  // Check for basic syntax issues
  const code = edit.replacement;

  // Check for unmatched brackets
  const brackets = { "{": "}", "[": "]", "(": ")" };
  const stack: string[] = [];

  for (const char of code) {
    if (Object.keys(brackets).includes(char)) {
      stack.push(char);
    } else if (Object.values(brackets).includes(char)) {
      const last = stack.pop();
      if (!last || brackets[last as keyof typeof brackets] !== char) {
        result.errors.push("Unmatched brackets detected");
        result.isValid = false;
        break;
      }
    }
  }

  if (stack.length > 0) {
    result.errors.push("Unclosed brackets detected");
    result.isValid = false;
  }

  // Check for common syntax patterns
  if (
    code.includes("import") &&
    !code.includes("from") &&
    !code.includes("require")
  ) {
    result.warnings.push("Import statement may be incomplete");
  }
}

function validatePython(edit: any, result: ValidationResult): void {
  const code = edit.replacement;

  // Check indentation (basic)
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() && line.match(/^[^ \t]/)) {
      // Line starts without indentation - check if it should
      const prevLine = lines[i - 1];
      if (prevLine && prevLine.trim().endsWith(":")) {
        result.warnings.push(`Line ${i + 1} may need indentation`);
      }
    }
  }
}

function validateConfig(edit: any, result: ValidationResult): void {
  // For .gitignore, check for valid patterns
  if (edit.file.endsWith(".gitignore")) {
    const patterns = edit.replacement.split("\n");
    for (const pattern of patterns) {
      if (pattern.trim() && pattern.includes("\\")) {
        result.warnings.push(
          "Backslashes in .gitignore patterns may not work as expected"
        );
      }
    }
  }
}

function validateJson(edit: any, result: ValidationResult): void {
  try {
    JSON.parse(edit.replacement);
  } catch (error) {
    result.errors.push("Invalid JSON syntax");
    result.isValid = false;
  }
}

function validateSafetyChecks(edit: any, result: ValidationResult): void {
  const dangerous = ["rm -rf", "sudo", "DELETE FROM", "DROP TABLE"];

  for (const danger of dangerous) {
    if (edit.replacement.includes(danger)) {
      result.errors.push(`Potentially dangerous operation detected: ${danger}`);
      result.isValid = false;
    }
  }

  // Check for very large changes
  if (edit.replacement.length > 10000) {
    result.warnings.push(
      "Very large change detected - please review carefully"
    );
  }
}
