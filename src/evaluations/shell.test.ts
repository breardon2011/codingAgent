import { executeShellCommand, isCommandSafe } from "../commands/shell";
import { expect } from "chai";
import { describe, it } from "mocha";

describe("Shell Command Evaluations", () => {
  describe("Command Safety Checks", () => {
    it("should allow safe commands", () => {
      const safeCommands = [
        "npm install express",
        "git status",
        "ls -la",
        "node index.js",
        "tsc --watch",
      ];

      safeCommands.forEach((cmd) => {
        const result = isCommandSafe(cmd);
        expect(result.safe).to.be.true;
      });
    });

    it("should reject dangerous commands", () => {
      const dangerousCommands = [
        "rm -rf /",
        "sudo npm install",
        "chmod 777 file",
        "killall node",
      ];

      dangerousCommands.forEach((cmd) => {
        const result = isCommandSafe(cmd);
        expect(result.safe).to.be.false;
      });
    });

    it("should reject command chaining", () => {
      const chainedCommands = [
        "npm install && npm start",
        "git add . ; git commit",
        "echo 'hi' || exit",
      ];

      chainedCommands.forEach((cmd) => {
        const result = isCommandSafe(cmd);
        expect(result.safe).to.be.false;
        expect(result.reason).to.include("chaining");
      });
    });
  });

  describe("Command Execution", () => {
    it("should execute simple commands", async () => {
      const result = await executeShellCommand("echo 'test'");
      expect(result.stdout.trim()).to.equal("test");
      expect(result.exitCode).to.equal(0);
    });

    it("should handle command failures", async () => {
      const result = await executeShellCommand("nonexistentcommand");
      expect(result.exitCode).not.to.equal(0);
      expect(result.stderr).not.to.be.empty;
    });

    it("should respect working directory", async () => {
      const result = await executeShellCommand("pwd", { cwd: "/tmp" });
      expect(result.stdout.trim()).to.equal("/tmp");
    });
  });
});
