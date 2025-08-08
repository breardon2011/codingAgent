import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { stat } from "fs/promises";
import os from "os";
import path from "path";
import chalk from "chalk";
import {
  extractIntentWithContext as extractIntent,
  proposeEditWithContext as proposeEdit,
  reviseProposal,
  chatFallback,
  applyEdit, // unified
  applyEdits, // batch
} from "./agent";
import {
  searchCodebase,
  SearchMatch,
  resetSearchFileCache,
} from "./commands/search";
import { validateEdit, validateEdits } from "./commands/validation";
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

async function resolveNavigationPath(rawPath: string): Promise<string | null> {
  const trimmed = rawPath
    .trim()
    .replace(/^(cd|navigate to|go to|change dir(?:ectory)? to)\s+/i, "");
  if (!trimmed) return null;

  const candidates: string[] = [];
  // 1) As-is relative to current cwd
  candidates.push(path.resolve(process.cwd(), trimmed));
  // 2) Tilde expansion
  if (trimmed.startsWith("~")) {
    const expanded = path.join(os.homedir(), trimmed.slice(1));
    candidates.push(expanded);
  }
  // 3) Relative to home for convenience (e.g., "development/someDir")
  candidates.push(path.join(os.homedir(), trimmed));
  // 4) Absolute path if user provided one
  if (path.isAbsolute(trimmed)) candidates.push(trimmed);

  for (const c of candidates) {
    try {
      const s = await stat(c);
      if (s.isDirectory()) return c;
    } catch {}
  }
  return null;
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

function formatEditProposals(proposals: any[]): string {
  const header = chalk.cyan.bold("📝 Proposed Changes");
  const body = proposals
    .map(
      (p, i) =>
        `${chalk.magenta(`#${i + 1}`)} ${formatFilePath(
          p.file,
          p.lineNumber
        )}\n\n${formatCodeDiff(p.original, p.replacement)}`
    )
    .join("\n" + chalk.dim("-".repeat(process.stdout.columns)) + "\n");

  return boxen(body, {
    padding: 1,
    margin: 1,
    borderColor: "cyan",
    title: header,
    titleAlignment: "center",
  });
}

const rl = readline.createInterface({ input, output });

// Test/helper mode: auto-confirm prompts when enabled
const AUTO_YES = (() => {
  const v = (process.env.AGENT_CLI_AUTO_YES || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
})();
const TEST_MODE = (() => {
  const v = (process.env.AGENT_TEST_MODE || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
})();

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

      // Navigation now flows through intent → shell_command "cd ..." steps

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

      // Fast intent path in test mode to avoid LLM
      let intent = TEST_MODE
        ? (() => {
            const trimmed = userInput.trim();
            const shellLike =
              /^(ls|cat|pwd|echo|printf|cd)\b|^(run|execute)\s+/i;
            if (shellLike.test(trimmed)) {
              const cmd = trimmed.replace(/^(run|execute)\s+/i, "");
              return {
                intentType: "edit" as const,
                action: "shell_command" as const,
                target: "project",
                description: "run command",
                command: cmd,
              };
            }
            return {
              intentType: "edit" as const,
              action: "modify_code" as const,
              target: "tmp/cli-e2e.txt",
              description: trimmed,
            };
          })()
        : await extractIntent(userInput);
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
            const confirm = AUTO_YES
              ? "yes"
              : await rl.question(
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

            // Handle persistent directory change for plain `cd` commands
            const trimmedCmd = intent.command.trim();
            const isCdOnly = /^cd\s+[^&|;]+$/i.test(trimmedCmd);
            if (isCdOnly) {
              const target = await resolveNavigationPath(trimmedCmd);
              if (!target) {
                console.log(
                  boxen(
                    chalk.red("❌ Unable to resolve directory for cd command"),
                    {
                      padding: 1,
                      margin: 1,
                      borderColor: "red",
                      title: "❌ Error",
                      titleAlignment: "center",
                    }
                  )
                );
                currentEntry.outcome = "error";
                currentEntry.context = "Failed to resolve cd path";
                continue;
              }
              try {
                process.chdir(target);
                resetSearchFileCache();
                console.log(
                  boxen(chalk.green(`Now in: ${process.cwd()}`), {
                    padding: 1,
                    margin: 1,
                    borderColor: "green",
                    title: "✅ Directory Changed",
                    titleAlignment: "center",
                  })
                );
                currentEntry.outcome = "accepted";
                currentEntry.context = `Changed directory to: ${target}`;
              } catch (e) {
                console.log(
                  boxen(chalk.red(`Failed to change directory: ${e}`), {
                    padding: 1,
                    margin: 1,
                    borderColor: "red",
                    title: "❌ Error",
                    titleAlignment: "center",
                  })
                );
                currentEntry.outcome = "error";
                currentEntry.context = `cd failed: ${e}`;
              }
              continue;
            }

            // Execute non-cd commands in a subprocess
            console.log(chalk.cyan("\n📋 Command Output:"));
            console.log(chalk.dim("─".repeat(process.stdout.columns)));

            const result = await executeShellCommand(intent.command, {
              interactive: true,
              timeout: 60000,
              cwd: process.cwd(),
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

          const aggregatedProposals: any[] = [];
          const stepMatches: { step: any; match: SearchMatch }[] = [];
          const pendingCommands: string[] = [];
          const warningsList: string[] = [];

          for (const step of intent.steps) {
            console.log(chalk.yellow(`\n📝 Step: ${step.description}`));

            if (step.action === "shell_command" && step.command) {
              const safetyCheck = isCommandSafe(step.command);
              if (!safetyCheck.safe) {
                console.log(
                  chalk.red(`❌ Unsafe command: ${safetyCheck.reason}`)
                );
                currentEntry.outcome = "rejected";
                currentEntry.context = `Unsafe command: ${safetyCheck.reason}`;
                return;
              }
              pendingCommands.push(step.command);
              continue;
            }

            const matches = await searchCodebase(step.target, {
              action: step.action,
              target: step.target,
              description: step.description,
            });

            if (matches.length === 0) {
              console.log(chalk.red("❌ No matches found for code change."));
              currentEntry.outcome = "error";
              currentEntry.context = "No matches found";
              return;
            }

            const proposals = await proposeEdit(
              { ...step, intentType: "edit" } as EditIntent,
              matches[0]
            );

            const stepValidations = await validateEdits(proposals);
            const stepInvalids = stepValidations
              .map((v, i) => ({ v, i }))
              .filter(({ v }) => !v.isValid);
            if (stepInvalids.length > 0) {
              const errText = stepInvalids
                .map(
                  ({ v, i }) =>
                    `Edit #${i + 1}:\n${v.errors
                      .map((e) => `• ${e}`)
                      .join("\n")}`
                )
                .join("\n\n");
              console.log(
                boxen(chalk.red(errText), {
                  padding: 1,
                  margin: 1,
                  borderColor: "red",
                  title: "❌ Validation Failed",
                  titleAlignment: "center",
                })
              );
              currentEntry.outcome = "rejected";
              currentEntry.context = "Validation failed";
              return;
            }

            const stepWarnText = stepValidations
              .map((v, i) =>
                v.warnings.length
                  ? `Edit #${i + 1}:\n${v.warnings
                      .map((w) => `• ${w}`)
                      .join("\n")}`
                  : ""
              )
              .filter(Boolean)
              .join("\n\n");
            if (stepWarnText) warningsList.push(stepWarnText);

            aggregatedProposals.push(...proposals);
            stepMatches.push({ step, match: matches[0]! });
          }

          if (warningsList.length) {
            console.log(
              boxen(chalk.yellow(warningsList.join("\n\n")), {
                padding: 1,
                margin: 1,
                borderColor: "yellow",
                title: "⚠️  Warnings",
                titleAlignment: "center",
              })
            );
          }

          if (pendingCommands.length) {
            console.log(
              boxen(
                chalk.yellow(pendingCommands.map((c) => `$ ${c}`).join("\n")),
                {
                  padding: 1,
                  margin: 1,
                  borderColor: "yellow",
                  title: "🔧 Commands to run",
                  titleAlignment: "center",
                }
              )
            );
          }

          if (aggregatedProposals.length) {
            console.log(formatEditProposals(aggregatedProposals));
          }

          const feedback = AUTO_YES
            ? "yes"
            : await rl.question(
                `💬 Accept these ${aggregatedProposals.length} change(s)$$${
                  pendingCommands.length
                    ? ` and ${pendingCommands.length} command(s)`
                    : ""
                }? [Yes / no / critique]: `
              );

          const fb = feedback.trim().toLowerCase();
          if (fb === "yes" || fb === "") {
            for (const cmd of pendingCommands) {
              const trimmedCmd = cmd.trim();
              const isCdOnly = /^cd\s+[^&|;]+$/i.test(trimmedCmd);
              if (isCdOnly) {
                const target = await resolveNavigationPath(trimmedCmd);
                if (!target) {
                  console.log(
                    boxen(
                      chalk.red(
                        "❌ Unable to resolve directory for cd command"
                      ),
                      {
                        padding: 1,
                        margin: 1,
                        borderColor: "red",
                        title: "❌ Command Error",
                        titleAlignment: "center",
                      }
                    )
                  );
                  currentEntry.outcome = "error";
                  currentEntry.context = "Failed to resolve cd path";
                  continue;
                }
                try {
                  process.chdir(target);
                  resetSearchFileCache();
                  console.log(
                    boxen(chalk.green(`Now in: ${process.cwd()}`), {
                      padding: 1,
                      margin: 1,
                      borderColor: "green",
                      title: "✅ Directory Changed",
                      titleAlignment: "center",
                    })
                  );
                } catch (e) {
                  console.log(
                    boxen(chalk.red(`Failed to change directory: ${e}`), {
                      padding: 1,
                      margin: 1,
                      borderColor: "red",
                      title: "❌ Command Error",
                      titleAlignment: "center",
                    })
                  );
                  currentEntry.outcome = "error";
                  currentEntry.context = `cd failed: ${e}`;
                  continue;
                }
                continue;
              }

              console.log(formatCommandExecution(cmd));
              const result = await executeShellCommand(cmd, {
                interactive: true,
                timeout: 60000,
                cwd: process.cwd(),
              });
              if (result.exitCode !== 0) {
                console.log(
                  boxen(chalk.red(`${result.stderr || result.stdout}`), {
                    padding: 1,
                    margin: 1,
                    borderColor: "red",
                    title: "❌ Command Error",
                    titleAlignment: "center",
                  })
                );
                currentEntry.outcome = "error";
                currentEntry.context = `Command failed: ${
                  result.stderr || result.stdout
                }`;
                continue;
              }
            }

            await applyEdits(aggregatedProposals);
            currentEntry.outcome = "accepted";
            currentEntry.finalChange = aggregatedProposals;
            currentEntry.context = "Compound action completed";
            continue;
          } else if (fb === "no") {
            console.log(chalk.yellow("❌ Changes rejected by user"));
            currentEntry.outcome = "rejected";
            currentEntry.context = "User rejected compound action";
            continue;
          } else {
            try {
              const revisedAll: any[] = [];
              for (const { step, match } of stepMatches) {
                const revised = await reviseProposal(
                  feedback,
                  { ...step, intentType: "edit" } as EditIntent,
                  match
                );
                revisedAll.push(...revised);
              }

              const revisedValidations = await validateEdits(revisedAll);
              if (revisedValidations.some((v) => !v.isValid)) {
                console.log(
                  chalk.red("❌ Revised proposal validation failed:")
                );
                currentEntry.outcome = "rejected";
                currentEntry.context = "Revised validation failed";
                continue;
              }

              console.log(chalk.yellow("🔄 Revised proposals:"));
              console.log(formatEditProposals(revisedAll));

              const revisionConfirm = await rl.question(
                `💬 Accept these ${revisedAll.length} revised change(s)? [yes / no]: `
              );

              if (revisionConfirm.trim().toLowerCase() === "yes") {
                currentEntry.outcome = "modified";
                currentEntry.finalChange = revisedAll;
                currentEntry.context = `User feedback: ${feedback}`;
                await applyEdits(revisedAll);
                logger.info("Revised changes applied successfully");
              } else {
                console.log(chalk.yellow("❌ Revised changes rejected"));
                currentEntry.outcome = "rejected";
                currentEntry.context = `User rejected revision after feedback: ${feedback}`;
                logger.info("User rejected the revised proposals");
              }
              continue;
            } catch (error) {
              currentEntry.outcome = "error";
              currentEntry.context = `Revision failed: ${error}`;
              logger.error("Failed to apply revised changes", error);
              console.log(
                chalk.red(`❌ Failed to apply revised changes: ${error}`)
              );
              continue;
            }
          }
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
        logger.debug(
          `Found match in ${match.file} (score: ${match.relevanceScore})`
        );

        const proposals = await proposeEdit(editIntent, match);
        currentEntry.proposal = proposals;
        logger.debug("Generated proposals", proposals);

        // Validate proposals in batch
        const validations = await validateEdits(proposals);

        // If any invalid, show and stop
        const invalids = validations
          .map((v, i) => ({ v, i }))
          .filter(({ v }) => !v.isValid);
        if (invalids.length > 0) {
          const errText = invalids
            .map(
              ({ v, i }) =>
                `Edit #${i + 1}:\n${v.errors.map((e) => `• ${e}`).join("\n")}`
            )
            .join("\n\n");
          console.log(
            boxen(chalk.red(errText), {
              padding: 1,
              margin: 1,
              borderColor: "red",
              title: "❌ Validation Failed",
              titleAlignment: "center",
            })
          );
          currentEntry.outcome = "rejected";
          currentEntry.context = "Validation failed";
          continue;
        }

        // Show warnings (non-blocking)
        const warnText = validations
          .map((v, i) =>
            v.warnings.length
              ? `Edit #${i + 1}:\n${v.warnings.map((w) => `• ${w}`).join("\n")}`
              : ""
          )
          .filter(Boolean)
          .join("\n\n");
        if (warnText) {
          console.log(
            boxen(chalk.yellow(warnText), {
              padding: 1,
              margin: 1,
              borderColor: "yellow",
              title: "⚠️  Warnings",
              titleAlignment: "center",
            })
          );
        }

        // Preview all proposals together
        console.log(formatEditProposals(proposals));

        const feedback = AUTO_YES
          ? "yes"
          : await rl.question(
              `💬 Accept these ${proposals.length} change(s)? [Yes / no / critique]: `
            );

        if (feedback.trim().toLowerCase() === "yes" || feedback.trim() === "") {
          try {
            await applyEdits(proposals);
            currentEntry.outcome = "accepted";
            currentEntry.finalChange = proposals;
            logger.info("Changes applied successfully");
          } catch (error) {
            currentEntry.outcome = "error";
            currentEntry.context = `Apply failed: ${error}`;
            logger.error("Failed to apply changes", error);
            console.log(chalk.red(`❌ Failed to apply changes: ${error}`));
          }
        } else if (feedback.trim().toLowerCase() === "no") {
          // Handle explicit rejection
          console.log(chalk.yellow("❌ Changes rejected by user"));
          currentEntry.outcome = "rejected";
          currentEntry.context = "User explicitly rejected the proposals";
          logger.info("User rejected the proposals");
        } else {
          // Handle critique/revision requests (arrays supported)
          try {
            const revised = await reviseProposal(feedback, editIntent, match);
            const revisedValidations = await validateEdits(revised);

            if (revisedValidations.some((v) => !v.isValid)) {
              console.log(chalk.red("❌ Revised proposal validation failed:"));
              currentEntry.outcome = "rejected";
              currentEntry.context = "Revised validation failed";
              continue;
            }

            console.log(chalk.yellow("🔄 Revised proposals:"));
            console.log(formatEditProposals(revised));

            // Ask for confirmation on the revision
            const revisionConfirm = await rl.question(
              `💬 Accept these ${revised.length} revised change(s)? [yes / no]: `
            );

            if (revisionConfirm.trim().toLowerCase() === "yes") {
              currentEntry.outcome = "modified";
              currentEntry.finalChange = revised;
              currentEntry.context = `User feedback: ${feedback}`;
              await applyEdits(revised);
              logger.info("Revised changes applied successfully");
            } else {
              console.log(chalk.yellow("❌ Revised changes rejected"));
              currentEntry.outcome = "rejected";
              currentEntry.context = `User rejected revision after feedback: ${feedback}`;
              logger.info("User rejected the revised proposals");
            }
          } catch (error) {
            currentEntry.outcome = "error";
            currentEntry.context = `Revision failed: ${error}`;
            logger.error("Failed to apply revised changes", error);
            console.log(
              chalk.red(`❌ Failed to apply revised changes: ${error}`)
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
