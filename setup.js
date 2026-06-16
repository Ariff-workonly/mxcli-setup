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
    3. Adds the Mendix Developer Skill to .ai-context/skills/
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
      `"${binaryPath}" init --all-tools "${projectRoot}"`,
      { encoding: 'utf8', stdio: 'pipe', cwd: projectRoot }
    );
    log('mxcli init completed successfully');
    if (result.trim()) console.log(result.trim());
  } catch (e) {
    warn(`mxcli init had issues (may already be initialized): ${e.message}`);
    if (e.stdout) console.log(e.stdout);
    if (e.stderr) console.error(e.stderr);
  }
}

function addCustomSkill(projectRoot) {
  const skillSrc = path.join(__dirname, 'assets', 'mendix-developer-skill.md');
  const skillDir = path.join(projectRoot, '.ai-context', 'skills');
  const skillDest = path.join(skillDir, 'mendix-developer-skill.md');

  if (!fs.existsSync(skillSrc)) {
    warn(`Custom skill file not found at ${skillSrc}, skipping`);
    return;
  }

  fs.mkdirSync(skillDir, { recursive: true });
  fs.copyFileSync(skillSrc, skillDest);
  log('Custom Mendix Developer Skill added to .ai-context/skills/');
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

  if (fs.existsSync(kbPath)) {
    log('project-knowledge-base.md already exists, skipping');
    return;
  }

  const header = `# Mendix Project Knowledge Base

> This file is maintained by AI agents working on this project.
> Every time an AI agent makes observations or discovers important context about the project, it should update this file for future reference.

## Project Overview

<!-- Add project description, purpose, and key stakeholders -->

## Architecture Notes

<!-- Document architectural decisions, patterns, and constraints -->

## Module Map

<!-- List modules and their responsibilities -->

## Key Entities

<!-- Document important domain entities and their relationships -->

## Important Microflows

<!-- List critical microflows and what they do -->

## Known Issues / Gotchas

<!-- Document pitfalls, edge cases, and things to watch out for -->

## Change Log

<!-- Agents: add dated entries when you discover or change something important -->
`;

  fs.writeFileSync(kbPath, header, 'utf8');
  log('Created project-knowledge-base.md');
}

const KNOWLEDGE_BASE_NOTICE = `

## Project Knowledge Base

A shared knowledge base exists at \`project-knowledge-base.md\` in the project root. This file persists across AI sessions.

**You MUST update it** when you discover new information about the project — module purposes, entity relationships, microflow traces, architectural patterns, gotchas, or any findings that would help a future agent. Add a dated entry under the Change Log section.

Read this file at the start of every session to understand what previous agents have already learned.
`;

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

async function main() {
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

  addCustomSkill(projectRoot);

  updateGitignore(projectRoot);

  createKnowledgeBase(projectRoot);

  appendKnowledgeBaseNotice(projectRoot);

  log('Setup complete!');
}

main().catch(e => {
  console.error(`[mxcli-setup-olc] FATAL: ${e.message}`);
  process.exit(1);
});
