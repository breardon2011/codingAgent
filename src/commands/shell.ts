import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export async function runShellCommand(command: string) {
  try {
    const { stdout, stderr } = await execAsync(command);
    return stdout || stderr;
  } catch (err: any) {
    return `❌ Error: ${err.message}`;
  }
}
