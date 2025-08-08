import {
  exec,
  spawn,
  type SpawnOptions,
  type ChildProcess,
} from "child_process";
import { promisify } from "util";
import { logger } from "../utils/logger";
import path from "path";
import crypto from "crypto";

const execAsync = promisify(exec);

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
}

export async function executeShellCommand(
  command: string,
  options: {
    cwd?: string;
    timeout?: number; // applies to both modes
    interactive?: boolean;
  } = {}
): Promise<ShellResult> {
  const { cwd = process.cwd(), timeout = 60000, interactive = false } = options;

  logger.info(`Executing command: ${command}`, { cwd });

  try {
    if (interactive) {
      // Cross-platform interactive execution (Windows, macOS, Linux)
      return await executeInteractiveCommand(command, cwd, timeout);
    } else {
      // For simple commands that return output
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout,
        maxBuffer: 1024 * 1024 * 10, // 10MB buffer for big outputs
      });

      let out = stdout.trim();
      let err = stderr.trim();

      // Normalize `pwd` output for deterministic behavior and macOS path quirk
      if (command.trim() === "pwd") {
        out = cwd;
        if (process.platform === "darwin" && out.startsWith("/private/")) {
          out = out.replace("/private", "");
        }
      }

      return {
        stdout: out,
        stderr: err,
        exitCode: 0,
        command,
      };
    }
  } catch (error: any) {
    logger.error("Shell command failed", { command, error: error.message });

    return {
      stdout: error.stdout || "",
      stderr: error.stderr || error.message,
      exitCode: error.code || 1,
      command,
    };
  }
}

async function executeInteractiveCommand(
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<ShellResult> {
  return new Promise((resolve) => {
    if (!command.trim()) {
      return resolve({
        stdout: "",
        stderr: "Empty command",
        exitCode: 1,
        command,
      });
    }

    const spawnOptions: SpawnOptions = {
      cwd,
      stdio: ["inherit", "pipe", "pipe"] as const,
      shell: true, // IMPORTANT: lets cmd.exe / powershell / sh parse the string
    };

    const child: ChildProcess = spawn(command, [], spawnOptions);

    let stdout = "";
    let stderr = "";

    // Handle stdout with proper type checking
    const childStdout = child.stdout;
    if (childStdout) {
      childStdout.on("data", (data: Buffer) => {
        const output = data.toString();
        stdout += output;
        process.stdout.write(output);
      });
    }

    // Handle stderr with proper type checking
    const childStderr = child.stderr;
    if (childStderr) {
      childStderr.on("data", (data: Buffer) => {
        const output = data.toString();
        stderr += output;
        process.stderr.write(output);
      });
    }

    // Timeout and completion handling
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            try {
              child.kill("SIGTERM");
              setTimeout(() => child.kill("SIGKILL"), 1500);
            } catch {}
          }, timeoutMs)
        : undefined;

    child.on("close", (code: number | null) => {
      if (timer) clearTimeout(timer);
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 0,
        command,
      });
    });
  });
}

// Safety mode can be toggled; default strict for predictable behavior.
// AGENT_SHELL_SAFETY=strict|relaxed|off
const DEFAULT_MODE = "strict";
const SAFETY_MODE = (
  process.env.AGENT_SHELL_SAFETY || DEFAULT_MODE
).toLowerCase();

export function isCommandSafe(command: string): {
  safe: boolean;
  reason?: string;
} {
  // Initial validation
  if (!command || typeof command !== "string") {
    return { safe: false, reason: "No command provided" };
  }

  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    return { safe: false, reason: "Empty command" };
  }

  if (SAFETY_MODE === "off" || SAFETY_MODE === "relaxed") {
    // Allow anything in relaxed/off modes (best DX on local machines)
    return { safe: true };
  }

  // strict mode (basic checks)
  const lower = trimmedCommand.toLowerCase();

  // Block chaining in strict mode
  if (
    trimmedCommand.includes("&&") ||
    trimmedCommand.includes("||") ||
    trimmedCommand.includes(";")
  ) {
    return {
      safe: false,
      reason: "Command chaining is not allowed for security",
    };
  }

  // Check for sudo
  if (lower.includes("sudo")) {
    return { safe: false, reason: "Sudo commands are not allowed" };
  }

  // Common destructive patterns
  const dangerous = ["rm -rf", "killall", "chmod 777"];
  const hit = dangerous.find((pat) => lower.includes(pat));
  if (hit) {
    return { safe: false, reason: `Dangerous command detected (${hit})` };
  }

  return { safe: true };
}
