import { validateEdit } from "../commands/validation";
import { expect } from "chai";
import { describe, it } from "mocha";

describe("Edit Validation Evaluations", function () {
  // Allow real LLM calls to complete
  this.timeout(15000);

  describe("File Operations", () => {
    it("should validate new file creation", async () => {
      const edit = {
        file: "src/newfile.ts",
        original: "",
        replacement: "console.log('hello');",
        lineNumber: null,
        explanation: "create file with a log",
      };

      const result = await validateEdit(edit);
      expect(result.isValid).to.be.true;
    });

    it("should validate file modifications", async () => {
      const edit = {
        file: "src/existing.ts",
        original: "old code",
        replacement: "new code",
        lineNumber: 1,
        explanation: "update existing code",
      };

      const result = await validateEdit(edit);
      expect(result.isValid).to.be.true;
    });

    it("should reject invalid file paths", async () => {
      const edit = {
        file: "../outside/project.ts",
        original: "",
        replacement: "malicious code",
        lineNumber: null,
        explanation: "bad path",
      };

      const result = await validateEdit(edit);
      expect(result.isValid).to.be.false;
    });
  });
});
