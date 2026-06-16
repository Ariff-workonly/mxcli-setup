# mxcli-setup-olc

Automates [mxcli](https://github.com/mendixlabs/mxcli) setup for Mendix projects. Downloads the correct mxcli binary for your platform, initializes it with all supported AI tools, adds AI-agent skills, and sets up a shared knowledge base that AI agents maintain across sessions.

## Quick Start

Run from your **Mendix project root**:

```bash
npx mxcli-setup-olc
```

Or with an explicit path:

```bash
npx mxcli-setup-olc /path/to/mendix-project
```

## What It Does

1. **Downloads mxcli** — fetches the latest release binary for your OS/architecture into `.tools/mxcli/`
2. **Runs `mxcli init --all-tools`** — initializes mxcli with all supported AI tools (Claude, OpenCode, Cursor, Windsurf, Continue.dev, Aider)
3. **Adds Mendix Developer Skill** — copies the AI skill file to `.ai-context/skills/` with guardrails for `.mpr` inspection, microflow tracing, SCSS conventions, and more
4. **Updates `.gitignore`** — appends entries for AI/mxcli generated files
5. **Creates knowledge base** — generates a `project-knowledge-base.md` template where AI agents document what they learn about the project
6. **Wires up knowledge base instructions** — appends instructions to `AGENTS.md` and `CLAUDE.md` telling AI agents to read and update the knowledge base every session

## How the Knowledge Base Works

After setup, a `project-knowledge-base.md` file lives at the project root. AI agents are instructed (via `AGENTS.md`, `CLAUDE.md`, and the Mendix Developer Skill) to:

- **Read it** at the start of every session to learn what previous agents discovered
- **Update it** when they find new information — module purposes, entity relationships, microflow traces, architectural patterns, gotchas

This creates a persistent memory across AI sessions, so agents don't re-discover the same things.

## CLI Usage

```
npx mxcli-setup-olc [project-path]

Arguments:
  project-path    Path to the Mendix project root (default: current directory)

Options:
  --help, -h      Show help
  --version, -v   Show version
```

## Global Install

```bash
npm install -g mxcli-setup-olc
mxcli-setup-olc
```

## Prerequisites

- **Node.js** >= 14
- **Internet access** (downloads mxcli from GitHub releases)
- Run from a **Mendix project directory**

## Supported Platforms

| OS | Architecture |
|----|-------------|
| Windows | x64, arm64 |
| macOS | x64 (Intel), arm64 (Apple Silicon) |
| Linux | x64, arm64 |

## Re-running

Safe to run multiple times. It skips steps that are already done (existing binary, existing knowledge base) and only appends new `.gitignore` entries or knowledge base instructions if they're missing.
