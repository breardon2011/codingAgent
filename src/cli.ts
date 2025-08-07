import readline from "readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { callAgent } from "./agent";
import chalk from "chalk";

const rl = readline.createInterface({ input, output });

console.log(chalk.green("🤖 Coding Agent ready. Type 'exit' to quit."));

(async () => {
  while (true) {
    const query = await rl.question(chalk.blue("You > "));
    if (query.trim().toLowerCase() === "exit") break;

    const response = await callAgent(query);
    console.log(chalk.yellow("Agent >"), response);
  }

  rl.close();
})();
