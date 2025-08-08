import { readdir, readFile } from "fs/promises";
import path from "path";
import crypto from "crypto";
import { planSearch } from "../services/searchPlanner";
import { rerankMatches } from "../services/searchReranker";

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

const fileCache: { list: string[] | undefined; cwd: string | undefined } = {
  list: undefined,
  cwd: undefined,
};

export function resetSearchFileCache(): void {
  fileCache.list = undefined;
  fileCache.cwd = undefined;
}

export async function searchCodebase(
  keyword: string,
  options?: SearchOptions
): Promise<SearchMatch[]> {
  const cwd = process.cwd();
  if (!fileCache.list || fileCache.cwd !== cwd) {
    fileCache.list = await getAllFiles(cwd);
    fileCache.cwd = cwd;
  }
  const files = fileCache.list;
  const matches: SearchMatch[] = [];

  // Build a tiny inventory snapshot for the planner (top-level dirs/files)
  const topEntries = files
    .map((f) => f.replace(cwd + path.sep, ""))
    .filter((p) => p.split(path.sep).length <= 2)
    .slice(0, 50)
    .join("\n");

  // LLM-assisted search plan (language-agnostic)
  let plan = await planSearch({
    userPrompt: `${options?.description ?? keyword}`,
    intent: {
      action: options?.action ?? "",
      target: options?.target ?? keyword,
      description: options?.description ?? "",
    },
    fileInventorySample: topEntries,
  });

  // Simple glob-like filtering (very lightweight; no glob lib)
  function includeByPlan(filePath: string): boolean {
    const rel = filePath.replace(cwd + path.sep, "");
    const inc = plan.includeGlobs.length
      ? plan.includeGlobs.some((g) =>
          rel.includes(g.replace("**/", "").replace("**", ""))
        )
      : true;
    const exc = plan.excludeGlobs.some((g) =>
      rel.includes(g.replace("**/", "").replace("**", ""))
    );
    return inc && !exc;
  }

  for (const file of files) {
    if (!includeByPlan(file)) continue;
    try {
      const content = await readFile(file, "utf8");
      const lines = content.split("\n");
      const fileType = getFileType(file);

      lines.forEach((line, idx) => {
        const relevance = calculateRelevance(line, keyword, file, fileType, {
          action: options?.action ?? "",
          target: options?.target ?? "",
          description: options?.description ?? "",
          filenameKeywords: plan.filenameKeywords,
          contentKeywords: plan.contentKeywords,
        });
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

  // Optional LLM re-rank of top candidates
  const prelim = matches
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 30);
  if (prelim.length > 1) {
    try {
      const reranks = await rerankMatches(
        prelim.map((m) => ({
          file: m.file,
          line: m.line,
          lineNumber: m.lineNumber,
        })),
        options?.description ?? keyword
      );
      prelim.forEach((m, i) => {
        m.relevanceScore = m.relevanceScore * (0.5 + reranks[i]!); // 0.5..1.5 multiplier
      });
    } catch {}
  }

  let finalMatches = prelim.sort((a, b) => b.relevanceScore - a.relevanceScore);

  // If no strong matches, synthesize a new-file suggestion from plan
  if (finalMatches.length === 0 || finalMatches[0]!.relevanceScore < 20) {
    const candidate = plan.newFileCandidates[0];
    if (candidate) {
      finalMatches = [
        {
          file: path.join(cwd, candidate),
          line: "",
          lineNumber: 1,
          fileType: getFileType(candidate),
          relevanceScore: 100,
        },
      ];
    }
  }

  return finalMatches;
}

function calculateRelevance(
  line: string,
  keyword: string,
  file: string,
  _fileType: string,
  options?: SearchOptions & {
    filenameKeywords?: string[];
    contentKeywords?: string[];
  }
): number {
  let score = 0;
  const lowerLine = line.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  const lowerFile = file.toLowerCase();
  const fileBase = path.basename(file).toLowerCase();

  // Basic text match
  if (lowerLine.includes(lowerKeyword)) score += 10;
  if (line.includes(keyword)) score += 20;

  // Token overlap: target/description/planner keywords
  const tokens = [
    ...(options?.target?.toLowerCase().split(/[^a-z0-9]+/g) ?? []),
    ...(options?.description?.toLowerCase().split(/[^a-z0-9]+/g) ?? []),
    ...(options?.filenameKeywords ?? []),
    ...(options?.contentKeywords ?? []),
  ].filter(Boolean);

  let hits = 0;
  for (const t of tokens) {
    if (!t) continue;
    if (lowerLine.includes(t)) hits += 1;
    if (lowerFile.includes(t)) hits += 2;
    if (fileBase.startsWith(t) || fileBase.includes(`${t}.`)) hits += 1;
  }
  score += hits * 3;

  // Prefer target string in path
  if (options?.target && lowerFile.includes(options.target.toLowerCase()))
    score += 30;

  // Penalize tests/evaluations/fixtures
  if (
    lowerFile.includes("/__tests__/") ||
    lowerFile.includes("/tests/") ||
    lowerFile.includes("/e2e/") ||
    lowerFile.includes("/fixtures/") ||
    lowerFile.includes("/mocks/") ||
    lowerFile.includes("/src/evaluations/") ||
    /\.test\.[a-z0-9]+$/.test(fileBase) ||
    /\.spec\.[a-z0-9]+$/.test(fileBase)
  ) {
    score -= 40;
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
