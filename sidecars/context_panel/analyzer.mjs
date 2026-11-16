/**
 * Core /context token accounting, compaction checkpoint detection,
 * customization & MCP scanner, and tracked-files analyzer for Antigravity Desktop.
 *
 * Read-only: never mutates user configuration, transcripts, or conversations.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ID_RE = /^[0-9a-f-]{8,}$/i;

export const MODEL_CONTEXT_LIMITS = [
  { match: /gemini[-_\s]*1\.5[-_\s]*pro/i, limit: 2_097_152 },
  { match: /2m\b/i, limit: 2_097_152 },
  { match: /claude/i, limit: 200_000 },
  { match: /gpt[-_\s]*4o/i, limit: 128_000 },
  { match: /gemini|carbon|flash|pro|ultra|auto/i, limit: 1_048_576 },
];

export const DEFAULT_CONTEXT_LIMIT = 1_048_576;

const BUILTIN_SYSTEM_TOOLS_ESTIMATE = 3850;
const MCP_SERVER_BASE_SCHEMA_ESTIMATE = 680;
const COMPACTION_RE = /<CONTEXT_SUMMARY>|\[CONTEXT_SUMMARY\]|<checkpoint_summary>/i;
const MODEL_CHANGE_RE = /setting\s+`?Model Selection`?\s+from\s+.+?\s+to\s+([^\n.]+?)(?:\.|\n|$)/gi;

// ---------------------------------------------------------------------------
// Safe filesystem & JSONC helpers
// ---------------------------------------------------------------------------

function safeStat(path) {
  try {
    const s = statSync(path);
    return { exists: true, mtime: s.mtimeMs, size: s.size, isFile: s.isFile(), isDir: s.isDirectory() };
  } catch {
    return { exists: false, mtime: 0, size: -1, isFile: false, isDir: false };
  }
}

function safeReaddir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

const textCache = new Map();
function readCached(path, maxBytes = 64 * 1024 * 1024) {
  const st = safeStat(path);
  if (!st.exists || !st.isFile || st.size < 0 || st.size > maxBytes) {
    return { text: null, ...st };
  }
  const key = `${st.mtime}:${st.size}`;
  const hit = textCache.get(path);
  if (hit && hit.key === key) {
    return { text: hit.text, ...st };
  }
  try {
    const text = readFileSync(path, 'utf-8');
    if (textCache.size > 600) textCache.clear();
    textCache.set(path, { key, text });
    return { text, ...st };
  } catch {
    return { text: null, ...st };
  }
}

/**
 * Parses JSONC (JSON with // and block comments + trailing commas).
 */
export function parseJsonc(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let out = '';
  let inStr = false;
  let escaped = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inStr) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inStr = false;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < raw.length && raw[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  const cleaned = out.replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function toFileUriIfExists(target) {
  if (!target || typeof target !== 'string' || !isAbsolute(target)) return '';
  if (/[%\0\\]/.test(target)) return '';
  try {
    const real = realpathSync(target);
    if (!statSync(real).isFile()) return '';
    return pathToFileURL(real).href;
  } catch {
    return '';
  }
}

export function uriToPath(uriOrPath) {
  if (!uriOrPath || typeof uriOrPath !== 'string') return '';
  const trimmed = uriOrPath.trim();
  if (trimmed.startsWith('file://')) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return trimmed.replace(/^file:\/\//, '');
    }
  }
  return isAbsolute(trimmed) ? resolve(trimmed) : '';
}

// ---------------------------------------------------------------------------
// Token estimation (used for intra-interval splitting & individual file sizes;
// overall totals are calibrated directly to Gemini API input/cache/output tokens)
// ---------------------------------------------------------------------------

export function estimateTokens(text) {
  if (!text) return 0;
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  const len = s.length;
  if (!len) return 0;
  // Sample up to 4 KB to gauge code/JSON punctuation density vs natural prose.
  const sample = len > 4096 ? s.slice(0, 2048) + s.slice(-2048) : s;
  let punct = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if ((c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)) {
      punct++;
    }
  }
  const density = punct / sample.length;
  // High-punctuation JSON/code tokenizes around ~3.25 chars/tok; prose ~3.85 chars/tok.
  const charsPerToken = density > 0.14 ? 3.25 : density > 0.07 ? 3.55 : 3.85;
  return Math.max(1, Math.round(len / charsPerToken));
}

export function inferContextLimit(modelName, overrideLimit = 0) {
  if (Number.isFinite(overrideLimit) && overrideLimit >= 4096) {
    return Math.round(overrideLimit);
  }
  const m = String(modelName || '').trim();
  for (const rule of MODEL_CONTEXT_LIMITS) {
    if (rule.match.test(m)) return rule.limit;
  }
  return DEFAULT_CONTEXT_LIMIT;
}

// ---------------------------------------------------------------------------
// App data & conversation discovery
// ---------------------------------------------------------------------------

export function findAppDataDirs(explicitDir = '') {
  if (explicitDir && existsSync(join(explicitDir, 'brain'))) {
    return [resolve(explicitDir)];
  }
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        const appData = dirname(d);
        if (existsSync(join(appData, 'brain'))) return [appData];
      }
    }
  }
  const geminiRoot = join(homedir(), '.gemini');
  const preferred = ['antigravity', 'antigravity-ide', 'antigravity-cli'];
  const found = [];
  const seen = new Set();
  for (const name of [...preferred, ...safeReaddir(geminiRoot).sort()]) {
    if (seen.has(name)) continue;
    seen.add(name);
    const candidate = join(geminiRoot, name);
    if (existsSync(join(candidate, 'brain'))) {
      found.push(candidate);
    }
  }
  return found;
}

function transcriptPathsOf(appData, conv) {
  const logsDir = join(appData, 'brain', conv, '.system_generated', 'logs');
  return {
    full: join(logsDir, 'transcript_full.jsonl'),
    compact: join(logsDir, 'transcript.jsonl'),
  };
}

export function locateConversation(conv, appDataDirs = findAppDataDirs()) {
  if (!conv || !ID_RE.test(conv)) return null;
  for (const appData of appDataDirs) {
    const paths = transcriptPathsOf(appData, conv);
    if (existsSync(paths.full)) return { appData, transcriptPath: paths.full, isFull: true };
    if (existsSync(paths.compact)) return { appData, transcriptPath: paths.compact, isFull: false };
    if (existsSync(join(appData, 'brain', conv))) {
      return { appData, transcriptPath: '', isFull: false };
    }
  }
  return null;
}

function readHookSessionMeta(appData, conv) {
  const candidates = [];
  if (process.env.PLUGIN_DATA) {
    candidates.push(join(process.env.PLUGIN_DATA, 'sessions', `${conv}.json`));
  }
  if (appData) {
    candidates.push(join(appData, 'plugin_data', 'antigravity-context-plugin', 'sessions', `${conv}.json`));
  }
  candidates.push(join(homedir(), '.gemini', 'antigravity', 'plugin_data', 'antigravity-context-plugin', 'sessions', `${conv}.json`));
  for (const p of candidates) {
    const { text } = readCached(p, 64 * 1024);
    if (!text) continue;
    const parsed = parseJsonc(text);
    if (parsed && typeof parsed === 'object') return parsed;
  }
  return null;
}

function parseSkillFrontmatter(text) {
  if (typeof text !== 'string') return { name: '', description: '' };
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { name: '', description: '' };
  const block = m[1];
  const nameMatch = block.match(/^name:\s*(.+)$/m);
  let desc = '';
  const inlineDesc = block.match(/^description:\s*(?![>|])(.+)$/m);
  if (inlineDesc) {
    desc = inlineDesc[1].trim().replace(/^['"]|['"]$/g, '');
  } else {
    const multi = block.match(/^description:\s*[>|]-?\s*\r?\n((?:[ \t]+.+\r?\n?)+)/m);
    if (multi) {
      desc = multi[1]
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .join(' ');
    }
  }
  return {
    name: nameMatch ? nameMatch[1].trim().replace(/^['"]|['"]$/g, '') : '',
    description: desc,
  };
}

function loadRegisteredProjects() {
  const projDir = join(homedir(), '.gemini', 'config', 'projects');
  const folders = [];
  for (const f of safeReaddir(projDir)) {
    if (!f.endsWith('.json')) continue;
    const { text } = readCached(join(projDir, f), 256 * 1024);
    const parsed = parseJsonc(text || '');
    const resources = parsed?.projectResources?.resources;
    if (!Array.isArray(resources)) continue;
    for (const r of resources) {
      const p = uriToPath(r?.folderUri || '');
      if (p) folders.push(p);
    }
  }
  // Longest path first so nested projects match most specifically.
  folders.sort((a, b) => b.length - a.length);
  return folders;
}

function unquoteArg(v) {
  if (typeof v !== 'string') return v == null ? '' : String(v);
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return String(JSON.parse(s));
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Quick conversation list for switcher
// ---------------------------------------------------------------------------

export function listConversations({ appDataDirs = findAppDataDirs(), titleResolver = null } = {}) {
  const out = [];
  const seen = new Set();
  for (const appData of appDataDirs) {
    const brainDir = join(appData, 'brain');
    for (const conv of safeReaddir(brainDir)) {
      if (!ID_RE.test(conv) || seen.has(conv)) continue;
      seen.add(conv);
      const paths = transcriptPathsOf(appData, conv);
      const stFull = safeStat(paths.full);
      const stCompact = safeStat(paths.compact);
      const chosen = stCompact.exists ? paths.compact : stFull.exists ? paths.full : '';
      const mtime = Math.max(stFull.mtime || 0, stCompact.mtime || 0, safeStat(join(brainDir, conv)).mtime || 0);
      let steps = 0;
      let latestTokens = 0;
      let modelName = '';
      const meta = readHookSessionMeta(appData, conv);
      if (meta?.modelName && meta.modelName !== 'auto') modelName = meta.modelName;
      if (chosen) {
        const { text } = readCached(chosen, 16 * 1024 * 1024);
        if (text) {
          const lines = text.split('\n').filter((l) => l.trim());
          steps = lines.length;
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const obj = JSON.parse(lines[i]);
              if (!latestTokens && obj?.type === 'PLANNER_RESPONSE') {
                latestTokens = (Number(obj.input_tokens) || 0) + (Number(obj.cache_read_tokens) || 0) + (Number(obj.output_tokens) || 0);
              }
              if (!modelName && obj?.type === 'USER_INPUT' && typeof obj.content === 'string') {
                for (const m of obj.content.matchAll(MODEL_CHANGE_RE)) {
                  modelName = m[1].trim();
                }
              }
              if (latestTokens && modelName) break;
            } catch {
              // Ignore torn line
            }
          }
        }
      }
      const title = typeof titleResolver === 'function' ? titleResolver(conv) || '' : '';
      out.push({
        conversationId: conv,
        title,
        appData,
        mtime,
        steps,
        latestTokens,
        modelName: modelName || 'Auto (Gemini)',
      });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// ---------------------------------------------------------------------------
// Customizations, MCP servers, and system files discovery
// ---------------------------------------------------------------------------

function scanEnvironment({ appData, workspacePaths }) {
  const home = homedir();
  const configRoot = join(home, '.gemini', 'config');
  const systemFiles = [];
  const seenSystemPaths = new Set();

  // Optional read-only check of plugin enabled overrides in ~/.gemini/config/config.json
  const userConfigFile = readCached(join(configRoot, 'config.json'), 512 * 1024);
  const userConfig = parseJsonc(userConfigFile.text || '') || {};
  const pluginStates = userConfig?.plugins && typeof userConfig.plugins === 'object' ? userConfig.plugins : {};

  function addSystemFile(path, kind, label = '') {
    if (!path) return 0;
    let resolvedPath = path;
    try {
      if (existsSync(path)) resolvedPath = realpathSync(path);
    } catch {
      // keep original
    }
    if (seenSystemPaths.has(resolvedPath)) return 0;
    const f = readCached(path, 2 * 1024 * 1024);
    if (!f.exists || !f.isFile || f.text === null) return 0;
    seenSystemPaths.add(resolvedPath);
    const tokens = estimateTokens(f.text);
    systemFiles.push({
      path,
      name: label || basename(path),
      kind,
      bytes: f.size,
      tokens,
      uri: toFileUriIfExists(path),
    });
    return tokens;
  }

  // 1. Global rules: ~/.gemini/GEMINI.md and ~/.gemini/config/rules/*.md
  let rulesTokens = 0;
  rulesTokens += addSystemFile(join(home, '.gemini', 'GEMINI.md'), 'global-rule', '~/.gemini/GEMINI.md');
  const globalRulesDir = join(configRoot, 'rules');
  for (const f of safeReaddir(globalRulesDir).sort()) {
    if (f.endsWith('.md')) {
      rulesTokens += addSystemFile(join(globalRulesDir, f), 'global-rule');
    }
  }

  // 2. Workspace rules: GEMINI.md, AGENTS.md, .agents/rules/*.md
  const dotDirs = ['.agents', '.agent', '_agents', '_agent'];
  for (const ws of workspacePaths) {
    if (!ws) continue;
    rulesTokens += addSystemFile(join(ws, 'GEMINI.md'), 'workspace-rule');
    rulesTokens += addSystemFile(join(ws, 'AGENTS.md'), 'workspace-rule');
    for (const dd of dotDirs) {
      const rDir = join(ws, dd, 'rules');
      for (const f of safeReaddir(rDir).sort()) {
        if (f.endsWith('.md')) {
          rulesTokens += addSystemFile(join(rDir, f), 'workspace-rule');
        }
      }
    }
  }

  // 3. Discover plugins (builtin, global, workspace)
  const pluginRoots = [];
  if (appData) pluginRoots.push({ dir: join(appData, 'builtin', 'plugins'), scope: 'builtin' });
  pluginRoots.push({ dir: join(configRoot, 'plugins'), scope: 'global' });
  for (const ws of workspacePaths) {
    for (const dd of dotDirs) {
      pluginRoots.push({ dir: join(ws, dd, 'plugins'), scope: 'workspace' });
    }
  }

  const plugins = [];
  const seenPluginNames = new Set();
  for (const { dir, scope } of pluginRoots) {
    for (const entry of safeReaddir(dir).sort()) {
      const pDir = join(dir, entry);
      const manifestFile = readCached(join(pDir, 'plugin.json'), 128 * 1024);
      if (!manifestFile.exists) continue;
      const manifest = parseJsonc(manifestFile.text || '') || {};
      const name = typeof manifest.name === 'string' && manifest.name ? manifest.name : entry;
      if (seenPluginNames.has(name)) continue;
      seenPluginNames.add(name);
      const stateOverride = pluginStates[entry];
      const enabled = typeof stateOverride?.enabled === 'boolean'
        ? stateOverride.enabled
        : !manifest.disabled;
      plugins.push({ name, dir: entry, path: pDir, scope, enabled, description: manifest.description || '' });
      if (enabled) {
        // Plugin rules
        rulesTokens += addSystemFile(join(pDir, 'rules', 'AGENTS.md'), 'plugin-rule', `${name}/rules/AGENTS.md`);
        rulesTokens += addSystemFile(join(pDir, 'rules', 'GEMINI.md'), 'plugin-rule', `${name}/rules/GEMINI.md`);
      }
    }
  }

  // 4. Discover skills (progressive disclosure: only name + description + path are injected at startup)
  const skillRoots = [];
  for (const ws of workspacePaths) {
    for (const dd of dotDirs) skillRoots.push({ dir: join(ws, dd, 'skills'), scope: 'workspace' });
  }
  skillRoots.push({ dir: join(configRoot, 'skills'), scope: 'global' });
  if (appData) skillRoots.push({ dir: join(appData, 'builtin', 'skills'), scope: 'builtin' });
  for (const p of plugins) {
    if (p.enabled) skillRoots.push({ dir: join(p.path, 'skills'), scope: `plugin:${p.name}` });
  }

  const catalogSkills = [];
  const seenSkills = new Set();
  let skillCatalogTokens = 0;
  for (const { dir, scope } of skillRoots) {
    for (const entry of safeReaddir(dir).sort()) {
      const skillFile = join(dir, entry, 'SKILL.md');
      const f = readCached(skillFile, 512 * 1024);
      if (!f.exists || !f.text) continue;
      const fm = parseSkillFrontmatter(f.text);
      const skillName = fm.name || entry;
      if (seenSkills.has(skillName)) continue;
      seenSkills.add(skillName);
      const headerLine = `- ${skillName} (${skillFile}): ${fm.description}`;
      const headerTokens = estimateTokens(headerLine);
      const fullTokens = estimateTokens(f.text);
      skillCatalogTokens += headerTokens;
      catalogSkills.push({
        name: skillName,
        scope,
        path: skillFile,
        description: fm.description,
        catalogTokens: headerTokens,
        fullFileTokens: fullTokens,
        uri: toFileUriIfExists(skillFile),
      });
    }
  }

  // 5. Discover MCP servers (global, workspace, enabled plugins)
  const mcpConfigs = [
    { path: join(configRoot, 'mcp_config.json'), scope: 'global' },
    ...workspacePaths.flatMap((ws) => dotDirs.map((dd) => ({ path: join(ws, dd, 'mcp_config.json'), scope: 'workspace' }))),
    ...plugins.filter((p) => p.enabled).map((p) => ({ path: join(p.path, 'mcp_config.json'), scope: `plugin:${p.name}` })),
  ];

  const mcpServers = [];
  let mcpEstimatedTokens = 0;
  for (const { path, scope } of mcpConfigs) {
    const f = readCached(path, 512 * 1024);
    if (!f.exists || !f.text) continue;
    addSystemFile(path, 'mcp-config');
    const parsed = parseJsonc(f.text);
    const map = parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {};
    for (const [serverName, cfg] of Object.entries(map)) {
      if (!cfg || typeof cfg !== 'object' || cfg.disabled === true) continue;
      const est = MCP_SERVER_BASE_SCHEMA_ESTIMATE + estimateTokens(JSON.stringify(cfg));
      mcpEstimatedTokens += est;
      mcpServers.push({ name: serverName, scope, path, estimatedTokens: est });
    }
  }

  // 6. Knowledge files (~/.gemini/antigravity/knowledge or ~/.gemini/knowledge)
  const knowledgeFiles = [];
  const knowledgeDirs = [
    ...(appData ? [join(appData, 'knowledge')] : []),
    join(home, '.gemini', 'knowledge'),
  ];
  const seenKnowledge = new Set();
  for (const kDir of knowledgeDirs) {
    for (const entry of safeReaddir(kDir).sort()) {
      const p = join(kDir, entry);
      const f = readCached(p, 2 * 1024 * 1024);
      if (f.exists && f.isFile && f.text !== null && !seenKnowledge.has(p)) {
        seenKnowledge.add(p);
        knowledgeFiles.push({
          path: p,
          name: entry,
          bytes: f.size,
          tokens: estimateTokens(f.text),
          inContext: false,
          uri: toFileUriIfExists(p),
        });
      }
    }
  }

  const subagentCatalogTokens = 950; // self, research, browser, image-generator + featured_plugins shelf
  return {
    systemFiles,
    rulesTokens,
    skillCatalogTokens,
    subagentCatalogTokens,
    catalogSkills,
    plugins,
    mcpServers,
    mcpEstimatedTokens,
    knowledgeFiles,
  };
}

// ---------------------------------------------------------------------------
// Artifact directory scanner (<appData>/brain/<conv>/)
// ---------------------------------------------------------------------------

function scanArtifacts(appData, conv) {
  if (!appData || !conv) return [];
  const convRoot = join(appData, 'brain', conv);
  const skipDirs = new Set(['.system_generated', 'scratch', '.user_uploaded', 'browser_sandbox']);
  const out = [];

  function walk(dir, depth) {
    if (depth > 3) return;
    for (const entry of safeReaddir(dir).sort()) {
      if (depth === 0 && skipDirs.has(entry)) continue;
      if (entry.startsWith('.')) continue;
      const full = join(dir, entry);
      const st = safeStat(full);
      if (!st.exists) continue;
      if (st.isDir) {
        walk(full, depth + 1);
      } else if (st.isFile) {
        const ext = extname(entry).toLowerCase();
        const isBinary = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf', '.mp4', '.webm'].includes(ext);
        let tokens = 0;
        if (isBinary) {
          tokens = 258; // Standard multimodal image tile token footprint
        } else {
          const { text } = readCached(full, 4 * 1024 * 1024);
          tokens = text !== null ? estimateTokens(text) : Math.round(st.size / 4);
        }
        out.push({
          path: full,
          name: full.slice(convRoot.length + 1),
          bytes: st.size,
          tokens,
          inContext: false,
          uri: toFileUriIfExists(full),
        });
      }
    }
  }

  walk(convRoot, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Main conversation analyzer
// ---------------------------------------------------------------------------

const analysisCache = new Map();

export function analyzeConversation({
  conversationId = '',
  appDataDirs = findAppDataDirs(),
  workspacePaths = [],
  contextLimitOverride = 0,
  title = '',
} = {}) {
  // Resolve target conversation (explicit or most recently active)
  let targetConv = conversationId && ID_RE.test(conversationId) ? conversationId : '';
  if (!targetConv) {
    const recent = listConversations({ appDataDirs });
    targetConv = recent[0]?.conversationId || '';
  }

  const located = targetConv ? locateConversation(targetConv, appDataDirs) : null;
  if (!located) {
    return {
      conversationId: targetConv || null,
      found: false,
      etag: `empty:${targetConv}`,
    };
  }

  const { appData, transcriptPath, isFull } = located;
  const trStat = transcriptPath ? safeStat(transcriptPath) : { exists: false, mtime: 0, size: 0 };
  const hookMeta = readHookSessionMeta(appData, targetConv);
  const explicitWs = (Array.isArray(workspacePaths) ? workspacePaths : [])
    .map(uriToPath)
    .filter(Boolean);
  const hookWs = (Array.isArray(hookMeta?.workspacePaths) ? hookMeta.workspacePaths : [])
    .map(uriToPath)
    .filter(Boolean);
  if (hookMeta?.cwd && isAbsolute(hookMeta.cwd)) hookWs.push(resolve(hookMeta.cwd));

  const cacheKey = [
    appData,
    targetConv,
    transcriptPath,
    `${trStat.mtime}:${trStat.size}`,
    hookMeta?.updatedAt || '',
    explicitWs.join(','),
    String(contextLimitOverride || 0),
    title || '',
  ].join('|');

  const cached = analysisCache.get(cacheKey);
  if (cached) return cached;

  // Parse transcript lines
  const steps = [];
  if (transcriptPath && trStat.exists) {
    const { text } = readCached(transcriptPath, 64 * 1024 * 1024);
    if (text) {
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const s = JSON.parse(line);
          if (s && typeof s === 'object') steps.push(s);
        } catch {
          // Torn final line during active write; picked up on next poll
        }
      }
    }
  }

  // Infer modelName & touched file paths from transcript
  let detectedModel = hookMeta?.modelName && hookMeta.modelName !== 'auto' ? hookMeta.modelName : '';
  const touchedPaths = [];
  for (const s of steps) {
    if (s.type === 'USER_INPUT' && typeof s.content === 'string') {
      for (const m of s.content.matchAll(MODEL_CHANGE_RE)) {
        detectedModel = m[1].trim();
      }
    }
    if (s.type === 'PLANNER_RESPONSE' && Array.isArray(s.tool_calls)) {
      for (const tc of s.tool_calls) {
        const args = tc?.args && typeof tc.args === 'object' ? tc.args : {};
        const p = unquoteArg(args.Path || args.AbsolutePath || args.TargetFile || '');
        if (p && isAbsolute(p)) touchedPaths.push(p);
      }
    }
  }
  const modelName = detectedModel || hookMeta?.modelName || 'Auto (Gemini)';
  const contextLimit = inferContextLimit(modelName, contextLimitOverride);

  // Resolve active workspace paths (explicit > hook > inferred from projects + touched files)
  const wsSet = new Set([...explicitWs, ...hookWs]);
  if (wsSet.size === 0 && touchedPaths.length > 0) {
    const registeredProjects = loadRegisteredProjects();
    for (const tp of touchedPaths) {
      const match = registeredProjects.find((proj) => tp === proj || tp.startsWith(proj + sep));
      if (match) wsSet.add(match);
    }
  }
  const resolvedWorkspaces = [...wsSet];

  // Scan customizations, rules, skills, MCP configs, knowledge, and artifacts
  const env = scanEnvironment({ appData, workspacePaths: resolvedWorkspaces });
  const artifactList = scanArtifacts(appData, targetConv);

  // Detect compaction checkpoints (<CONTEXT_SUMMARY> or sharp planner token drop)
  const checkpoints = [];
  let prevPlannerInput = 0;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const content = typeof s.content === 'string' ? s.content : '';
    const hasSummaryTag = COMPACTION_RE.test(content);
    if (hasSummaryTag) {
      checkpoints.push({
        idx: i,
        stepIndex: Number.isFinite(s.step_index) ? s.step_index : i,
        createdAt: s.created_at || '',
        kind: 'summary',
        tokens: estimateTokens(content),
      });
    } else if (s.type === 'PLANNER_RESPONSE') {
      const totalIn = (Number(s.input_tokens) || 0) + (Number(s.cache_read_tokens) || 0);
      if (prevPlannerInput > 24_000 && totalIn > 0 && totalIn < prevPlannerInput * 0.62) {
        // Avoid double-counting if a <CONTEXT_SUMMARY> step right before this already marked it
        const recentCp = checkpoints[checkpoints.length - 1];
        if (!recentCp || i - recentCp.idx > 6) {
          checkpoints.push({
            idx: i,
            stepIndex: Number.isFinite(s.step_index) ? s.step_index : i,
            createdAt: s.created_at || '',
            kind: 'drop',
            tokens: 0,
          });
        }
      }
      if (totalIn > 0) prevPlannerInput = totalIn;
    }
  }

  const latestCheckpoint = checkpoints.length ? checkpoints[checkpoints.length - 1] : null;
  const activeStartIdx = latestCheckpoint ? latestCheckpoint.idx : 0;

  // Estimate historical compacted tokens prior to activeStartIdx (kept separate from active usage %)
  let historicalCompactedTokens = 0;
  if (activeStartIdx > 0) {
    for (let i = activeStartIdx - 1; i >= 0; i--) {
      const s = steps[i];
      if (s.type === 'PLANNER_RESPONSE') {
        const t = (Number(s.input_tokens) || 0) + (Number(s.cache_read_tokens) || 0) + (Number(s.output_tokens) || 0);
        if (t > 0) {
          historicalCompactedTokens = t;
          break;
        }
      }
    }
    if (!historicalCompactedTokens) {
      for (let i = 0; i < activeStartIdx; i++) {
        historicalCompactedTokens += estimateTokens(steps[i]);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Calibrated Interval Token Accounting on active window [activeStartIdx..N-1]
  // -------------------------------------------------------------------------
  const plannerIndices = [];
  for (let i = activeStartIdx; i < steps.length; i++) {
    if (steps[i].type === 'PLANNER_RESPONSE' && ((Number(steps[i].input_tokens) || 0) + (Number(steps[i].cache_read_tokens) || 0) > 0)) {
      plannerIndices.push(i);
    }
  }

  // Step-level raw weights & tool result alignment
  const stepMeta = new Array(steps.length);
  let currentToolBatch = null;
  let batchResultCursor = 0;

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.type === 'PLANNER_RESPONSE') {
      const calls = Array.isArray(s.tool_calls) ? s.tool_calls : [];
      currentToolBatch = calls;
      batchResultCursor = 0;
      const respRaw = estimateTokens((s.thinking || '') + '\n' + (s.content || ''));
      const thinkingRaw = estimateTokens(s.thinking || '');
      const replyRaw = estimateTokens(s.content || '');
      const tcRaw = calls.length ? estimateTokens(JSON.stringify(calls)) : 0;
      stepMeta[i] = {
        kind: 'planner',
        respRaw,
        thinkingRaw,
        replyRaw,
        tcRaw,
        calls,
      };
    } else if (s.type === 'GENERIC' && s.source === 'MODEL') {
      const matchedCall = currentToolBatch && batchResultCursor < currentToolBatch.length
        ? currentToolBatch[batchResultCursor++]
        : null;
      stepMeta[i] = {
        kind: 'tool_result',
        raw: Math.max(1, estimateTokens(s.content || '')),
        toolCall: matchedCall,
      };
    } else if (s.type === 'USER_INPUT' || s.source === 'USER_EXPLICIT') {
      const content = typeof s.content === 'string' ? s.content : '';
      const isCheckpointSummary = COMPACTION_RE.test(content);
      stepMeta[i] = {
        kind: isCheckpointSummary ? 'checkpoint_summary' : 'user',
        raw: Math.max(1, estimateTokens(content)),
      };
    } else {
      stepMeta[i] = {
        kind: 'system_msg',
        raw: Math.max(1, estimateTokens((s.content || '') + (s.error || ''))),
      };
    }
  }

  let userTokens = 0;
  let agentResponseTokens = 0;
  let agentThinkingTokens = 0;
  let agentVisibleReplyTokens = 0;
  let toolCallTokens = 0;
  let systemMessageTokens = 0;
  let checkpointSummaryTokens = 0;

  // Per-tool & per-file attribution accumulators
  const toolStats = new Map(); // toolName -> { name, calls, argTokens, outputTokens, totalTokens }
  const inContextFileTokens = new Map(); // resolvedPath -> { path, tokens, reads, writes, tool }

  function recordToolTokens(toolName, argTok, outTok, tcArgs) {
    const name = toolName || 'unknown_tool';
    const cur = toolStats.get(name) || { name, calls: 0, argTokens: 0, outputTokens: 0, totalTokens: 0 };
    if (argTok > 0) cur.calls += 1;
    cur.argTokens += argTok;
    cur.outputTokens += outTok;
    cur.totalTokens += argTok + outTok;
    toolStats.set(name, cur);

    if (tcArgs && typeof tcArgs === 'object') {
      const rawPath = unquoteArg(tcArgs.Path || tcArgs.AbsolutePath || tcArgs.TargetFile || '');
      if (rawPath && isAbsolute(rawPath)) {
        let key = rawPath;
        try {
          if (existsSync(rawPath)) key = realpathSync(rawPath);
        } catch {
          // keep rawPath
        }
        const entry = inContextFileTokens.get(key) || {
          path: rawPath,
          realPath: key,
          tokens: 0,
          reads: 0,
          writes: 0,
        };
        entry.tokens += argTok + outTok;
        if (name === 'read_file' || name === 'view_file') entry.reads += 1;
        else if (name === 'write_file' || name === 'edit_file') entry.writes += 1;
        inContextFileTokens.set(key, entry);
      }
    }
  }

  function attributePlannerOutput(idx, exactOutTokens) {
    const meta = stepMeta[idx];
    const totalRaw = Math.max(1, meta.respRaw + meta.tcRaw);
    const tcShare = meta.tcRaw > 0 ? Math.round((exactOutTokens * meta.tcRaw) / totalRaw) : 0;
    const respShare = Math.max(0, exactOutTokens - tcShare);
    agentResponseTokens += respShare;
    const respParts = Math.max(1, meta.thinkingRaw + meta.replyRaw);
    const thinkShare = meta.thinkingRaw > 0 ? Math.round((respShare * meta.thinkingRaw) / respParts) : 0;
    agentThinkingTokens += thinkShare;
    agentVisibleReplyTokens += Math.max(0, respShare - thinkShare);
    toolCallTokens += tcShare;

    // Split tcShare across individual tool calls in this batch
    if (meta.calls.length > 0) {
      const weights = meta.calls.map((c) => Math.max(1, estimateTokens(JSON.stringify(c))));
      const wSum = weights.reduce((a, b) => a + b, 0) || 1;
      let assigned = 0;
      meta.calls.forEach((c, k) => {
        const share = k === meta.calls.length - 1
          ? Math.max(0, tcShare - assigned)
          : Math.round((tcShare * weights[k]) / wSum);
        assigned += share;
        recordToolTokens(c?.name || 'tool', share, 0, c?.args);
      });
    }
  }

  function attributeStepRange(fromIdx, toExclusiveIdx, exactTotalOrNull) {
    if (fromIdx >= toExclusiveIdx) return;
    const indices = [];
    let rawSum = 0;
    for (let j = fromIdx; j < toExclusiveIdx; j++) {
      if (stepMeta[j].kind === 'planner') continue;
      indices.push(j);
      rawSum += stepMeta[j].raw;
    }
    if (!indices.length) return;
    const targetTotal = exactTotalOrNull !== null ? Math.max(0, exactTotalOrNull) : rawSum;
    let assigned = 0;
    indices.forEach((j, pos) => {
      const m = stepMeta[j];
      const tok = pos === indices.length - 1
        ? Math.max(0, targetTotal - assigned)
        : Math.round((targetTotal * m.raw) / Math.max(1, rawSum));
      assigned += tok;
      if (m.kind === 'user') {
        userTokens += tok;
      } else if (m.kind === 'checkpoint_summary') {
        checkpointSummaryTokens += tok;
      } else if (m.kind === 'tool_result') {
        toolCallTokens += tok;
        recordToolTokens(m.toolCall?.name || 'tool_output', 0, tok, m.toolCall?.args);
      } else {
        systemMessageTokens += tok;
      }
    });
  }

  // System envelope calculation
  let systemEnvelopeTokens = 0;
  if (plannerIndices.length > 0) {
    const p0 = plannerIndices[0];
    const t0 = (Number(steps[p0].input_tokens) || 0) + (Number(steps[p0].cache_read_tokens) || 0);
    let preRaw = 0;
    for (let j = activeStartIdx; j < p0; j++) {
      if (stepMeta[j].kind !== 'planner') preRaw += stepMeta[j].raw;
    }
    if (preRaw <= t0) {
      systemEnvelopeTokens = t0 - preRaw;
      attributeStepRange(activeStartIdx, p0, preRaw);
    } else {
      systemEnvelopeTokens = 0;
      attributeStepRange(activeStartIdx, p0, t0);
    }

    // Calibrate every consecutive planner interval [p_{k-1}, p_k]
    for (let k = 1; k < plannerIndices.length; k++) {
      const prevIdx = plannerIndices[k - 1];
      const curIdx = plannerIndices[k];
      const tPrev = (Number(steps[prevIdx].input_tokens) || 0) + (Number(steps[prevIdx].cache_read_tokens) || 0);
      const outPrev = Number(steps[prevIdx].output_tokens) || (stepMeta[prevIdx].respRaw + stepMeta[prevIdx].tcRaw);
      const tCur = (Number(steps[curIdx].input_tokens) || 0) + (Number(steps[curIdx].cache_read_tokens) || 0);
      attributePlannerOutput(prevIdx, outPrev);
      const delta = Math.max(0, (tCur - tPrev) - outPrev);
      attributeStepRange(prevIdx + 1, curIdx, delta);
    }

    // Final planner step + any trailing in-flight steps
    const lastP = plannerIndices[plannerIndices.length - 1];
    const lastOut = Number(steps[lastP].output_tokens) || (stepMeta[lastP].respRaw + stepMeta[lastP].tcRaw);
    attributePlannerOutput(lastP, lastOut);
    attributeStepRange(lastP + 1, steps.length, null);
  } else {
    // Conversation has no PLANNER_RESPONSE yet (freshly opened)
    systemEnvelopeTokens = BUILTIN_SYSTEM_TOOLS_ESTIMATE + 6200 + env.rulesTokens + env.skillCatalogTokens + env.subagentCatalogTokens + env.mcpEstimatedTokens;
    attributeStepRange(activeStartIdx, steps.length, null);
  }

  // Decompose systemEnvelopeTokens cleanly into:
  //   System prompt, System tools, Customizations, MCP tools, System overhead
  let mcpTokens = 0;
  let customizationsTokens = 0;
  let systemToolsTokens = 0;
  let systemPromptTokens = 0;
  let systemOverheadTokens = 0;

  const rawCustomizations = env.rulesTokens + env.skillCatalogTokens + env.subagentCatalogTokens;
  const rawMcp = env.mcpEstimatedTokens;

  if (systemEnvelopeTokens > 0) {
    let rem = systemEnvelopeTokens;
    mcpTokens = Math.min(rem, rawMcp);
    rem -= mcpTokens;
    customizationsTokens = Math.min(rem, rawCustomizations);
    rem -= customizationsTokens;
    systemToolsTokens = Math.min(rem, BUILTIN_SYSTEM_TOOLS_ESTIMATE);
    rem -= systemToolsTokens;
    systemPromptTokens = Math.round(rem * 0.78);
    systemOverheadTokens = Math.max(0, rem - systemPromptTokens) + systemMessageTokens;
  } else {
    systemOverheadTokens = systemMessageTokens;
  }

  // Total active tokens in the context window
  // Note: checkpointSummaryTokens (when a <CONTEXT_SUMMARY> exists at activeStartIdx) is part of
  // the input sent to the model AND tracked in Checkpoint buffer, so we surface it transparently.
  const activeConversationTokens = userTokens + agentResponseTokens + toolCallTokens;
  const activeSystemTokens = systemPromptTokens + systemToolsTokens + customizationsTokens + mcpTokens + systemOverheadTokens;
  const totalActiveTokens = activeConversationTokens + activeSystemTokens + checkpointSummaryTokens;
  const freeSpaceTokens = Math.max(0, contextLimit - totalActiveTokens);
  const usagePercent = Math.min(100, (totalActiveTokens / Math.max(1, contextLimit)) * 100);

  // Cache & cumulative token telemetry across the whole session
  let latestInputUncached = 0;
  let latestCacheRead = 0;
  let latestOutput = 0;
  let cumulativeOutputTokens = 0;
  let cumulativeUncachedInput = 0;
  let cumulativeCacheRead = 0;
  const turns = [];

  const cpIndexSet = new Set(checkpoints.map((c) => c.idx));
  let sawCompactionSinceLastTurn = false;
  for (let i = 0; i < steps.length; i++) {
    if (cpIndexSet.has(i)) sawCompactionSinceLastTurn = true;
    const s = steps[i];
    if (s.type !== 'PLANNER_RESPONSE') continue;
    const inp = Number(s.input_tokens) || 0;
    const cache = Number(s.cache_read_tokens) || 0;
    const out = Number(s.output_tokens) || 0;
    const totalIn = inp + cache;
    cumulativeUncachedInput += inp;
    cumulativeCacheRead += cache;
    cumulativeOutputTokens += out;
    if (totalIn > 0) {
      latestInputUncached = inp;
      latestCacheRead = cache;
      latestOutput = out;
    }
    const calls = Array.isArray(s.tool_calls) ? s.tool_calls.map((c) => c?.name || 'tool') : [];
    turns.push({
      turnNumber: turns.length + 1,
      stepIndex: Number.isFinite(s.step_index) ? s.step_index : i,
      createdAt: s.created_at || '',
      uncachedInputTokens: inp,
      cacheReadTokens: cache,
      totalInputTokens: totalIn,
      outputTokens: out,
      cacheHitRatio: totalIn > 0 ? cache / totalIn : 0,
      toolCalls: calls,
      afterCompaction: sawCompactionSinceLastTurn,
    });
    sawCompactionSinceLastTurn = false;
  }

  const latestTotalInput = latestInputUncached + latestCacheRead;
  const cacheHitPercent = latestTotalInput > 0 ? (latestCacheRead / latestTotalInput) * 100 : 0;

  // -------------------------------------------------------------------------
  // Breakdown rows matching `agy` CLI `/context` symbols & categories
  // -------------------------------------------------------------------------
  const pctOf = (tok) => (tok / Math.max(1, contextLimit)) * 100;

  const breakdown = [
    {
      id: 'user_messages',
      symbol: '◉',
      group: 'conversation',
      label: 'User messages',
      description: 'User prompts, instructions, and inline attachments',
      tokens: userTokens,
      percent: pctOf(userTokens),
      colorKey: 'user',
    },
    {
      id: 'agent_responses',
      symbol: '◉',
      group: 'conversation',
      label: 'Agent responses',
      description: `Model replies (${agentVisibleReplyTokens.toLocaleString()} tok) & reasoning (${agentThinkingTokens.toLocaleString()} tok)`,
      tokens: agentResponseTokens,
      thinkingTokens: agentThinkingTokens,
      replyTokens: agentVisibleReplyTokens,
      percent: pctOf(agentResponseTokens),
      colorKey: 'agent',
    },
    {
      id: 'tool_calls',
      symbol: '◉',
      group: 'conversation',
      label: 'Tool calls',
      description: 'Tool arguments and command / file / search outputs',
      tokens: toolCallTokens,
      percent: pctOf(toolCallTokens),
      colorKey: 'tools',
    },
    {
      id: 'system_prompt',
      symbol: '⛁',
      group: 'system',
      label: 'System prompt',
      description: 'Core agent identity, instructions, and behavioral guidelines',
      tokens: systemPromptTokens,
      percent: pctOf(systemPromptTokens),
      colorKey: 'system',
    },
    {
      id: 'system_tools',
      symbol: '⛁',
      group: 'system',
      label: 'System tools',
      description: 'Built-in tool declarations (file, shell, subagents, browser, search)',
      tokens: systemToolsTokens,
      percent: pctOf(systemToolsTokens),
      colorKey: 'systools',
    },
    {
      id: 'customizations',
      symbol: '⛁',
      group: 'system',
      label: 'Customizations',
      description: `Rules (${env.rulesTokens.toLocaleString()} tok), skills catalog (${env.catalogSkills.length}), plugins (${env.plugins.filter((p) => p.enabled).length}) & subagents`,
      tokens: customizationsTokens,
      percent: pctOf(customizationsTokens),
      colorKey: 'custom',
    },
    {
      id: 'mcp_tools',
      symbol: '⛁',
      group: 'system',
      label: 'MCP tools',
      description: env.mcpServers.length
        ? `${env.mcpServers.length} connected MCP server${env.mcpServers.length === 1 ? '' : 's'}`
        : 'No connected MCP servers active in this workspace',
      tokens: mcpTokens,
      percent: pctOf(mcpTokens),
      colorKey: 'mcp',
    },
    {
      id: 'system_overhead',
      symbol: '⛁',
      group: 'system',
      label: 'System overhead',
      description: 'Turn framing, metadata headers, and system event messages',
      tokens: systemOverheadTokens,
      percent: pctOf(systemOverheadTokens),
      colorKey: 'overhead',
    },
  ];

  if (checkpointSummaryTokens > 0) {
    breakdown.push({
      id: 'checkpoint_in_context',
      symbol: '⊠',
      group: 'checkpoint',
      label: 'Active checkpoint summary',
      description: 'Condensed summary replacing compacted earlier turns',
      tokens: checkpointSummaryTokens,
      percent: pctOf(checkpointSummaryTokens),
      colorKey: 'checkpoint',
    });
  }

  const freeRow = {
    id: 'free_space',
    symbol: '□',
    group: 'free',
    label: 'Free space',
    description: 'Remaining capacity before reaching the model context window ceiling',
    tokens: freeSpaceTokens,
    percent: pctOf(freeSpaceTokens),
    colorKey: 'free',
  };

  const checkpointBufferRow = {
    id: 'checkpoint_buffer',
    symbol: '⊠',
    group: 'buffer',
    label: 'Checkpoint buffer',
    description: checkpoints.length
      ? `${checkpoints.length} compaction checkpoint${checkpoints.length === 1 ? '' : 's'} (${historicalCompactedTokens.toLocaleString()} historical tokens condensed outside active grid)`
      : 'Compaction buffer (0 checkpoints compacted; use /compact when needed)',
    tokens: checkpointSummaryTokens || historicalCompactedTokens,
    historicalTokens: historicalCompactedTokens,
    inContextSummaryTokens: checkpointSummaryTokens,
    checkpointCount: checkpoints.length,
    compactedStepCount: activeStartIdx,
    colorKey: 'checkpoint',
  };

  // -------------------------------------------------------------------------
  // Build proportional 20 x 10 = 200-cell grid (0.5% of context limit per cell)
  // Ordered in prompt layout order: ⛁ System prefix -> ⊠ Checkpoint -> ◉ Conversation -> □ Free space
  // -------------------------------------------------------------------------
  const GRID_COLS = 20;
  const GRID_ROWS = 10;
  const TOTAL_CELLS = GRID_COLS * GRID_ROWS;
  const tokensPerCell = contextLimit / TOTAL_CELLS;

  const gridOrder = [
    ...breakdown.filter((r) => r.group === 'system'),
    ...breakdown.filter((r) => r.group === 'checkpoint'),
    ...breakdown.filter((r) => r.group === 'conversation'),
  ];

  const gridCells = [];
  let allocatedCells = 0;
  for (const row of gridOrder) {
    if (row.tokens <= 0) continue;
    // Guarantee at least 1 visible cell for any non-zero category so small items stay inspectable
    const rawCells = row.tokens / tokensPerCell;
    const count = Math.min(TOTAL_CELLS - allocatedCells, Math.max(1, Math.round(rawCells)));
    for (let c = 0; c < count; c++) {
      gridCells.push({
        id: row.id,
        symbol: row.symbol,
        label: row.label,
        colorKey: row.colorKey,
        tokens: row.tokens,
        percent: row.percent,
      });
    }
    allocatedCells += count;
    if (allocatedCells >= TOTAL_CELLS) break;
  }
  while (gridCells.length < TOTAL_CELLS) {
    gridCells.push({
      id: 'free_space',
      symbol: '□',
      label: 'Free space',
      colorKey: 'free',
      tokens: freeSpaceTokens,
      percent: freeRow.percent,
    });
  }

  // -------------------------------------------------------------------------
  // Classify Tracked Files (Knowledge, Artifacts, Skills, Workspace, System)
  // -------------------------------------------------------------------------
  const skillFilesLoaded = [];
  const workspaceFilesLoaded = [];
  const artifactMap = new Map(artifactList.map((a) => [a.uri || a.path, { ...a }]));
  const knowledgeMap = new Map(env.knowledgeFiles.map((k) => [k.uri || k.path, { ...k }]));

  const convBrainRoot = join(appData, 'brain', targetConv);
  const homePrefix = homedir() + sep;

  for (const entry of inContextFileTokens.values()) {
    const p = entry.path;
    const uri = toFileUriIfExists(p);
    const key = uri || p;
    const st = safeStat(p);
    let diskTokens = entry.tokens;
    if (st.exists && st.isFile && st.size <= 4 * 1024 * 1024) {
      const f = readCached(p, 4 * 1024 * 1024);
      if (f.text !== null) diskTokens = estimateTokens(f.text);
    }

    const isInsideWorkspace = resolvedWorkspaces.some((ws) => p.startsWith(ws + sep));

    if (p.includes('/knowledge/') || knowledgeMap.has(key)) {
      const existing = knowledgeMap.get(key);
      if (existing) {
        existing.inContext = true;
        existing.contextTokens = entry.tokens;
      } else {
        knowledgeMap.set(key, {
          path: p,
          name: basename(p),
          bytes: st.size > 0 ? st.size : 0,
          tokens: entry.tokens,
          contextTokens: entry.tokens,
          inContext: true,
          uri,
        });
      }
    } else if (p.includes('/skills/') && (entry.reads > 0 || !isInsideWorkspace)) {
      // Extract readable skill relative label e.g. "plugin/SKILL.md"
      const idx = p.lastIndexOf('/skills/');
      const relSkill = idx >= 0 ? p.slice(idx + '/skills/'.length) : basename(p);
      skillFilesLoaded.push({
        path: p,
        name: relSkill,
        bytes: st.size > 0 ? st.size : 0,
        tokens: entry.tokens,
        fileTokens: diskTokens,
        reads: entry.reads,
        inContext: true,
        uri,
      });
    } else if (p.startsWith(convBrainRoot + sep)) {
      if (!p.includes(`${sep}.system_generated${sep}`) && !p.includes(`${sep}scratch${sep}`)) {
        const existing = artifactMap.get(key);
        if (existing) {
          existing.inContext = true;
          existing.contextTokens = entry.tokens;
        } else {
          artifactMap.set(key, {
            path: p,
            name: p.slice(convBrainRoot.length + 1),
            bytes: st.size > 0 ? st.size : 0,
            tokens: entry.tokens,
            contextTokens: entry.tokens,
            inContext: true,
            uri,
          });
        }
      }
    } else {
      // Workspace or external source file read/edited during conversation
      let displayName = p.startsWith(homePrefix) ? `~/${p.slice(homePrefix.length)}` : p;
      for (const ws of resolvedWorkspaces) {
        if (p.startsWith(ws + sep)) {
          displayName = p.slice(ws.length + 1);
          break;
        }
      }
      workspaceFilesLoaded.push({
        path: p,
        name: displayName,
        bytes: st.size > 0 ? st.size : 0,
        tokens: entry.tokens,
        fileTokens: diskTokens,
        reads: entry.reads,
        writes: entry.writes,
        inContext: true,
        uri,
      });
    }
  }

  skillFilesLoaded.sort((a, b) => b.tokens - a.tokens);
  workspaceFilesLoaded.sort((a, b) => b.tokens - a.tokens);
  const finalKnowledgeFiles = [...knowledgeMap.values()].sort((a, b) => (b.contextTokens || b.tokens) - (a.contextTokens || a.tokens));
  const finalArtifactFiles = [...artifactMap.values()].sort((a, b) => (b.contextTokens || b.tokens) - (a.contextTokens || a.tokens));
  const sortedTools = [...toolStats.values()].sort((a, b) => b.totalTokens - a.totalTokens);

  const report = {
    conversationId: targetConv,
    title: title || '',
    found: true,
    appData,
    transcriptPath,
    transcriptIsFull: isFull,
    updatedAt: trStat.mtime ? new Date(trStat.mtime).toISOString() : new Date().toISOString(),
    etag: cacheKey,
    model: {
      name: modelName,
      contextLimit,
      limitOverridden: Boolean(contextLimitOverride && contextLimitOverride >= 4096),
    },
    workspaces: resolvedWorkspaces,
    summary: {
      totalActiveTokens,
      freeSpaceTokens,
      contextLimit,
      usagePercent: Number(usagePercent.toFixed(2)),
      activeConversationTokens,
      activeSystemTokens,
      latestUncachedInputTokens: latestInputUncached,
      latestCacheReadTokens: latestCacheRead,
      latestOutputTokens: latestOutput,
      cacheHitPercent: Number(cacheHitPercent.toFixed(1)),
      cumulativeOutputTokens,
      cumulativeUncachedInputTokens: cumulativeUncachedInput,
      cumulativeCacheReadTokens: cumulativeCacheRead,
      totalSteps: steps.length,
      activeSteps: steps.length - activeStartIdx,
      modelTurns: turns.length,
    },
    grid: {
      cols: GRID_COLS,
      rows: GRID_ROWS,
      totalCells: TOTAL_CELLS,
      tokensPerCell: Math.round(tokensPerCell),
      cells: gridCells,
    },
    breakdown,
    freeSpace: freeRow,
    checkpoints: {
      row: checkpointBufferRow,
      count: checkpoints.length,
      compactedStepCount: activeStartIdx,
      historicalCompactedTokens,
      activeCheckpoint: latestCheckpoint,
      items: checkpoints,
    },
    tools: sortedTools,
    turns,
    trackedFiles: {
      knowledge: finalKnowledgeFiles,
      artifacts: finalArtifactFiles,
      skills: skillFilesLoaded,
      catalogSkills: env.catalogSkills,
      workspace: workspaceFilesLoaded,
      system: env.systemFiles,
    },
    customizations: {
      plugins: env.plugins,
      mcpServers: env.mcpServers,
      rulesTokens: env.rulesTokens,
      skillCatalogTokens: env.skillCatalogTokens,
    },
  };

  if (analysisCache.size > 64) analysisCache.clear();
  analysisCache.set(cacheKey, report);
  return report;
}

// ---------------------------------------------------------------------------
// Authentic `agy` CLI `/context` text formatter (used by CLI skill & Raw tab)
// ---------------------------------------------------------------------------

function fmtTok(n) {
  const v = Number(n) || 0;
  if (v === 1_048_576) return '1.0M';
  if (v === 2_097_152) return '2.0M';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 10_000) return `${(v / 1_000).toFixed(1)}k`;
  return v.toLocaleString('en-US');
}

export function formatCliContext(report) {
  if (!report || !report.found) {
    return 'Context Usage (/context)\n  No active conversation transcript found.\n';
  }

  const { model, summary, grid, breakdown, freeSpace, checkpoints, trackedFiles } = report;
  const lines = [];
  const hr = '─'.repeat(78);

  lines.push(`Context Usage · ${model.name}`);
  lines.push(
    `${fmtTok(summary.totalActiveTokens)} / ${fmtTok(summary.contextLimit)} tokens (${summary.usagePercent.toFixed(1)}%)` +
    ` · Free: ${fmtTok(summary.freeSpaceTokens)} (${freeSpace.percent.toFixed(1)}%)` +
    (summary.cacheHitPercent > 0 ? ` · Cache hit: ${summary.cacheHitPercent.toFixed(1)}%` : '')
  );
  lines.push(hr);

  // Build 10 grid rows on the left + breakdown summary rows on the right
  const gridLines = [];
  for (let r = 0; r < grid.rows; r++) {
    const slice = grid.cells.slice(r * grid.cols, (r + 1) * grid.cols);
    gridLines.push(slice.map((c) => c.symbol).join(' '));
  }

  const rightRows = [
    ...breakdown.map((b) => `${b.symbol} ${b.label.padEnd(20)} ${fmtTok(b.tokens).padStart(8)}  (${b.percent.toFixed(1).padStart(5)}%)`),
    `${freeSpace.symbol} ${freeSpace.label.padEnd(20)} ${fmtTok(freeSpace.tokens).padStart(8)}  (${freeSpace.percent.toFixed(1).padStart(5)}%)`,
    `${checkpoints.row.symbol} ${checkpoints.row.label.padEnd(20)} ${fmtTok(checkpoints.row.tokens).padStart(8)}  (${checkpoints.count} ckpt)`,
  ];

  const rowCount = Math.max(gridLines.length, rightRows.length);
  for (let i = 0; i < rowCount; i++) {
    const left = (gridLines[i] || '').padEnd(grid.cols * 2 - 1);
    const right = rightRows[i] || '';
    lines.push(`  ${left}   ${right}`);
  }

  lines.push(hr);
  lines.push('Checkpoints & Session Telemetry');
  if (checkpoints.count > 0) {
    lines.push(
      `  ⊠ Active checkpoint at step #${checkpoints.activeCheckpoint.stepIndex} · ` +
      `${checkpoints.count} checkpoint(s) compacted (${checkpoints.compactedStepCount} earlier steps, ~${fmtTok(checkpoints.historicalCompactedTokens)} tok)`
    );
  } else {
    lines.push('  ⊠ No compaction checkpoints yet (all turns active in context; run /compact to condense)');
  }
  lines.push(
    `  ⚡ Latest turn input: ${fmtTok(summary.latestCacheReadTokens)} cached + ${fmtTok(summary.latestUncachedInputTokens)} uncached` +
    ` · Output cumulative: ${fmtTok(summary.cumulativeOutputTokens)} across ${summary.modelTurns} turn(s)`
  );

  lines.push(hr);
  lines.push('Tracked Files');

  const pushFileGroup = (heading, items, showPath = false) => {
    lines.push(`  ${heading} (${items.length})`);
    if (!items.length) {
      lines.push('    (none)');
      return;
    }
    for (const f of items.slice(0, 15)) {
      const label = showPath ? f.path : f.name;
      lines.push(`    • ${label} — ${fmtTok(f.tokens)} tok`);
    }
    if (items.length > 15) {
      lines.push(`    … and ${items.length - 15} more`);
    }
  };

  pushFileGroup('Knowledge files', trackedFiles.knowledge);
  pushFileGroup('Artifact files', trackedFiles.artifacts);
  pushFileGroup('Skill files (loaded in context)', trackedFiles.skills);
  pushFileGroup('Workspace files (read/edited)', trackedFiles.workspace);
  pushFileGroup('System & Rule files', trackedFiles.system, true);

  return lines.join('\n') + '\n';
}
