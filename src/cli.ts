import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";
import chalk from "chalk";
import {
  extractIntent,
  proposeEdit,
  reviseProposal,
  chatFallback,
} from "./agent";
import { searchCodebase } from "./commands/search";
import { applyEdit } from "./commands/file";
import { z } from "zod";
import { editIntentSchema } from "./agent";

const rl = readline.createInterface({ input, output });

console.log(chalk.green("🤖 Coding Agent ready. Type 'exit' to quit."));

(async () => {
  try {
    while (true) {
      const userInput = await rl.question(chalk.blue("You > "));
      if (userInput.trim().toLowerCase() === "exit") break;

      const intent = await extractIntent(userInput);

      if (intent.intentType === "question") {
        const reply = await chatFallback(userInput);
        console.log("💭", reply);
        continue;
      }

      // At this point TypeScript knows intent is an edit intent
      const editIntent = intent as z.infer<typeof editIntentSchema>;
      const matches = await searchCodebase(editIntent.target);

      if (matches.length === 0) {
        console.log("❌ No matches found.");
        continue;
      }

      const match = matches[0];
      const proposal = await proposeEdit(editIntent, match);

      console.log(
        chalk.cyan(
          `\n--- Proposed Change ---\n${proposal.original}\n=>\n${
            proposal.replacement
          }\n@ ${proposal.file}${
            proposal.lineNumber ? `:${proposal.lineNumber}` : "" // Only show line number if it exists
          }\n------------------------\n`
        )
      );

      const feedback = await rl.question(
        "💬 Accept this change? [yes / critique]: "
      );

      if (feedback.trim().toLowerCase() === "yes") {
        await applyEdit(proposal);
      } else {
        const revised = await reviseProposal(feedback, editIntent, match);
        console.log(chalk.yellow("🔄 Revised proposal:"));
        console.log(`${revised.original} => ${revised.replacement}`);
        await applyEdit(revised);
      }
    }
  } catch (error) {
    console.error("Error:", error);
  } finally {
    rl.close();
  }
})();
