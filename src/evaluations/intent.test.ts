import { extractIntentWithContext } from "../agent";
import { expect } from "chai";
import { describe, it } from "mocha";
import type { IntentType } from "../agent";

describe("Intent Classification Evaluations", () => {
  describe("Shell Commands", () => {
    it("should classify npm commands correctly", async () => {
      const inputs = [
        "install express please",
        "can you install typescript",
        "run npm install",
      ];

      for (const input of inputs) {
        const intent = await extractIntentWithContext(input);
        expect(intent.intentType).to.equal("edit");
        if (intent.intentType === "edit") {
          expect(intent.action).to.equal("shell_command");
          expect(intent.command).to.include("npm");
        }
      }
    });

    it("should classify git commands correctly", async () => {
      const inputs = [
        "commit these changes",
        "can you stage all files",
        "push to main branch",
      ];

      for (const input of inputs) {
        const intent = await extractIntentWithContext(input);
        expect(intent.intentType).to.equal("edit");
        if (intent.intentType === "edit") {
          expect(intent.action).to.equal("shell_command");
        }
      }
    });
  });

  describe("Code Edits", () => {
    it("should classify file modifications", async () => {
      const inputs = [
        "add a new route to the server",
        "update the README",
        "fix the TypeScript error in utils.ts",
      ];

      for (const input of inputs) {
        const intent = await extractIntentWithContext(input);
        expect(intent.intentType).to.equal("edit");
        if (intent.intentType === "edit") {
          expect(["add_code", "modify_code", "fix_error"]).to.include(
            intent.action
          );
        }
      }
    });
  });

  describe("Questions", () => {
    it("should classify questions correctly", async () => {
      const inputs = [
        "how does this work?",
        "explain the authentication flow",
        "what does this function do?",
      ];

      for (const input of inputs) {
        const intent = await extractIntentWithContext(input);
        expect(intent.intentType).to.equal("question");
        if (intent.intentType === "question") {
          expect(intent.question).to.be.a("string");
        }
      }
    });
  });

  // Helper function to type-check intents
  function assertEditIntent(
    intent: IntentType
  ): asserts intent is Extract<IntentType, { intentType: "edit" }> {
    if (intent.intentType !== "edit") {
      throw new Error("Expected edit intent");
    }
  }
});
