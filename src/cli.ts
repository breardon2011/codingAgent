import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";
import chalk from "chalk";
import {
  extractIntentWithContext as extractIntent,
  proposeEditWithContext as proposeEdit,
  reviseProposal,
  chatFallback,
} from "./agent";
import { searchCodebase, SearchMatch } from "./commands/search";
import { applyEdit } from "./commands/file";
import { validateEdit } from "./commands/validation";
import { parseError, suggestFix } from "./commands/errorParser";
import { logger } from "./utils/logger";
import { conversationHistory } from "./utils/conversationHistory";
import { z } from "zod";
import { editIntentSchema } from "./agent";

const rl = readline.createInterface({ input, output });

console.log(chalk.green("🤖 Coding Agent ready. Type 'exit' to quit."));

(async () => {
  try {
    while (true) {
      const userInput = await rl.question(chalk.blue("You > "));
      if (userInput.trim().toLowerCase() === "exit") break;

      // Add special commands for history
      if (userInput.trim().toLowerCase() === "history") {
        const recent = conversationHistory.getRecentContext(10);
        console.log(chalk.cyan("📝 Recent conversation:"));
        recent.forEach((entry, i) => {
          console.log(
            `${chalk.gray(`${i + 1}.`)} ${entry.userInput} → ${
              entry.outcome === "accepted"
                ? chalk.green("✓")
                : entry.outcome === "rejected"
                ? chalk.red("✗")
                : chalk.yellow("~")
            }`
          );
        });
        continue;
      }

      if (userInput.trim().toLowerCase() === "patterns") {
        const patterns = conversationHistory.getUserPatterns();
        console.log(chalk.cyan("🔍 Detected patterns:"));
        patterns.forEach((pattern: string) => console.log(`  • ${pattern}`));
        continue;
      }

      logger.debug("Processing user input", { input: userInput });

      // Start tracking this conversation
      const entryId = conversationHistory.addEntry({
        userInput,
        intent: null,
        outcome: "error", // Will update this
      });

      // Check if input looks like an error message
      if (userInput.includes("Error:") || userInput.includes("error")) {
        const parsedError = parseError(userInput);
        console.log(
          chalk.yellow("🔍 Error detected:"),
          suggestFix(parsedError)
        );

        if (parsedError.suggestions.length > 0) {
          console.log(chalk.cyan("💡 Suggestions:"));
          parsedError.suggestions.forEach((s: string) =>
            console.log(`  • ${s}`)
          );
        }

        // Update history - safely get the most recent entry
        const recentEntries = conversationHistory.getRecentContext(1);
        if (recentEntries.length > 0) {
          const history = recentEntries[0]!;
          history.outcome = "rejected";
          history.context = "Error handling";
        }
        continue;
      }

      const intent = await extractIntent(userInput);
      logger.debug("Extracted intent", intent);

      // Update history with intent - safely get the most recent entry
      const currentEntries = conversationHistory.getRecentContext(1);
      const currentEntry = currentEntries[0];
      if (currentEntry) {
        currentEntry.intent = intent;

        if (intent.intentType === "question") {
          const reply = await chatFallback(userInput);
          console.log("💭", reply);
          currentEntry.outcome = "accepted";
          currentEntry.context = "Question answered";
          continue;
        }

        // At this point TypeScript knows intent is an edit intent
        const editIntent = intent as z.infer<typeof editIntentSchema>;

        // Enhanced search with intent context
        const matches = await searchCodebase(editIntent.target, {
          action: editIntent.action,
          target: editIntent.target,
          description: editIntent.description,
        });

        currentEntry.searchResults = matches.slice(0, 3);

        logger.debug("Search results", {
          count: matches.length,
          matches: matches.slice(0, 3),
        });

        if (matches.length === 0) {
          console.log("❌ No matches found.");
          currentEntry.outcome = "error";
          currentEntry.context = "No matches found";
          continue;
        }

        const match = matches[0]!; // We just checked length > 0
        logger.info(
          `Found match in ${match.file} (score: ${match.relevanceScore})`
        );

        const proposal = await proposeEdit(editIntent, match);
        currentEntry.proposal = proposal;
        logger.debug("Generated proposal", proposal);

        // Validate the proposal
        const validation = await validateEdit(proposal);

        if (!validation.isValid) {
          console.log(chalk.red("❌ Validation failed:"));
          validation.errors.forEach((err: string) => console.log(`  • ${err}`));
          currentEntry.outcome = "rejected";
          currentEntry.context = "Validation failed";
          continue;
        }

        if (validation.warnings.length > 0) {
          console.log(chalk.yellow("⚠️  Warnings:"));
          validation.warnings.forEach((warn: string) =>
            console.log(`  • ${warn}`)
          );
        }

        console.log(
          chalk.cyan(
            `\n--- Proposed Change ---\n${proposal.original}\n=>\n${
              proposal.replacement
            }\n@ ${proposal.file}${
              proposal.lineNumber ? `:${proposal.lineNumber}` : ""
            }\n------------------------\n`
          )
        );

        const feedback = await rl.question(
          "💬 Accept this change? [yes / no / critique]: "
        );

        if (feedback.trim().toLowerCase() === "yes") {
          try {
            await applyEdit(proposal);
            currentEntry.outcome = "accepted";
            currentEntry.finalChange = proposal;
            logger.info("Change applied successfully");
          } catch (error) {
            currentEntry.outcome = "error";
            currentEntry.context = `Apply failed: ${error}`;
            logger.error("Failed to apply change", error);
            console.log(chalk.red(`❌ Failed to apply change: ${error}`));
          }
        } else if (feedback.trim().toLowerCase() === "no") {
          // Handle explicit rejection
          console.log(chalk.yellow("❌ Change rejected by user"));
          currentEntry.outcome = "rejected";
          currentEntry.context = "User explicitly rejected the proposal";
          logger.info("User rejected the proposal");
        } else {
          // Handle critique/revision requests
          try {
            const revised = await reviseProposal(feedback, editIntent, match);
            const revisedValidation = await validateEdit(revised);

            if (!revisedValidation.isValid) {
              console.log(chalk.red("❌ Revised proposal validation failed:"));
              revisedValidation.errors.forEach((err: string) =>
                console.log(`  • ${err}`)
              );
              currentEntry.outcome = "rejected";
              currentEntry.context = "Revised validation failed";
              continue;
            }

            console.log(chalk.yellow("🔄 Revised proposal:"));
            console.log(`${revised.original} => ${revised.replacement}`);

            // Ask for confirmation on the revision
            const revisionConfirm = await rl.question(
              "💬 Accept this revised change? [yes / no]: "
            );

            if (revisionConfirm.trim().toLowerCase() === "yes") {
              currentEntry.outcome = "modified";
              currentEntry.finalChange = revised;
              currentEntry.context = `User feedback: ${feedback}`;
              await applyEdit(revised);
              logger.info("Revised change applied successfully");
            } else {
              console.log(chalk.yellow("❌ Revised change rejected"));
              currentEntry.outcome = "rejected";
              currentEntry.context = `User rejected revision after feedback: ${feedback}`;
              logger.info("User rejected the revised proposal");
            }
          } catch (error) {
            currentEntry.outcome = "error";
            currentEntry.context = `Revision failed: ${error}`;
            logger.error("Failed to apply revised change", error);
            console.log(
              chalk.red(`❌ Failed to apply revised change: ${error}`)
            );
          }
        }
      }
    }
  } catch (error) {
    logger.error("Unexpected error in main loop", error);
    console.error("Error:", error);
  } finally {
    rl.close();
  }
})();
