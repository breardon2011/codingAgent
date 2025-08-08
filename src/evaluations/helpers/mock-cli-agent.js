/* Preload to mock LLM-driven modules used by src/cli.ts in tests */
const Module = require("module");
const path = require("path");
const { existsSync } = require("fs");
const fsp = require("fs/promises");

// Ensure a default terminal width for box-drawing and .repeat()
try {
  if (!process.stdout.columns) {
    Object.defineProperty(process.stdout, "columns", {
      value: 80,
      configurable: true,
    });
  }
} catch {}

const projectRoot = process.cwd();
const agentPath = path.join(projectRoot, "src", "agent.ts");
const validationPath = path.join(
  projectRoot,
  "src",
  "commands",
  "validation.ts"
);
const searchPath = path.join(projectRoot, "src", "commands", "search.ts");

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true }).catch(() => {});
}

const mockAgent = {
  async extractIntentWithContext(input) {
    const text = String(input || "").trim();
    const m = text.match(/`([^`]+)`/);
    if (m) {
      return {
        intentType: "edit",
        action: "shell_command",
        target: "project",
        description: "run command",
        command: m[1],
      };
    }
    if (
      /^(run|execute)\s+/i.test(text) ||
      /^(ls|cat|pwd|echo|printf)\b/.test(text)
    ) {
      const cmd = text.replace(/^(run|execute)\s+/i, "");
      return {
        intentType: "edit",
        action: "shell_command",
        target: "project",
        description: "run command",
        command: cmd,
      };
    }
    return {
      intentType: "edit",
      action: "modify_code",
      target: "tmp/cli-e2e.txt",
      description: text,
    };
  },

  async proposeEditWithContext(_intent, match) {
    return [
      {
        file: match.file,
        original: "",
        replacement: "// added-by-cli-test",
        lineNumber: null,
        explanation: "append a test marker",
      },
    ];
  },

  async reviseProposal(feedback, _intent, match) {
    return [
      {
        file: match.file,
        original: "",
        replacement: `// revised-by-cli-test: ${feedback}`,
        lineNumber: null,
        explanation: "append a revised test marker",
      },
    ];
  },

  async chatFallback(prompt) {
    return `fallback: ${prompt}`;
  },

  async applyEdit(edit) {
    const dir = path.dirname(edit.file);
    await ensureDir(dir);
    let content = "";
    try {
      content = await fsp.readFile(edit.file, "utf8");
    } catch {}
    let newContent = content;
    if (edit.lineNumber == null) {
      const needsNl = content && !content.endsWith("\n") ? "\n" : "";
      newContent = content + needsNl + edit.replacement + "\n";
    } else {
      const lines = content.split("\n");
      const idx = edit.lineNumber - 1;
      if (edit.original && lines[idx] && lines[idx].includes(edit.original)) {
        lines[idx] = lines[idx].replace(edit.original, edit.replacement);
        newContent = lines.join("\n");
      } else if (edit.original) {
        const pos = content.indexOf(edit.original);
        if (pos === -1) {
          throw new Error("Original snippet not found in file");
        }
        newContent =
          content.slice(0, pos) +
          edit.replacement +
          content.slice(pos + edit.original.length);
      } else {
        lines[idx] = edit.replacement;
        newContent = lines.join("\n");
      }
    }
    await fsp.writeFile(edit.file, newContent, "utf8");
    console.log(
      `✅ Change applied to ${edit.file}${
        edit.lineNumber ? ` at line ${edit.lineNumber}` : ""
      }`
    );
  },

  async applyEdits(edits) {
    for (const e of edits) {
      await mockAgent.applyEdit(e);
    }
  },
};

const mockValidation = {
  async validateEdit(_edit) {
    return { isValid: true, errors: [], warnings: [] };
  },
  async validateEdits(edits) {
    return edits.map(() => ({ isValid: true, errors: [], warnings: [] }));
  },
};

const mockSearch = {
  async searchCodebase(keyword, options) {
    const projectRoot = process.cwd();
    let target = options?.target || keyword || "tmp/cli-e2e.txt";
    if (!path.isAbsolute(target)) {
      target = path.join(projectRoot, target);
    }
    const dir = path.dirname(target);
    if (!existsSync(dir)) {
      await fsp.mkdir(dir, { recursive: true });
    }
    if (!existsSync(target)) {
      await fsp.writeFile(target, "", "utf8");
    }
    return [
      {
        file: target,
        line: "",
        lineNumber: 1,
        fileType: "data",
        relevanceScore: 100,
      },
    ];
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  let resolved;
  try {
    resolved = Module._resolveFilename(request, parent, false);
  } catch {
    return originalLoad.apply(this, arguments);
  }
  if (resolved === agentPath) return mockAgent;
  if (resolved === validationPath) return mockValidation;
  if (resolved === searchPath) return mockSearch;
  return originalLoad.apply(this, arguments);
};
