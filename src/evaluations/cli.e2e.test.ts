import { expect } from "chai";
import { describe, it, before, after } from "mocha";
import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";

const projectRoot = process.cwd();
const cliPath = path.join(projectRoot, "src", "cli.ts");
const preloadMock = path.join(
  projectRoot,
  "src",
  "evaluations",
  "helpers",
  "mock-cli-agent.js"
);
const TMP_DIR = path.join(projectRoot, "tmp");
const TMP_FILE = path.join(TMP_DIR, "cli-e2e.txt");

function runCli(inputs: string[], opts: { timeout?: number } = {}) {
  return new Promise<{ stdout: string; stderr: string; code: number }>(
    (resolve) => {
      const child = spawn(
        process.execPath,
        ["-r", "ts-node/register", "-r", preloadMock, cliPath],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            NO_COLOR: "1",
            FORCE_COLOR: "0",
            AGENT_TEST_MODE: "1",
            AGENT_CLI_AUTO_YES: "1",
          },
          stdio: ["pipe", "pipe", "pipe"],
        }
      );

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));

      (async () => {
        for (const line of inputs) {
          await new Promise((r) => setTimeout(r, 50));
          child.stdin.write(line + "\n");
        }
      })();

      const timer =
        opts.timeout && opts.timeout > 0
          ? setTimeout(() => {
              try {
                child.kill("SIGTERM");
                setTimeout(() => child.kill("SIGKILL"), 500);
              } catch {}
            }, opts.timeout)
          : undefined;

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({ stdout, stderr, code: code ?? 0 });
      });
    }
  );
}

describe("CLI E2E", function () {
  this.timeout(20000);

  before(async () => {
    await fs.mkdir(TMP_DIR, { recursive: true });
    try {
      await fs.unlink(TMP_FILE);
    } catch {}
  });

  after(async () => {
    // left for inspection
  });

  it("lists files via shell (ls)", async () => {
    const { stdout, code } = await runCli(["ls -1 src", "yes", "exit"], {
      timeout: 8000,
    });
    expect(code).to.equal(0);
    expect(stdout).to.include("Executing Command");
    expect(stdout).to.include("✅ Success");
    expect(stdout).to.match(/agent\.ts/);
    expect(stdout).to.match(/cli\.ts/);
  });

  it("reads a file via shell (cat package.json)", async () => {
    const { stdout, code } = await runCli(["cat package.json", "yes", "exit"], {
      timeout: 8000,
    });
    expect(code).to.equal(0);
    expect(stdout).to.include('"name": "codingagent"');
  });

  it("writes then appends via shell redirection", async () => {
    let res = await runCli(
      [
        `printf "hello" > ${path.relative(projectRoot, TMP_FILE)}`,
        "yes",
        "exit",
      ],
      { timeout: 8000 }
    );
    expect(res.code).to.equal(0);
    let content = await fs.readFile(TMP_FILE, "utf8");
    expect(content).to.include("hello");

    res = await runCli(
      [
        `printf " world" >> ${path.relative(projectRoot, TMP_FILE)}`,
        "yes",
        "exit",
      ],
      { timeout: 8000 }
    );
    expect(res.code).to.equal(0);
    content = await fs.readFile(TMP_FILE, "utf8");
    expect(content).to.include("hello world");
  });

  it("searches and edits via agent flow", async () => {
    const { stdout, code } = await runCli(
      [
        "add a note to tmp/cli-e2e.txt",
        // auto-yes handled by env
        "exit",
      ],
      { timeout: 10000 }
    );
    expect(code).to.equal(0);
    expect(stdout).to.include("Proposed Changes");
    // Prompt text may vary; ensure acceptance flow happened by checking success markers after apply
    const content = await fs.readFile(TMP_FILE, "utf8");
    expect(content).to.include("// added-by-cli-test");
  });

  it("runs pwd and normalizes output", async () => {
    const { stdout, code } = await runCli(["pwd", "yes", "exit"], {
      timeout: 8000,
    });
    expect(code).to.equal(0);
    expect(stdout).to.include(projectRoot);
  });
});
