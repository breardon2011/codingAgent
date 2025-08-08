# Coding Agent

A conversational coding assistant that can search your codebase, propose multi-file edits, validate and apply changes, and safely execute shell commands. Built with OpenAI via `ai` SDK, Zod-validated schemas, and an interactive CLI.

## Quick Start

```bash
pnpm install
pnpm start
```

Type your request at the prompt. Examples:

- "Create a folder `server` with a basic Node `server.js` and an `index.html`"
- "Install express"
- "Navigate to ~/development/my-app and add a healthcheck route"

## Core Features

- Intent classification

  - Classifies input as a question or an edit intent
  - Edit actions: `add_code`, `modify_code`, `fix_error`, `refactor`, `config_change`, `shell_command`, `compound_action`
  - Robust JSON schema (Zod) with retries to correct invalid LLM output

- Compound actions (one-shot review)

  - Aggregates all step proposals and shell commands
  - Presents a single preview for acceptance / critique / rejection
  - After acceptance: runs commands (with safety checks) and applies all edits

- Safe shell execution

  - Security checks with configurable safety mode
  - Interactive preview and confirmation
  - Special handling for `cd` (persistently changes working directory)

- Code search and planning

  - Lightweight repository scan with language-aware ranking
  - LLM-assisted search planning and optional re-ranking
  - Suggests new-file candidates when no strong matches exist

- Proposal validation

  - Preflight static checks (paths, dangerous content)
  - LLM validator supplies warnings/errors per proposal

- Conversation memory
  - Tracks recent context and outcomes
  - Surfaces detected user patterns

## Navigation and Working Directory

- To change directories, simply ask (e.g., "cd ~/dev/app", "go to ../services").
- The agent treats navigation as a shell command; on acceptance, it resolves the path and calls `process.chdir(...)` so future searches and commands operate in the new directory.

## Confirmations

- Press Enter for "yes" at confirmations:
  - Accept changes: `[Yes / no / critique]`
  - Execute command: `[Yes/no]`
- Typing `no` or a critique will reject or revise as appropriate.

## Scripts

- `pnpm start` – run the interactive CLI
- `pnpm test` – run evaluations

## Configuration

- Environment: `.env` is loaded automatically (see `dotenv`).
- TypeScript: see `tsconfig.json` (Node types enabled).
- Shell safety: `AGENT_SHELL_SAFETY=strict|relaxed|off` (default: `strict`).

## Notes

- Large outputs are cleaned of Markdown fences before JSON parsing.
- New files are supported by using empty `original` and `lineNumber: null` in proposals.

## License

ISC
