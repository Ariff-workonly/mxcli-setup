# mxcli-setup-olc

Automates [mxcli](https://github.com/mendixlabs/mxcli) setup for Mendix projects. Downloads the correct mxcli binary for your platform, initializes it with Claude Code and universal documentation, adds AI-agent skills, and sets up a tiered knowledge base that AI agents maintain across sessions.

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
2. **Runs `mxcli init`** — initializes mxcli with Claude Code and universal documentation (`AGENTS.md`, `.ai-context/skills/`)
3. **Creates `olc-config.json`** — configuration file to enable/disable features (see [Configuration](#configuration))
4. **Adds AI skills** — copies the Mendix Developer Skill and Mendix Review Checklist to `.ai-context/skills/`
5. **Updates `.gitignore`** — appends entries for AI/mxcli generated files
6. **Creates tiered knowledge base** — generates a summary index and detail files for structured AI memory
7. **Wires up agent instructions** — appends knowledge base and review checklist instructions to `AGENTS.md` and `CLAUDE.md`

## Configuration

On first run, an `olc-config.json` file is created in the project root:

```json
{
  "IsKeepKnowledgebase": true,
  "IsKeepReviewChecklist": true
}
```

| Flag | Default | What it controls |
|---|---|---|
| `IsKeepKnowledgebase` | `true` | Creates and maintains the tiered knowledge base. When `false`, AI agents skip all knowledge base reads and writes. |
| `IsKeepReviewChecklist` | `true` | Adds the review checklist skill and notice. When `false`, AI agents skip project reviews. |

These flags control both **setup-time** (whether files are created) and **runtime** (whether AI agents use them). To disable a feature mid-project, set the flag to `false` — the AI agent checks `olc-config.json` before reading or updating the knowledge base or performing reviews.

## How the Knowledge Base Works

The knowledge base uses a **tiered structure** to keep AI context efficient:

```
project-knowledge-base.md          ← Summary index (read every session, <200 lines)
knowledge-base/
  ├── modules.md                   ← Module details (read when working on modules)
  ├── entities.md                  ← Entity relationships (read when working on domain model)
  ├── microflows.md                ← Microflow traces (read when working on logic)
  ├── business-flow.md             ← Business logic and process flows
  └── archive.md                   ← Old/resolved entries (read only for history)
```

AI agents are instructed to:

- **Read the index** at the start of every session (lightweight)
- **Load detail files only** when working on that specific area
- **Write findings** to the appropriate detail file, not the index
- **Compress or archive** entries when the index exceeds 200 lines

This prevents the knowledge base from growing unbounded and consuming excessive tokens.

## Project Review

AI agents can review a completed Mendix project against a standardized checklist. Simply ask the agent:

> "Review this project"

The agent reads the review checklist from `.ai-context/skills/mendix-review-checklist.md` and inspects the `.mpr` model across 9 categories:

1. **Module Structure** — responsibility, naming, dependencies
2. **Domain Model** — entities, attributes, associations
3. **Microflow Quality** — naming conventions, logic, performance
4. **Page and UI Quality** — structure, widgets, SCSS
5. **Security** — access rules, least privilege, XPath constraints
6. **Navigation** — menu structure, role-based visibility
7. **Integration** — REST/SOAP error handling, credential storage
8. **Documentation** — knowledge base completeness
9. **Git hygiene** — gitignore, commit quality

Each check produces a **PASS / WARN / FAIL / SKIP** verdict. The agent generates a structured report saved to `outputs/review-report-<date>.md`.

The review checklist can be updated in `assets/mendix-review-checklist.md` to reflect evolving team standards.

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

Safe to run multiple times. It skips steps that are already done (existing binary, existing knowledge base, existing config) and only appends new `.gitignore` entries or agent instructions if they're missing. Features can be toggled anytime via `olc-config.json`.
