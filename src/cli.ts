import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";
import chalk from "chalk";
import {
  extractIntentWithContext as extractIntent,
  proposeEditWithContext as proposeEdit,
  reviseProposal,
  chatFallback,
  applyEdit, // unified
} from "./agent";
import { searchCodebase, SearchMatch } from "./commands/search";
import { validateEdit } from "./commands/validation";
import { parseError, suggestFix } from "./commands/errorParser";
import { logger } from "./utils/logger";
import { conversationHistory } from "./utils/conversationHistory";
import type { EditIntent } from "./domain/intent";
import { executeShellCommand, isCommandSafe } from "./commands/shell";
import boxen from "boxen"; // We'll need to add this package
import { diffLines } from "diff"; // We'll need to add this package

function formatCodeDiff(original: string, replacement: string): string {
  const differences = diffLines(original || "", replacement || "");
  return differences
    .map((part) => {
      if (part.added) {
        return chalk.green(
          part.value
            .split("\n")
            .map((line) => `+ ${line}`)
            .join("\n")
        );
      }
      if (part.removed) {
        return chalk.red(
          part.value
            .split("\n")
            .map((line) => `- ${line}`)
            .join("\n")
        );
      }
      return chalk.dim(
        part.value
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n")
      );
    })
    .join("\n");
}

function formatFilePath(file: string, lineNumber?: number | null): string {
  return chalk.cyan(`📄 ${file}${lineNumber ? `:${lineNumber}` : ""}`);
}

function formatCommandExecution(command: string): string {
  return boxen(chalk.yellow(`$ ${command}`), {
    padding: 1,
    margin: 1,
    borderColor: "yellow",
    title: "🔧 Executing Command",
    titleAlignment: "center",
  });
}

function formatEditProposal(proposal: any): string {
  const header = chalk.cyan.bold("📝 Proposed Changes");
  const filePath = formatFilePath(proposal.file, proposal.lineNumber);
  const diff = formatCodeDiff(proposal.original, proposal.replacement);

  return boxen(`${filePath}\n\n${diff}`, {
    padding: 1,
    margin: 1,
    borderColor: "cyan",
    title: header,
    titleAlignment: "center",
  });
}

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

        // Handle shell commands directly
        if (
          intent.intentType === "edit" &&
          intent.action === "shell_command" &&
          intent.command
        ) {
          try {
            // Check if the command is safe
            const safetyCheck = isCommandSafe(intent.command);
            if (!safetyCheck.safe) {
              console.log(
                boxen(chalk.red(`⚠️  ${safetyCheck.reason}`), {
                  padding: 1,
                  margin: 1,
                  borderColor: "red",
                  title: "❌ Unsafe Command",
                  titleAlignment: "center",
                })
              );
              currentEntry.outcome = "rejected";
              currentEntry.context = `Unsafe command: ${safetyCheck.reason}`;
              continue;
            }

            // Show command preview
            console.log(formatCommandExecution(intent.command));

            // Ask for confirmation before executing
            const confirm = await rl.question(
              chalk.yellow("⚡ Execute this command? [yes/no]: ")
            );

            if (confirm.toLowerCase() !== "yes") {
              console.log(
                boxen(chalk.yellow("Command execution cancelled by user"), {
                  padding: 1,
                  margin: 1,
                  borderColor: "yellow",
                  title: "⏹️  Cancelled",
                  titleAlignment: "center",
                })
              );
              currentEntry.outcome = "rejected";
              currentEntry.context = "User cancelled command execution";
              continue;
            }

            // Execute the command
            console.log(chalk.cyan("\n📋 Command Output:"));
            console.log(chalk.dim("─".repeat(process.stdout.columns)));

            const result = await executeShellCommand(intent.command, {
              interactive: true,
              timeout: 60000,
            });

            console.log(chalk.dim("─".repeat(process.stdout.columns)));

            if (result.exitCode === 0) {
              console.log(
                boxen(chalk.green("Command completed successfully"), {
                  padding: 1,
                  margin: 1,
                  borderColor: "green",
                  title: "✅ Success",
                  titleAlignment: "center",
                })
              );
              currentEntry.outcome = "accepted";
              currentEntry.context = `Command executed: ${intent.command}`;
            } else {
              console.log(
                boxen(chalk.red(`${result.stderr || result.stdout}`), {
                  padding: 1,
                  margin: 1,
                  borderColor: "red",
                  title: "❌ Error",
                  titleAlignment: "center",
                })
              );
              currentEntry.outcome = "error";
              currentEntry.context = `Command failed: ${
                result.stderr || result.stdout
              }`;
            }
            continue;
          } catch (error) {
            console.log(
              boxen(chalk.red(`${error}`), {
                padding: 1,
                margin: 1,
                borderColor: "red",
                title: "❌ Error",
                titleAlignment: "center",
              })
            );
            currentEntry.outcome = "error";
            currentEntry.context = `Command error: ${error}`;
            continue;
          }
        }

        // Add after the intent extraction
        if (
          intent.intentType === "edit" &&
          intent.action === "compound_action" &&
          intent.steps
        ) {
          console.log(chalk.cyan("🔄 Executing compound action:"));

          for (const step of intent.steps) {
            console.log(chalk.yellow(`\n📝 Step: ${step.description}`));

            if (step.action === "shell_command" && step.command) {
              // Execute shell command
              const safetyCheck = isCommandSafe(step.command);
              if (!safetyCheck.safe) {
                console.log(
                  chalk.red(`❌ Unsafe command: ${safetyCheck.reason}`)
                );
                currentEntry.outcome = "rejected";
                currentEntry.context = `Unsafe command: ${safetyCheck.reason}`;
                continue;
              }

              console.log(chalk.yellow(`Executing: ${step.command}`));
              const result = await executeShellCommand(step.command, {
                interactive: true,
                timeout: 60000,
              });

              if (result.exitCode !== 0) {
                console.log(
                  chalk.red(
                    `❌ Command failed: ${result.stderr || result.stdout}`
                  )
                );
                currentEntry.outcome = "error";
                currentEntry.context = `Command failed: ${
                  result.stderr || result.stdout
                }`;
                return; // Exit the entire compound action if a command fails
              }
            } else {
              // Handle code changes
              const matches = await searchCodebase(step.target, {
                action: step.action,
                target: step.target,
                description: step.description,
              });

              if (matches.length === 0) {
                console.log(chalk.red("❌ No matches found for code change."));
                currentEntry.outcome = "error";
                currentEntry.context = "No matches found";
                return; // Exit the entire compound action if no matches found
              }

              const proposal = await proposeEdit(
                {
                  ...step,
                  intentType: "edit",
                } as EditIntent,
                matches[0]
              );
              console.log(formatEditProposal(proposal));

              const confirm = await rl.question(
                chalk.yellow("Accept this change? [yes/no]: ")
              );

              if (confirm.toLowerCase() === "yes") {
                await applyEdit(proposal);
              } else {
                console.log(
                  chalk.red("❌ Change rejected, stopping compound action.")
                );
                currentEntry.outcome = "rejected";
                currentEntry.context = "User rejected a step";
                return; // Exit the entire compound action if user rejects any change
              }
            }
          }

          // Only reach here if all steps completed successfully
          currentEntry.outcome = "accepted";
          currentEntry.context = "Compound action completed";
          return;
        }

        // At this point TypeScript knows intent is an edit intent
        const editIntent = intent as EditIntent;

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
          console.log(
            boxen(
              validation.errors.map((err) => chalk.red(`• ${err}`)).join("\n"),
              {
                padding: 1,
                margin: 1,
                borderColor: "red",
                title: "❌ Validation Failed",
                titleAlignment: "center",
              }
            )
          );
          currentEntry.outcome = "rejected";
          currentEntry.context = "Validation failed";
          continue;
        }

        if (validation.warnings.length > 0) {
          console.log(
            boxen(
              validation.warnings
                .map((warn) => chalk.yellow(`• ${warn}`))
                .join("\n"),
              {
                padding: 1,
                margin: 1,
                borderColor: "yellow",
                title: "⚠️  Warnings",
                titleAlignment: "center",
              }
            )
          );
        }

        console.log(formatEditProposal(proposal));

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
