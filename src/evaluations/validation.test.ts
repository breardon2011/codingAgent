import { validateEdit } from "../commands/validation";
import { expect } from "chai";
import { describe, it } from "mocha";

describe("Edit Validation Evaluations", () => {
  describe("File Operations", () => {
    it("should validate new file creation", async () => {
      const edit = {
        file: "src/newfile.ts",
        original: "",
        replacement: "console.log('hello');",
        lineNumber: null,
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
      };

      const result = await validateEdit(edit);
      expect(result.isValid).to.be.false;
    });
  });
});
