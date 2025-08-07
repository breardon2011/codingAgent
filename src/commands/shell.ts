import {
  exec,
  spawn,
  type SpawnOptions,
  type ChildProcess,
} from "child_process";
import { promisify } from "util";
import { logger } from "../utils/logger";
import type { Readable } from "stream";
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
    timeout?: number;
    interactive?: boolean;
  } = {}
): Promise<ShellResult> {
  const { cwd = process.cwd(), timeout = 30000, interactive = false } = options;

  logger.info(`Executing command: ${command}`, { cwd });

  try {
    if (interactive) {
      // For interactive commands like npm install, git operations
      return await executeInteractiveCommand(command, cwd);
    } else {
      // For simple commands that return output
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout,
        maxBuffer: 1024 * 1024, // 1MB buffer
      });

      return {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
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
  cwd: string
): Promise<ShellResult> {
  return new Promise((resolve) => {
    // Split command safely
    const parts = command.split(" ").filter(Boolean);
    if (parts.length === 0) {
      return resolve({
        stdout: "",
        stderr: "Empty command",
        exitCode: 1,
        command,
      });
    }

    const [baseCmd, ...args] = parts;
    // Ensure cmd is string
    const cmd = baseCmd || "";

    // Define spawn options with correct types
    const spawnOptions: SpawnOptions = {
      cwd,
      stdio: ["inherit", "pipe", "pipe"] as const,
      shell: false,
    };

    // Explicitly type the child process
    const child: ChildProcess = spawn(cmd, args, spawnOptions);

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

    // Handle process completion
    child.on("close", (code: number | null) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 0,
        command,
      });
    });
  });
}

// Command safety checks
const SAFE_COMMANDS = [
  "npm",
  "yarn",
  "pnpm",
  "git",
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "grep",
  "find",
  "mkdir",
  "cp",
  "mv",
  "touch",
  "echo",
  "node",
  "tsc",
];

const DANGEROUS_COMMANDS = [
  "rm",
  "rmdir",
  "del",
  "sudo",
  "chmod",
  "chown",
  "dd",
  "format",
  "mkfs",
  "fdisk",
  "kill",
  "killall",
];

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

  // Extract the base command safely
  const parts = trimmedCommand.split(" ");
  const baseCommand = parts[0]?.toLowerCase();
  if (!baseCommand) {
    return { safe: false, reason: "Invalid command format" };
  }

  // Check for dangerous commands first
  if (DANGEROUS_COMMANDS.includes(baseCommand)) {
    return {
      safe: false,
      reason: `Command '${baseCommand}' is potentially dangerous`,
    };
  }

  // Check for command chaining
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
  if (trimmedCommand.includes("sudo")) {
    return { safe: false, reason: "Sudo commands are not allowed" };
  }

  // Check if it's a known safe command
  if (!SAFE_COMMANDS.includes(baseCommand)) {
    return {
      safe: false,
      reason: `Command '${baseCommand}' is not in the allowed list`,
    };
  }

  // Prevent arbitrary package-script execution (npm run / pnpm run etc.)
  if (["npm", "yarn", "pnpm"].includes(baseCommand) && parts[1] === "run") {
    return {
      safe: false,
      reason: "Running user-defined scripts is not allowed",
    };
  }

  return { safe: true };
}
