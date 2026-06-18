#!/usr/bin/env node
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const GITIGNORE_ENTRIES = [
  '.ai-context',
  '.claude',
  '.devcontainer',
  '.playwright',
  'AGENTS.md',
  'CLAUDE.md',
  '.playwright-mcp',
  '.mxcli',
  '.mxcli-logs',
  '.mxcli-plugins',
  '.mxcli-plugins-lock.json',
  '.mxcli-plugins-lock.json.bak',
  '/outputs/',
  '*.mdl',
  'project-knowledge-base.md',
  '/knowledge-base/',
  'olc-config.json',
  '/.tools/',
];

const PLATFORM_MAP = {
  'win32-x64':   { assetPattern: /mxcli-windows-amd64\.exe$/,   binaryName: 'mxcli.exe' },
  'win32-arm64': { assetPattern: /mxcli-windows-arm64\.exe$/,   binaryName: 'mxcli.exe' },
  'darwin-x64':  { assetPattern: /mxcli-darwin-amd64$/,         binaryName: 'mxcli' },
  'darwin-arm64':{ assetPattern: /mxcli-darwin-arm64$/,         binaryName: 'mxcli' },
  'linux-x64':   { assetPattern: /mxcli-linux-amd64$/,          binaryName: 'mxcli' },
  'linux-arm64': { assetPattern: /mxcli-linux-arm64$/,          binaryName: 'mxcli' },
};

function log(msg) {
  console.log(`[mxcli-setup-olc] ${msg}`);
}

function warn(msg) {
  console.warn(`[mxcli-setup-olc] WARNING: ${msg}`);
}

function fail(msg) {
  console.error(`[mxcli-setup-olc] ERROR: ${msg}`);
  process.exit(1);
}

function printHelp() {
  const pkg = require('./package.json');
  console.log(`
  ${pkg.name} v${pkg.version}

  Automates mxcli setup for Mendix projects.

  Usage:
    npx mxcli-setup-olc [project-path]
    mxcli-setup-olc [project-path]

  Arguments:
    project-path    Path to the Mendix project root (default: current directory)

  Options:
    --help, -h      Show this help message
    --version, -v   Show version number

  What it does:
    1. Downloads the latest mxcli binary for your platform
    2. Runs mxcli init with all supported AI tools
    3. Adds the Mendix Developer Skill and Review Checklist to .ai-context/skills/
    4. Appends AI/mxcli entries to .gitignore
    5. Creates a project-knowledge-base.md template
    6. Wires up knowledge base instructions in AGENTS.md and CLAUDE.md
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--version' || arg === '-v') {
      const pkg = require('./package.json');
      console.log(pkg.version);
      process.exit(0);
    }
  }
  return args.find(a => !a.startsWith('-')) || null;
}

function getProjectRoot() {
  const cliPath = parseArgs();
  if (cliPath) return path.resolve(cliPath);
  return process.env.INIT_CWD || process.cwd();
}

function getPlatformKey() {
  const platform = os.platform();
  const arch = os.arch();
  const key = `${platform}-${arch}`;
  if (!PLATFORM_MAP[key]) {
    fail(`Unsupported platform: ${key}. Supported: ${Object.keys(PLATFORM_MAP).join(', ')}`);
  }
  return key;
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'mxcli-olc-setup' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpsGetJson(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let settled = false;

    function finish(err) {
      if (settled) return;
      settled = true;
      if (err) {
        file.close(() => {
          try { fs.unlinkSync(destPath); } catch (_) {}
          reject(err);
        });
      } else {
        process.stdout.write('\n');
        file.close(resolve);
      }
    }

    file.on('error', finish);

    function doDownload(dlUrl, redirects) {
      if (redirects > 10) { finish(new Error('Too many redirects')); return; }
      const proto = dlUrl.startsWith('https') ? https : require('http');
      const req = proto.get(dlUrl, { headers: { 'User-Agent': 'mxcli-olc-setup' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          doDownload(res.headers.location, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          finish(new Error(`HTTP ${res.statusCode} downloading ${dlUrl}`));
          return;
        }
        const total = parseInt(res.headers['content-length'], 10);
        let downloaded = 0;
        res.on('data', chunk => {
          downloaded += chunk.length;
          if (total) {
            const pct = Math.round((downloaded / total) * 100);
            process.stdout.write(`\r[mxcli-setup-olc] Downloading mxcli... ${pct}%`);
          }
        });
        res.pipe(file);
        file.on('finish', () => finish(null));
      });
      req.on('error', finish);
    }
    doDownload(url, 0);
  });
}

async function getLatestRelease() {
  log('Fetching latest mxcli release info...');
  const release = await httpsGetJson('https://api.github.com/repos/mendixlabs/mxcli/releases/latest');
  return release;
}

function findAsset(release, platformKey) {
  const { assetPattern } = PLATFORM_MAP[platformKey];
  const asset = release.assets.find(a => assetPattern.test(a.name));
  if (!asset) {
    fail(`No mxcli release asset found for ${platformKey}. Available: ${release.assets.map(a => a.name).join(', ')}`);
  }
  return asset;
}

async function downloadMxcli(projectRoot, release, platformKey) {
  const { binaryName } = PLATFORM_MAP[platformKey];
  const installDir = path.join(projectRoot, '.tools', 'mxcli');
  const binaryPath = path.join(installDir, binaryName);

  if (fs.existsSync(binaryPath)) {
    log(`mxcli binary already exists at ${binaryPath}`);
    try {
      const result = execSync(`"${binaryPath}" --version`, { encoding: 'utf8', stdio: 'pipe' });
      log(`Existing mxcli version: ${result.trim()}`);
      return binaryPath;
    } catch (e) {
      warn('Existing binary failed --version check, will re-download');
    }
  }

  fs.mkdirSync(installDir, { recursive: true });

  const asset = findAsset(release, platformKey);
  log(`Downloading mxcli ${release.tag_name}: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)...`);

  const tmpPath = path.join(os.tmpdir(), asset.name);
  await downloadFile(asset.browser_download_url, tmpPath);

  fs.copyFileSync(tmpPath, binaryPath);
  try { fs.unlinkSync(tmpPath); } catch (_) {}

  if (os.platform() !== 'win32') {
    fs.chmodSync(binaryPath, 0o755);
  }

  log(`mxcli installed to ${binaryPath}`);
  return binaryPath;
}

function runMxcliInit(binaryPath, projectRoot) {
  log('Running mxcli init...');
  try {
    const result = execSync(
      `"${binaryPath}" init "${projectRoot}"`,
      { encoding: 'utf8', stdio: 'pipe', cwd: projectRoot }
    );
    log('mxcli init completed successfully');
  } catch (e) {
    warn(`mxcli init had issues (may already be initialized): ${e.message}`);
    if (e.stdout) console.log(e.stdout);
    if (e.stderr) console.error(e.stderr);
  }
}

function addCustomSkills(projectRoot, config) {
  const skillDir = path.join(projectRoot, '.ai-context', 'skills');
  fs.mkdirSync(skillDir, { recursive: true });

  const skills = [
    { file: 'mendix-developer-skill.md', label: 'Mendix Developer Skill', always: true },
    { file: 'mendix-review-checklist.md', label: 'Mendix Review Checklist', always: false },
  ];

  for (const { file, label, always } of skills) {
    if (!always && !config.IsKeepReviewChecklist) {
      log(`${label} disabled via olc-config.json, skipping`);
      continue;
    }
    const src = path.join(__dirname, 'assets', file);
    if (!fs.existsSync(src)) {
      warn(`${label} file not found at ${src}, skipping`);
      continue;
    }
    fs.copyFileSync(src, path.join(skillDir, file));
    log(`${label} added to .ai-context/skills/`);
  }
}

function updateGitignore(projectRoot) {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  let existingContent = '';

  if (fs.existsSync(gitignorePath)) {
    existingContent = fs.readFileSync(gitignorePath, 'utf8');
  }

  const existingLines = existingContent.split(/\r?\n/).map(l => l.trim());

  const missing = GITIGNORE_ENTRIES.filter(entry => {
    return !existingLines.some(line => line === entry || line === entry.replace(/^\//, ''));
  });

  if (missing.length === 0) {
    log('All .gitignore entries already present, nothing to add');
    return;
  }

  let append = '';
  if (existingContent && !existingContent.endsWith('\n')) append += '\n';
  append += '\n# mxcli-olc-setup auto-generated\n';
  append += missing.join('\n') + '\n';

  fs.appendFileSync(gitignorePath, append, 'utf8');
  log(`Added ${missing.length} entries to .gitignore: ${missing.join(', ')}`);
}

function createKnowledgeBase(projectRoot) {
  const kbPath = path.join(projectRoot, 'project-knowledge-base.md');
  const kbDir = path.join(projectRoot, 'knowledge-base');

  if (!fs.existsSync(kbPath)) {
    const index = `# Mendix Project Knowledge Base

> This is the **summary index** — read this every session. Keep it under 200 lines.
> Detailed findings go in the \`knowledge-base/\` folder. Only load detail files when working on that area.

## Project Overview

<!-- Add project description, purpose, and key stakeholders -->

## Architecture Notes

<!-- Document architectural decisions, patterns, and constraints -->

## Module Map

<!-- List modules and their responsibilities -->

## Change Log

<!-- Agents: add dated entries when you discover or change something important -->
`;
    fs.writeFileSync(kbPath, index, 'utf8');
    log('Created project-knowledge-base.md (summary index)');
  } else {
    log('project-knowledge-base.md already exists, skipping');
  }

  fs.mkdirSync(kbDir, { recursive: true });

  const detailFiles = [
    {
      file: 'modules.md',
      content: `# Module Details

> Detailed documentation of each module's purpose, responsibilities, and dependencies.
> Only read this file when working on module structure or organization.

<!-- Agents: add module documentation here as you discover it -->
`,
    },
    {
      file: 'entities.md',
      content: `# Entity Relationships

> Detailed documentation of domain entities, attributes, and associations.
> Only read this file when working on the domain model.

<!-- Agents: add entity documentation here as you discover it -->
`,
    },
    {
      file: 'microflows.md',
      content: `# Important Microflows

> Detailed traces and documentation of critical microflows.
> Only read this file when working on microflow logic.

<!-- Agents: add microflow traces and documentation here -->
`,
    },
    {
      file: 'business-flow.md',
      content: `# Business Flow

> Documentation of business logic, workflows, rules, and process flows.
> Only read this file when working on business requirements or logic.

<!-- Agents: document business rules, decision logic, approval flows, and process steps here -->
`,
    },
    {
      file: 'archive.md',
      content: `# Knowledge Base Archive

> Old or resolved entries moved here from the main knowledge base or detail files.
> Only read this file if you need historical context.

<!-- Agents: move outdated entries here instead of deleting them -->
`,
    },
  ];

  for (const { file, content } of detailFiles) {
    const filePath = path.join(kbDir, file);
    if (fs.existsSync(filePath)) continue;
    fs.writeFileSync(filePath, content, 'utf8');
  }
  log('Created knowledge-base/ detail files (modules, entities, microflows, business-flow, archive)');
}

const KNOWLEDGE_BASE_NOTICE = `

## Project Knowledge Base

**Before reading or updating the knowledge base, check \`olc-config.json\` in the project root.** If \`IsKeepKnowledgebase\` is \`false\`, skip all knowledge base operations — do not read, update, or reference the knowledge base files.

A tiered knowledge base exists for this project:

- \`project-knowledge-base.md\` — **Summary index (read every session).** Keep under 200 lines.
- \`knowledge-base/modules.md\` — Module details. Read when working on module structure.
- \`knowledge-base/entities.md\` — Entity relationships. Read when working on the domain model.
- \`knowledge-base/microflows.md\` — Microflow traces. Read when working on microflow logic.
- \`knowledge-base/business-flow.md\` — Business logic and process flows. Read when working on business requirements.
- \`knowledge-base/archive.md\` — Old/resolved entries. Read only for historical context.

**Rules:**
1. Always read \`project-knowledge-base.md\` at the start of every session.
2. Only load detail files when working on that specific area.
3. Write new findings to the appropriate detail file, not the index.
4. Update the index only with brief summaries and pointers.
5. When the index exceeds 200 lines, compress or move entries to detail files.
6. Move outdated entries to \`knowledge-base/archive.md\` instead of deleting.
`;

const REVIEW_CHECKLIST_NOTICE = `

## Project Review

**Before performing a review, check \`olc-config.json\` in the project root.** If \`IsKeepReviewChecklist\` is \`false\`, do not perform the review.

When asked to review this Mendix project, follow the checklist at \`.ai-context/skills/mendix-review-checklist.md\`. Inspect the \`.mpr\` model against each section and produce a structured report with PASS/WARN/FAIL/SKIP verdicts. Save the report to \`outputs/review-report-<date>.md\`.
`;

function appendReviewChecklistNotice(projectRoot) {
  const targets = ['AGENTS.md', 'CLAUDE.md'];
  for (const filename of targets) {
    const filePath = path.join(projectRoot, filename);
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, 'utf8');
    if (content.includes('mendix-review-checklist.md')) {
      log(`${filename} already references review checklist, skipping`);
      continue;
    }

    fs.appendFileSync(filePath, REVIEW_CHECKLIST_NOTICE, 'utf8');
    log(`Added review checklist instructions to ${filename}`);
  }
}

function appendKnowledgeBaseNotice(projectRoot) {
  const targets = ['AGENTS.md', 'CLAUDE.md'];
  for (const filename of targets) {
    const filePath = path.join(projectRoot, filename);
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, 'utf8');
    if (content.includes('project-knowledge-base.md')) {
      log(`${filename} already references knowledge base, skipping`);
      continue;
    }

    fs.appendFileSync(filePath, KNOWLEDGE_BASE_NOTICE, 'utf8');
    log(`Added knowledge base instructions to ${filename}`);
  }
}

function loadConfig(projectRoot) {
  const configPath = path.join(projectRoot, 'olc-config.json');
  const defaultConfig = path.join(__dirname, 'assets', 'olc-config.json');

  if (!fs.existsSync(configPath)) {
    if (fs.existsSync(defaultConfig)) {
      fs.copyFileSync(defaultConfig, configPath);
      log('Created olc-config.json with default settings');
    } else {
      fs.writeFileSync(configPath, JSON.stringify({
        IsKeepKnowledgebase: true,
        IsKeepReviewChecklist: true,
      }, null, 2) + '\n', 'utf8');
      log('Created olc-config.json with default settings');
    }
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    log(`Config loaded: IsKeepKnowledgebase=${config.IsKeepKnowledgebase}, IsKeepReviewChecklist=${config.IsKeepReviewChecklist}`);
    return config;
  } catch (e) {
    warn(`Failed to parse olc-config.json: ${e.message}, using defaults`);
    return { IsKeepKnowledgebase: true, IsKeepReviewChecklist: true };
  }
}

function printBanner() {
  console.log(`
\x1b[38;5;208m██████╗ ██████╗  █████╗ ███╗   ██╗ ██████╗ ███████╗██╗     ███████╗ █████╗ ███████╗
██╔═══██╗██╔══██╗██╔══██╗████╗  ██║██╔════╝ ██╔════╝██║     ██╔════╝██╔══██╗██╔════╝
██║   ██║██████╔╝███████║██╔██╗ ██║██║  ███╗█████╗  ██║     █████╗  ███████║█████╗
██║   ██║██╔══██╗██╔══██║██║╚██╗██║██║   ██║██╔══╝  ██║     ██╔══╝  ██╔══██║██╔══╝
╚██████╔╝██║  ██║██║  ██║██║ ╚████║╚██████╔╝███████╗███████╗███████╗██║  ██║██║
 ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝ ╚══════╝╚══════╝╚══════╝╚═╝  ╚═╝╚═╝

 ██████╗ ██████╗ ███╗   ██╗███████╗██╗   ██╗██╗  ████████╗██╗███╗   ██╗ ██████╗
██╔════╝██╔═══██╗████╗  ██║██╔════╝██║   ██║██║  ╚══██╔══╝██║████╗  ██║██╔════╝
██║     ██║   ██║██╔██╗ ██║███████╗██║   ██║██║     ██║   ██║██╔██╗ ██║██║  ███╗
██║     ██║   ██║██║╚██╗██║╚════██║██║   ██║██║     ██║   ██║██║╚██╗██║██║   ██║
╚██████╗╚██████╔╝██║ ╚████║███████║╚██████╔╝███████╗██║   ██║██║ ╚████║╚██████╔╝
 ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝╚══════╝ ╚═════╝ ╚══════╝╚═╝   ╚═╝╚═╝  ╚═══╝ ╚═════╝\x1b[0m
`);
}

async function main() {
  printBanner();
  const projectRoot = getProjectRoot();
  log(`Project root: ${projectRoot}`);
  log(`Platform: ${os.platform()} ${os.arch()}`);

  const platformKey = getPlatformKey();

  let release;
  try {
    release = await getLatestRelease();
    log(`Latest mxcli release: ${release.tag_name}`);
  } catch (e) {
    fail(`Failed to fetch mxcli release info: ${e.message}`);
  }

  const binaryPath = await downloadMxcli(projectRoot, release, platformKey);

  runMxcliInit(binaryPath, projectRoot);

  const config = loadConfig(projectRoot);

  addCustomSkills(projectRoot, config);

  updateGitignore(projectRoot);

  if (config.IsKeepKnowledgebase) {
    createKnowledgeBase(projectRoot);
    appendKnowledgeBaseNotice(projectRoot);
  } else {
    log('Knowledge base disabled via olc-config.json, skipping');
  }

  if (config.IsKeepReviewChecklist) {
    appendReviewChecklistNotice(projectRoot);
  } else {
    log('Review checklist notice disabled via olc-config.json, skipping');
  }

  log('Setup complete!');
}

main().catch(e => {
  console.error(`[mxcli-setup-olc] FATAL: ${e.message}`);
  process.exit(1);
});
