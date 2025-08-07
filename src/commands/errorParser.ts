import path from "path";

interface ParsedError {
  type: "syntax" | "import" | "type" | "runtime" | "unknown";
  message: string;
  file?: string;
  line?: number;
  suggestions: string[];
}

export function parseError(errorText: string): ParsedError {
  const result: ParsedError = {
    type: "unknown",
    message: errorText,
    suggestions: [],
  };

  // TypeScript errors
  if (errorText.includes("ts(")) {
    result.type = "type";

    if (errorText.includes("Cannot find module")) {
      result.type = "import";
      result.suggestions.push("Install the missing package with npm/yarn/pnpm");
      result.suggestions.push("Check the import path is correct");
      result.suggestions.push(
        "Add type definitions if it's a TypeScript project"
      );
    }

    if (
      errorText.includes("Property") &&
      errorText.includes("does not exist")
    ) {
      result.suggestions.push("Check the property name spelling");
      result.suggestions.push("Verify the object type/interface");
      result.suggestions.push("Add the property to the type definition");
    }
  }

  // Node.js errors
  if (errorText.includes("MODULE_NOT_FOUND")) {
    result.type = "import";
    result.suggestions.push("Run 'npm install' to install dependencies");
    result.suggestions.push("Check if the module name is correct");
    result.suggestions.push("Verify the module is listed in package.json");
  }

  // Python errors
  if (errorText.includes("ModuleNotFoundError")) {
    result.type = "import";
    result.suggestions.push("Install the module with pip");
    result.suggestions.push("Check if the module name is correct");
    result.suggestions.push("Verify your virtual environment is activated");
  }

  if (errorText.includes("SyntaxError")) {
    result.type = "syntax";
    result.suggestions.push("Check for missing brackets, quotes, or colons");
    result.suggestions.push("Verify indentation is correct");
  }

  // Extract file and line information safely
  const fileMatch = errorText.match(/([^\s]+\.(ts|js|py|java|cpp)):(\d+)/);
  if (fileMatch) {
    // fileMatch[1] and [3] are guaranteed to exist when the regex matches
    result.file = fileMatch[1]!;
    result.line = parseInt(fileMatch[3]!, 10);
  }

  return result;
}

export function suggestFix(parsedError: ParsedError): string {
  switch (parsedError.type) {
    case "import":
      return `Missing dependency detected. Try: npm install <package-name>`;
    case "syntax":
      return `Syntax error detected. Check brackets, quotes, and formatting.`;
    case "type":
      return `Type error detected. Check property names and type definitions.`;
    default:
      return `Error detected: ${parsedError.message}`;
  }
}

// Export the interface for use in other files
export type { ParsedError };
