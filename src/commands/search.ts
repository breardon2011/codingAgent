import { readdir, readFile, stat } from "fs/promises";
import path from "path";
import crypto from "crypto";

export interface SearchMatch {
  file: string;
  line: string;
  lineNumber: number;
  fileType: string;
  relevanceScore: number;
}

export interface SearchOptions {
  action: string;
  target: string;
  description: string;
}

const fileCache: { list?: string[] } = {};

export async function searchCodebase(
  keyword: string,
  options?: SearchOptions
): Promise<SearchMatch[]> {
  const cwd = process.cwd();
  if (!fileCache.list) {
    fileCache.list = await getAllFiles(cwd);
  }
  const files = fileCache.list;
  const matches: SearchMatch[] = [];

  for (const file of files) {
    try {
      const content = await readFile(file, "utf8");
      const lines = content.split("\n");
      const fileType = getFileType(file);

      lines.forEach((line, idx) => {
        const relevance = calculateRelevance(
          line,
          keyword,
          file,
          fileType,
          options
        );
        if (relevance > 0) {
          matches.push({
            file,
            line: line.trim(),
            lineNumber: idx + 1,
            fileType,
            relevanceScore: relevance,
          });
        }
      });
    } catch (error) {
      // Skip files that can't be read
      continue;
    }
  }

  // Sort by relevance score (highest first)
  return matches.sort((a, b) => b.relevanceScore - a.relevanceScore);
}

function calculateRelevance(
  line: string,
  keyword: string,
  file: string,
  fileType: string,
  options?: SearchOptions
): number {
  let score = 0;
  const lowerLine = line.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();

  // Basic keyword matching
  if (lowerLine.includes(lowerKeyword)) {
    score += 10;
  }

  // Exact matches get higher score
  if (line.includes(keyword)) {
    score += 20;
  }

  // File type relevance
  if (options?.action === "config_change") {
    if (
      fileType === "config" ||
      file.includes("config") ||
      file.includes(".env")
    ) {
      score += 30;
    }
  }

  // Target file preference
  if (options?.target && file.includes(options.target)) {
    score += 50;
  }

  // Function/class definitions get higher scores
  if (
    lowerLine.includes("function") ||
    lowerLine.includes("class") ||
    lowerLine.includes("def ")
  ) {
    score += 15;
  }

  // Import/export statements
  if (
    lowerLine.includes("import") ||
    lowerLine.includes("export") ||
    lowerLine.includes("require")
  ) {
    score += 10;
  }

  return score;
}

function getFileType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath).toLowerCase();

  // Config files
  if (
    fileName.includes("config") ||
    fileName.includes(".env") ||
    fileName === ".gitignore" ||
    fileName === "package.json" ||
    fileName === "tsconfig.json"
  ) {
    return "config";
  }

  // Code files
  if ([".ts", ".js", ".tsx", ".jsx"].includes(ext)) {
    return "javascript";
  }

  if ([".py"].includes(ext)) {
    return "python";
  }

  if ([".java"].includes(ext)) {
    return "java";
  }

  if ([".cpp", ".c", ".h"].includes(ext)) {
    return "cpp";
  }

  if ([".md", ".txt"].includes(ext)) {
    return "documentation";
  }

  if ([".json", ".yaml", ".yml", ".toml"].includes(ext)) {
    return "data";
  }

  return "unknown";
}

async function getAllFiles(dir: string): Promise<string[]> {
  try {
    const dirents = await readdir(dir, { withFileTypes: true });
    const files = await Promise.all(
      dirents.map(async (d) => {
        const fullPath = path.join(dir, d.name);

        // Skip common ignored directories
        if (d.isDirectory()) {
          if (
            [
              "node_modules",
              ".git",
              "dist",
              "build",
              "__pycache__",
              ".venv",
            ].includes(d.name)
          ) {
            return [];
          }
          return getAllFiles(fullPath);
        }

        // Include relevant file types
        const ext = path.extname(d.name).toLowerCase();
        const allowedExtensions = [
          ".ts",
          ".js",
          ".tsx",
          ".jsx",
          ".py",
          ".java",
          ".cpp",
          ".c",
          ".h",
          ".json",
          ".md",
          ".txt",
          ".yaml",
          ".yml",
          ".toml",
          ".env",
        ];

        const specialFiles = [".gitignore", "Dockerfile", "Makefile"];

        if (allowedExtensions.includes(ext) || specialFiles.includes(d.name)) {
          return [fullPath];
        }

        return [];
      })
    );
    return files.flat();
  } catch (error) {
    return [];
  }
}

function sha256(text: string) {
  return crypto.createHash("sha256").update(text).digest("hex");
}
