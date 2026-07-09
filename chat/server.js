#!/usr/bin/env node
'use strict';

/*
 * Local Mendix chat web app — zero-dependency port of mxgpt
 * (https://github.com/Ariff-workonly/mxgpt) so this tool does not depend on
 * the external package. Serves the chat UI from chat/public/ over plain
 * node:http, streams answers over SSE, and answers questions by driving
 * read-only mxcli commands through Claude Code / Codex / an API key.
 *
 * Usage:
 *   node chat/server.js [project-path] [--port n] [--provider id] [--no-open]
 * or from setup.js: require('./chat/server.js').startChat(projectRoot)
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const isWin = process.platform === 'win32';

const DEFAULTS = {
  port: 4477,
  models: {
    anthropic: 'claude-opus-4-8',
    openai: 'gpt-4.1',
  },
};

const PROJECT_CONFIG = '.mxgpt.json';
const HOME_CONFIG = path.join(os.homedir(), '.mxgpt.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

function log(msg) {
  console.log(`[mxcli-olc-chat] ${msg}`);
}

function warn(msg) {
  console.warn(`[mxcli-olc-chat] WARNING: ${msg}`);
}

/* -------------------------------- config -------------------------------- */

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return {};
    // Strip a UTF-8 BOM — Windows editors often add one and JSON.parse chokes on it.
    const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    apiKeys: { ...base.apiKeys, ...override.apiKeys },
    models: { ...base.models, ...override.models },
    cli: {
      claude: { ...(base.cli || {}).claude, ...(override.cli || {}).claude },
      codex: { ...(base.cli || {}).codex, ...(override.cli || {}).codex },
    },
  };
}

/** home (~/.mxgpt.json) → project (./.mxgpt.json) → environment variables. */
function loadConfig(cwd) {
  const home = readJson(HOME_CONFIG);
  const project = readJson(path.join(cwd, PROJECT_CONFIG));
  let cfg = mergeConfig(home, project);

  const env = { apiKeys: {} };
  if (process.env.ANTHROPIC_API_KEY) env.apiKeys.anthropic = process.env.ANTHROPIC_API_KEY;
  if (process.env.OPENAI_API_KEY) env.apiKeys.openai = process.env.OPENAI_API_KEY;
  if (process.env.MXGPT_PORT) env.port = Number(process.env.MXGPT_PORT);
  if (process.env.MXGPT_PROVIDER) env.provider = process.env.MXGPT_PROVIDER;
  return mergeConfig(cfg, env);
}

function writeMerged(file, cfg) {
  const next = mergeConfig(readJson(file), cfg);
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return file;
}

function saveProjectConfig(cfg, cwd) {
  return writeMerged(path.join(cwd, PROJECT_CONFIG), cfg);
}

function saveHomeConfig(cfg) {
  return writeMerged(HOME_CONFIG, cfg);
}

function projectConfigExists(cwd) {
  return fs.existsSync(path.join(cwd, PROJECT_CONFIG));
}

/* --------------------------------- exec --------------------------------- */

/** Resolve a command name to an absolute executable path (see mxgpt exec.ts). */
function resolveCommand(cmd) {
  if (cmd.includes('/') || cmd.includes('\\')) return cmd;
  const finder = isWin ? 'where' : 'which';
  const res = spawnSync(finder, [cmd], { encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout) return null;
  const lines = res.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  if (!isWin) return lines[0];

  // Prefer a launchable extension: Node cannot spawn extension-less shims.
  const priority = ['.exe', '.cmd', '.bat', '.com'];
  for (const ext of priority) {
    const hit = lines.find(l => l.toLowerCase().endsWith(ext));
    if (hit) return hit;
  }
  return lines[0];
}

/** On Windows, .cmd/.bat shims must be launched through a shell. */
function needsShell(resolvedPath) {
  if (!isWin) return false;
  const lower = resolvedPath.toLowerCase();
  return lower.endsWith('.cmd') || lower.endsWith('.bat');
}

function commandExists(cmd) {
  return resolveCommand(cmd) !== null;
}

function spawnText(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const resolved = resolveCommand(cmd) || cmd;
    const child = spawn(resolved, args, { cwd: opts.cwd, env: opts.env, shell: false });
    let stdout = '';
    let stderr = '';
    let timer;
    if (opts.timeoutMs) timer = setTimeout(() => child.kill(), opts.timeoutMs);
    child.stdout.on('data', d => (stdout += d.toString()));
    child.stderr.on('data', d => (stderr += d.toString()));
    child.on('error', err => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/* -------------------------------- mendix -------------------------------- */

function findProjectFile(cfg, cwd) {
  if (cfg.projectFile) {
    const p = path.resolve(cwd, cfg.projectFile);
    return fs.existsSync(p) ? p : null;
  }
  const direct = fs.readdirSync(cwd)
    .filter(f => f.toLowerCase().endsWith('.mpr'))
    .map(f => path.join(cwd, f));
  if (direct.length) return direct[0];

  // Shallow scan one level down (common when the .mpr lives in a subfolder).
  for (const entry of fs.readdirSync(cwd, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const sub = path.join(cwd, entry.name);
    try {
      const hit = fs.readdirSync(sub).find(f => f.toLowerCase().endsWith('.mpr'));
      if (hit) return path.join(sub, hit);
    } catch (e) {
      /* ignore unreadable dirs */
    }
  }
  return null;
}

/**
 * The mxcli binary: explicit config wins, then the copy this tool installs
 * into <project>/.tools/mxcli/, then whatever is on PATH.
 */
function mxcliBin(cfg, projectDir) {
  if (cfg.mxcliPath) return cfg.mxcliPath;
  const local = path.join(projectDir || process.cwd(), '.tools', 'mxcli', isWin ? 'mxcli.exe' : 'mxcli');
  if (fs.existsSync(local)) return local;
  return 'mxcli';
}

function mxcliAvailable(cfg, projectDir) {
  return commandExists(mxcliBin(cfg, projectDir));
}

/**
 * PATH for the agent CLIs (Claude/Codex): prepend the project-local
 * .tools/mxcli dir so plain `mxcli` commands work even when mxcli was only
 * installed by this tool and is not on the global PATH.
 */
function agentEnv(projectDir) {
  const toolsDir = path.join(projectDir, '.tools', 'mxcli');
  if (!fs.existsSync(toolsDir)) return process.env;
  return { ...process.env, PATH: toolsDir + path.delimiter + (process.env.PATH || '') };
}

/* Read-only guardrail for the manual API-key tool loop. */
const READ_SUBCOMMANDS = new Set([
  'describe', 'search', 'callers', 'callees', 'refs', 'impact',
  'context', 'lint', 'report', 'syntax', 'check',
]);
const READ_QUERY_PREFIXES = ['show', 'select', 'describe', 'refresh catalog'];
const WRITE_QUERY_TOKENS = [
  'create', 'update', 'delete', 'insert', 'drop', 'alter', 'rename', 'move', 'execute',
];

function isReadOnlyMxcli(args) {
  const cIdx = args.findIndex(a => a === '-c' || a === '--command');
  if (cIdx !== -1) {
    const query = (args[cIdx + 1] || '').trim().toLowerCase();
    if (WRITE_QUERY_TOKENS.some(t => query.startsWith(t + ' ') || query === t)) return false;
    return READ_QUERY_PREFIXES.some(p => query.startsWith(p));
  }
  const sub = args.find(a => !a.startsWith('-'));
  return sub ? READ_SUBCOMMANDS.has(sub.toLowerCase()) : false;
}

async function runMxcli(cfg, projectFile, args) {
  if (!isReadOnlyMxcli(args)) {
    throw new Error(
      'Refused: only read-only mxcli commands are permitted (show/select/describe/search/callers/callees/refs/impact/context/lint/report).'
    );
  }
  const projectDir = path.dirname(projectFile);
  const full = ['-p', projectFile, ...args];
  const res = await spawnText(mxcliBin(cfg, projectDir), full, {
    cwd: projectDir,
    timeoutMs: 60000,
  });
  const out = (res.stdout || '').trim();
  const err = (res.stderr || '').trim();
  if (res.code !== 0 && !out) {
    return `mxcli exited with code ${res.code}.\n${err}`;
  }
  return out || err || '(no output)';
}

function buildSystemPrompt(projectFile) {
  const rel = path.basename(projectFile);
  return [
    'You are a read-only analysis assistant for a Mendix low-code project.',
    `The project model lives in the binary file "${rel}" in the current working directory.`,
    'You cannot read the .mpr directly — use the `mxcli` command-line tool to inspect it.',
    '',
    'Always pass the project file with `-p` and use ONLY read-only commands, e.g.:',
    `  mxcli -p "${rel}" -c "show modules"`,
    `  mxcli -p "${rel}" -c "show entities in MyModule"`,
    `  mxcli describe -p "${rel}" entity MyModule.Customer`,
    `  mxcli describe -p "${rel}" microflow MyModule.ProcessOrder`,
    `  mxcli search -p "${rel}" "workshop"`,
    `  mxcli refs -p "${rel}" MyModule.Mechanic`,
    `  mxcli -p "${rel}" -c "select Name, ActivityCount from CATALOG.MICROFLOWS where ActivityCount > 10"`,
    '',
    'NEVER modify the model (no create/update/delete/execute/diff that writes).',
    'Investigate with as many mxcli calls as needed before answering.',
    'Pay special attention to associations and their multiplicity when asked about',
    'relationships (e.g. "can a Mechanic belong to more than one Workshop?" depends on',
    'the association type: one-to-one, one-to-many, or many-to-many).',
    'Answer concisely and precisely, citing the exact entity / association / microflow',
    'names you found. If the model does not contain the answer, say so plainly.',
    '',
    'DIAGRAMS — whenever the answer describes something structural or procedural,',
    'include a Mermaid diagram in a fenced ```mermaid code block so the user can',
    'see it rendered. Choose the right diagram type:',
    '  • Entity associations / cardinality  → erDiagram',
    '      e.g.  WORKSHOP ||--o{ MECHANIC : employs   (one workshop, many mechanics)',
    '            MECHANIC }o--o{ WORKSHOP : works_at   (many-to-many)',
    '    Use ||, |o, }o, }| to reflect the REAL multiplicity you found in the model.',
    '  • Microflows / nanoflows / algorithms / processes → flowchart TD (or graph TD)',
    '  • State machines / status fields → stateDiagram-v2',
    '  • Sequence of calls between microflows → sequenceDiagram',
    'Keep diagrams faithful to what mxcli reported — never invent entities or flows.',
    'Put the diagram next to the relevant explanation; you may include more than one.',
    'Always also give the prose answer — the diagram supplements it, never replaces it.',
  ].join('\n');
}

/* ------------------------------- providers ------------------------------- */

const CLAUDE_BIN = 'claude';
const CODEX_BIN = 'codex';
const MAX_TOOL_ITERATIONS = 16;

const MXCLI_TOOL_DESCRIPTION =
  'Run a single READ-ONLY mxcli command against the Mendix project to inspect the model. ' +
  'Provide ONLY the arguments AFTER `mxcli -p <project>` as an array of strings. ' +
  'Examples: ["-c","show modules"], ["-c","show entities in Sales"], ' +
  '["describe","entity","Sales.Customer"], ["search","workshop"], ["refs","Domain.Mechanic"].';

/** Fold system prompt + history + question into a single stdin prompt. */
function buildAgentPrompt(opts) {
  const parts = [opts.systemPrompt, ''];
  for (const t of opts.history) {
    parts.push(`${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`);
  }
  parts.push(`User: ${opts.question}`);
  return parts.join('\n');
}

/**
 * Spawn an agentic CLI (Claude / Codex), streaming stdout to the chat and
 * stderr to the Logs tab. The prompt is written to stdin so we never have to
 * quote multi-line text on the command line.
 */
function streamAgentProcess(p, opts) {
  return new Promise((resolve, reject) => {
    const resolved = resolveCommand(p.command) || p.command;
    const shell = needsShell(resolved);

    if (opts.onLog) opts.onLog('cmd', `$ ${resolved} ${p.args.join(' ')}`);
    if (opts.onLog) opts.onLog('info', `cwd: ${p.cwd}`);

    const child = spawn(resolved, p.args, { cwd: p.cwd, env: agentEnv(p.cwd), shell });

    let sawOutput = false;
    let stderr = '';

    if (opts.signal) opts.signal.addEventListener('abort', () => child.kill());

    child.on('error', err => {
      if (opts.onLog) opts.onLog('err', `spawn error: ${err.message}`);
      reject(err);
    });

    child.stdin.on('error', () => {
      /* ignore EPIPE if the process exits early */
    });
    child.stdin.write(p.stdin);
    child.stdin.end();

    child.stdout.on('data', d => {
      sawOutput = true;
      opts.onToken(d.toString());
    });
    child.stderr.on('data', d => {
      const text = d.toString();
      stderr += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() && opts.onLog) opts.onLog('info', line.trim());
      }
    });

    child.on('close', code => {
      if (opts.onLog) opts.onLog(code === 0 ? 'info' : 'err', `process exited with code ${code}`);
      if (code === 0 || sawOutput) {
        if (!sawOutput) {
          opts.onToken('_(The AI returned no output. Check the **Logs** tab for details.)_');
        }
        resolve();
      } else {
        reject(new Error(stderr.trim() || `Process exited with code ${code}`));
      }
    });
  });
}

const claudeProvider = {
  id: 'claude',
  label: 'Claude Code CLI (local)',
  async ask(opts) {
    if (opts.onStatus) opts.onStatus('Starting Claude Code…');
    const cfg = (opts.config.cli || {}).claude || {};
    const command = cfg.command || CLAUDE_BIN;
    const args = cfg.args || ['-p', '--allowedTools', 'Bash(mxcli:*)'];
    await streamAgentProcess(
      { command, args, cwd: path.dirname(opts.projectFile), stdin: buildAgentPrompt(opts) },
      opts
    );
  },
};

const codexProvider = {
  id: 'codex',
  label: 'Codex CLI (local)',
  async ask(opts) {
    if (opts.onStatus) opts.onStatus('Starting Codex…');
    const cfg = (opts.config.cli || {}).codex || {};
    const command = cfg.command || CODEX_BIN;
    // Trailing "-" tells codex exec to read the prompt from stdin.
    const args = cfg.args || ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-'];
    await streamAgentProcess(
      { command, args, cwd: path.dirname(opts.projectFile), stdin: buildAgentPrompt(opts) },
      opts
    );
  },
};

function requireKey(cfg, which) {
  const key = (cfg.apiKeys || {})[which];
  if (!key) {
    throw new Error(
      `No ${which} API key configured. Delete .mxgpt.json and restart to re-run setup, or set ${which.toUpperCase()}_API_KEY.`
    );
  }
  return key;
}

function requireFetch() {
  if (typeof fetch !== 'function') {
    throw new Error('The API-key providers need Node.js >= 18 (global fetch). Use the Claude or Codex CLI provider instead.');
  }
}

async function execTool(opts, args) {
  if (opts.onStatus) opts.onStatus(`Running mxcli ${args.join(' ')}`);
  if (opts.onLog) opts.onLog('cmd', `mxcli ${args.join(' ')}`);
  try {
    const out = await runMxcli(opts.config, opts.projectFile, args);
    if (opts.onLog) opts.onLog('info', out.length > 600 ? out.slice(0, 600) + ' …' : out);
    return out;
  } catch (err) {
    if (opts.onLog) opts.onLog('err', err.message);
    return `Error: ${err.message}`;
  }
}

async function askAnthropic(opts) {
  requireFetch();
  const key = requireKey(opts.config, 'anthropic');
  const model = (opts.config.models || {}).anthropic || DEFAULTS.models.anthropic;

  const messages = [
    ...opts.history.map(t => ({ role: t.role, content: t.content })),
    { role: 'user', content: opts.question },
  ];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    if (opts.onStatus) opts.onStatus('Thinking…');
    if (opts.onLog) opts.onLog('info', `Anthropic request (${model}), turn ${i + 1}`);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: opts.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        system: opts.systemPrompt,
        tools: [
          {
            name: 'run_mxcli',
            description: MXCLI_TOOL_DESCRIPTION,
            input_schema: {
              type: 'object',
              properties: { args: { type: 'array', items: { type: 'string' } } },
              required: ['args'],
            },
          },
        ],
        messages,
      }),
    });

    if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
    const data = await res.json();

    for (const block of data.content || []) {
      if (block.type === 'text') opts.onToken(block.text);
    }

    if (data.stop_reason !== 'tool_use') return;

    messages.push({ role: 'assistant', content: data.content });
    const toolResults = [];
    for (const block of data.content || []) {
      if (block.type !== 'tool_use') continue;
      const args = (block.input || {}).args || [];
      const output = await execTool(opts, args);
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: output });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  opts.onToken('\n\n_(stopped: reached the mxcli call limit.)_');
}

async function askOpenAI(opts) {
  requireFetch();
  const key = requireKey(opts.config, 'openai');
  const model = (opts.config.models || {}).openai || DEFAULTS.models.openai;

  const messages = [
    { role: 'system', content: opts.systemPrompt },
    ...opts.history.map(t => ({ role: t.role, content: t.content })),
    { role: 'user', content: opts.question },
  ];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    if (opts.onStatus) opts.onStatus('Thinking…');
    if (opts.onLog) opts.onLog('info', `OpenAI request (${model}), turn ${i + 1}`);
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: opts.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages,
        tools: [
          {
            type: 'function',
            function: {
              name: 'run_mxcli',
              description: MXCLI_TOOL_DESCRIPTION,
              parameters: {
                type: 'object',
                properties: { args: { type: 'array', items: { type: 'string' } } },
                required: ['args'],
              },
            },
          },
        ],
      }),
    });

    if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) return;

    if (msg.content) opts.onToken(msg.content);
    if (!msg.tool_calls || !msg.tool_calls.length) return;

    messages.push(msg);
    for (const call of msg.tool_calls) {
      let args = [];
      try {
        args = (JSON.parse(call.function.arguments) || {}).args || [];
      } catch (e) {
        /* leave empty → tool will report an error */
      }
      const output = await execTool(opts, args);
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }
  }
  opts.onToken('\n\n_(stopped: reached the mxcli call limit.)_');
}

const PROVIDERS = {
  'claude': claudeProvider,
  'codex': codexProvider,
  'anthropic-api': { id: 'anthropic-api', label: 'Anthropic API key', ask: askAnthropic },
  'openai-api': { id: 'openai-api', label: 'OpenAI API key', ask: askOpenAI },
};

const PROVIDER_PRIORITY = ['claude', 'codex', 'anthropic-api', 'openai-api'];

function detectProviders(cfg) {
  const claudeCmd = ((cfg.cli || {}).claude || {}).command || CLAUDE_BIN;
  const codexCmd = ((cfg.cli || {}).codex || {}).command || CODEX_BIN;
  return [
    { id: 'claude', label: 'Claude Code CLI (local)', available: commandExists(claudeCmd) },
    { id: 'codex', label: 'Codex CLI (local)', available: commandExists(codexCmd) },
    { id: 'anthropic-api', label: 'Anthropic API key', available: !!(cfg.apiKeys || {}).anthropic },
    { id: 'openai-api', label: 'OpenAI API key', available: !!(cfg.apiKeys || {}).openai },
  ];
}

function selectProvider(cfg) {
  if (cfg.provider && PROVIDERS[cfg.provider]) return PROVIDERS[cfg.provider];

  const statuses = detectProviders(cfg);
  for (const id of PROVIDER_PRIORITY) {
    const s = statuses.find(x => x.id === id);
    if (s && s.available) return PROVIDERS[id];
  }
  throw new Error(
    'No AI provider available. Install the Claude Code CLI or Codex CLI, or add an API key via the setup wizard.'
  );
}

/* ------------------------------ setup wizard ----------------------------- */

function askQuestion(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

async function runSetup(cwd) {
  const cfg = loadConfig(cwd);
  console.log('\n  Mendix chat setup\n');

  if (!mxcliAvailable(cfg, cwd)) {
    warn('mxcli was not found (.tools/mxcli or PATH). The chat needs mxcli to read the model.');
  } else {
    log('mxcli detected.');
  }

  const projectFile = findProjectFile(cfg, cwd);
  if (projectFile) {
    log(`Mendix project: ${projectFile}`);
  } else {
    warn('No .mpr file found in this folder.');
  }

  const statuses = detectProviders(cfg);
  console.log('\nDetected AI providers:');
  statuses.forEach((s, i) => {
    console.log(`  ${i + 1}) ${s.label} ${s.available ? '(available)' : '(not found)'}`);
  });
  console.log('  0) Auto-detect (Claude -> Codex -> API key)  [default]');

  const choice = (await askQuestion('\nWhich AI provider should the chat use? (0-4): ')).trim();
  const next = {};
  const homeOnly = { apiKeys: {} };

  const idx = Number(choice);
  if (choice && idx >= 1 && idx <= statuses.length) {
    next.provider = statuses[idx - 1].id;
  }

  if (next.provider === 'anthropic-api' && !(cfg.apiKeys || {}).anthropic) {
    const key = (await askQuestion('Anthropic API key (stored in ~/.mxgpt.json, not in your project): ')).trim();
    if (key) homeOnly.apiKeys.anthropic = key;
  }
  if (next.provider === 'openai-api' && !(cfg.apiKeys || {}).openai) {
    const key = (await askQuestion('OpenAI API key (stored in ~/.mxgpt.json, not in your project): ')).trim();
    if (key) homeOnly.apiKeys.openai = key;
  }

  const portAnswer = (await askQuestion(`Local web app port (Enter for ${cfg.port || DEFAULTS.port}): `)).trim();
  const port = Number(portAnswer);
  if (portAnswer && Number.isInteger(port) && port > 0 && port < 65536) next.port = port;

  if (homeOnly.apiKeys.anthropic || homeOnly.apiKeys.openai) {
    log(`Saved API key to ${saveHomeConfig(homeOnly)}`);
  }
  log(`Saved project config to ${saveProjectConfig(next, cwd)}`);

  return loadConfig(cwd);
}

/* -------------------------------- server -------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return true;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
  return true;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleChat(req, res, ctx) {
  let body = {};
  try {
    body = JSON.parse((await readBody(req, 1024 * 1024)) || '{}');
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body.' }));
    return;
  }

  const question = String(body.question || '').trim();
  const history = Array.isArray(body.history) ? body.history : [];
  if (!question) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing question.' }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const controller = new AbortController();
  // Abort only on a genuine client disconnect — i.e. the response socket
  // closed before we finished writing.
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  send({ type: 'log', level: 'info', text: `Provider: ${ctx.provider.label}` });
  send({ type: 'status', text: 'Connecting to AI…' });

  try {
    await ctx.provider.ask({
      question,
      history,
      projectFile: ctx.projectFile,
      systemPrompt: ctx.systemPrompt,
      config: ctx.config,
      signal: controller.signal,
      onToken: text => send({ type: 'token', text }),
      onStatus: text => send({ type: 'status', text }),
      onLog: (level, text) => {
        send({ type: 'log', level, text });
        console.log(`[${level}] ${text}`);
      },
    });
    send({ type: 'done' });
  } catch (err) {
    send({ type: 'log', level: 'err', text: err.message });
    send({ type: 'error', text: err.message });
  } finally {
    res.end();
  }
}

function startServer(ctx, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url && req.url.split('?')[0] === '/api/info') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          provider: ctx.provider.label,
          providerId: ctx.provider.id,
          projectFile: path.basename(ctx.projectFile),
          mxcli: mxcliAvailable(ctx.config, path.dirname(ctx.projectFile)),
        }));
        return;
      }
      if (req.method === 'POST' && req.url && req.url.split('?')[0] === '/api/chat') {
        handleChat(req, res, ctx).catch(err => {
          try { res.end(); } catch (e) { /* already closed */ }
          console.error(err);
        });
        return;
      }
      if (req.method === 'GET' && serveStatic(req, res)) return;
      res.writeHead(404).end('Not found');
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      resolve({
        url: `http://127.0.0.1:${actualPort}`,
        port: actualPort,
        close: () => new Promise(r => server.close(() => r())),
      });
    });
  });
}

function openBrowser(url) {
  try {
    if (isWin) {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch (e) {
    return false;
  }
}

/* --------------------------------- main ---------------------------------- */

async function startChat(projectRoot, options = {}) {
  const cwd = path.resolve(projectRoot || process.cwd());

  // First-run convenience: if the project has never been configured, walk setup.
  if (!projectConfigExists(cwd)) {
    log('No .mxgpt.json found — running first-time chat setup.');
    await runSetup(cwd);
  }

  let cfg = loadConfig(cwd);
  if (options.provider) cfg = { ...cfg, provider: options.provider };

  const projectFile = findProjectFile(cfg, cwd);
  if (!projectFile) {
    throw new Error(`No Mendix .mpr file found in ${cwd}. Run from your Mendix project root, or set "projectFile" in .mxgpt.json.`);
  }
  if (!mxcliAvailable(cfg, cwd)) {
    warn('mxcli not found — answers will be limited.');
  }

  const provider = selectProvider(cfg);
  const port = options.port || cfg.port || DEFAULTS.port;
  const ctx = { config: cfg, projectFile, provider, systemPrompt: buildSystemPrompt(projectFile) };
  const server = await startServer(ctx, port);

  console.log('\n  Mendix chat is running\n');
  log(`Project:  ${path.basename(projectFile)}`);
  log(`Provider: ${provider.label}`);
  log(`Open:     ${server.url}`);
  console.log('\n  Press Ctrl+C to stop.\n');

  if (!options.noOpen) {
    if (!openBrowser(server.url)) {
      log('(Could not auto-open the browser — open the URL above manually.)');
    }
  }

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

function parseArgs(argv) {
  const options = { noOpen: false };
  let projectRoot = null;
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--port') options.port = Number(rest[++i]);
    else if (a === '--provider') options.provider = rest[++i];
    else if (a === '--no-open') options.noOpen = true;
    else if (!a.startsWith('-') && !projectRoot) projectRoot = a;
  }
  return { projectRoot, options };
}

if (require.main === module) {
  const { projectRoot, options } = parseArgs(process.argv);
  startChat(projectRoot, options).catch(err => {
    console.error(`[mxcli-olc-chat] ERROR: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { startChat };
