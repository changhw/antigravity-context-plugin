/**
 * Context Usage (/context) UI Extension sidecar backend for Antigravity Desktop.
 *
 * Uses `sidecar_sdk` (`SidecarApp`) when supervised by Antigravity's Language
 * Server, and falls back to Node's built-in `node:http` server when run with
 * `--standalone` for local development or automated testing.
 *
 * Continuously tracks live TTFT (prefill -> first token -> streaming speed)
 * for active conversations via Language Server trajectory & generator metadata.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import {
  analyzeConversation,
  findAppDataDirs,
  formatCliContext,
  ID_RE,
  listConversations,
  locateConversation,
  uriToPath,
} from './analyzer.mjs';
import { collectLiveTelemetry } from './ls_telemetry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATIC_ASSETS = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

// ---------------------------------------------------------------------------
// Async conversation title cache via `agentapi get-conversation-metadata`
// ---------------------------------------------------------------------------

const titleCache = new Map(); // convId -> string | Promise

function fetchConversationTitle(conv) {
  const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
  const file = exe || 'agentapi';
  const args = [...(exe ? ['agentapi'] : []), 'get-conversation-metadata', conv];
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf-8', timeout: 4000 }, (err, stdout) => {
      if (err) return resolve('');
      try {
        const md = JSON.parse(stdout || '{}');
        resolve(md.title || md.summary || md.name || md.metadata?.title || md.conversation?.title || '');
      } catch {
        resolve('');
      }
    });
  });
}

function getConversationTitle(conv) {
  if (!conv || !ID_RE.test(conv)) return '';
  const hit = titleCache.get(conv);
  if (typeof hit === 'string') return hit;
  if (!hit) {
    titleCache.set(
      conv,
      fetchConversationTitle(conv).then((t) => {
        titleCache.set(conv, t || '');
      })
    );
  }
  return '';
}

function parseWorkspaceParam(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(uriToPath).filter(Boolean);
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return arr.map(uriToPath).filter(Boolean);
    } catch {
      // fall through
    }
  }
  return trimmed.split(',').map((s) => uriToPath(s.trim())).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Non-blocking background live TTFT watcher for active pane conversations
// (keeps SidecarApp route handlers synchronous and sub-millisecond!)
// ---------------------------------------------------------------------------

const TELEMETRY_REFRESH_MS = 450;
const TELEMETRY_IDLE_TTL_MS = 60_000;
const telemetryWatches = new Map(); // convId -> { appData, snapshot, lastAskedAt, lastFetchedAt, pending }

function refreshTelemetryWatch(convId, entry) {
  if (entry.pending) return entry.pending;
  entry.pending = collectLiveTelemetry(convId, entry.appData)
    .then((snap) => {
      if (snap) entry.snapshot = snap;
      entry.lastFetchedAt = Date.now();
    })
    .catch(() => {
      entry.lastFetchedAt = Date.now();
    })
    .finally(() => {
      entry.pending = null;
    });
  return entry.pending;
}

function getOrWatchLiveTelemetry(convId, appData) {
  if (!convId || !ID_RE.test(convId)) return null;
  let entry = telemetryWatches.get(convId);
  if (!entry) {
    entry = {
      appData: appData || '',
      snapshot: null,
      lastAskedAt: Date.now(),
      lastFetchedAt: 0,
      pending: null,
    };
    telemetryWatches.set(convId, entry);
  }
  entry.lastAskedAt = Date.now();
  if (appData) entry.appData = appData;
  if (Date.now() - entry.lastFetchedAt >= TELEMETRY_REFRESH_MS) {
    refreshTelemetryWatch(convId, entry);
  }
  return entry.snapshot;
}

setInterval(() => {
  const now = Date.now();
  for (const [convId, entry] of telemetryWatches.entries()) {
    if (now - entry.lastAskedAt > TELEMETRY_IDLE_TTL_MS) {
      telemetryWatches.delete(convId);
      continue;
    }
    if (now - entry.lastFetchedAt >= TELEMETRY_REFRESH_MS) {
      refreshTelemetryWatch(convId, entry);
    }
  }
}, TELEMETRY_REFRESH_MS).unref();

// ---------------------------------------------------------------------------
// API route handlers
// ---------------------------------------------------------------------------

function buildContextResponse(data = {}, defaultConvId = '') {
  const requestedConv = typeof data.conversationId === 'string' && ID_RE.test(data.conversationId)
    ? data.conversationId
    : (defaultConvId && ID_RE.test(defaultConvId) ? defaultConvId : '');
  const workspaces = parseWorkspaceParam(data.workspaces);
  const limit = Number(data.limit) > 0 ? Number(data.limit) : 0;
  const appDataDirs = findAppDataDirs();

  let resolvedConv = requestedConv;
  if (!resolvedConv) {
    const recent = listConversations({ appDataDirs });
    resolvedConv = recent[0]?.conversationId || '';
  }
  const located = resolvedConv ? locateConversation(resolvedConv, appDataDirs) : null;
  const liveTelemetry = resolvedConv ? getOrWatchLiveTelemetry(resolvedConv, located?.appData || '') : null;

  const report = analyzeConversation({
    conversationId: resolvedConv,
    appDataDirs,
    workspacePaths: workspaces,
    contextLimitOverride: limit,
    title: resolvedConv ? getConversationTitle(resolvedConv) : '',
    liveTelemetry,
  });

  if (report.found && !report.title && report.conversationId) {
    const resolvedTitle = getConversationTitle(report.conversationId);
    if (resolvedTitle) report.title = resolvedTitle;
  }

  const fullEtag = `${report.etag}|${report.title || ''}`;
  // While actively waiting on first token or streaming, always return fresh live state
  const isLiveActive = report.ttft?.live?.phase && report.ttft.live.phase !== 'idle';
  if (!isLiveActive && data.etag && data.etag === fullEtag) {
    return {
      conversationId: report.conversationId,
      found: report.found,
      unchanged: true,
      etag: fullEtag,
    };
  }

  return {
    ...report,
    etag: fullEtag,
    cliText: report.found ? formatCliContext(report) : '',
  };
}

function handleConversationsRequest() {
  const appDataDirs = findAppDataDirs();
  const conversations = listConversations({
    appDataDirs,
    titleResolver: getConversationTitle,
  }).slice(0, 50);
  return { conversations };
}

// ---------------------------------------------------------------------------
// Bootstrap: SidecarApp (Antigravity host) or standalone HTTP server
// ---------------------------------------------------------------------------

async function start() {
  const standaloneFlag = process.argv.includes('--standalone');
  let sdk = null;
  if (!standaloneFlag) {
    try {
      sdk = await import('sidecar_sdk');
    } catch {
      // Fall back to standalone HTTP server if launched outside Antigravity's loader
    }
  }

  if (sdk?.SidecarApp) {
    const { SidecarApp, Response } = sdk;
    const app = new SidecarApp();

    app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

    for (const [route, [file, contentType]] of Object.entries(STATIC_ASSETS)) {
      app.api(route, () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType }), 'GET');
    }

    app.api('/api/context', (data) => buildContextResponse(data || {}, app.config?.conversationId || ''), 'GET');
    app.api('/api/conversations', () => handleConversationsRequest(), 'GET');

    console.log(`[context_panel] starting SidecarApp; app data dirs: ${findAppDataDirs().join(', ')}`);
    app.run();
    return;
  }

  // Standalone local HTTP server mode (`node main.mjs --standalone [--port 8787]`)
  const portIdx = process.argv.indexOf('--port');
  const envPort = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) || 0;
  const port = portIdx >= 0 && process.argv[portIdx + 1] ? Number(process.argv[portIdx + 1]) : (envPort || 8787);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(__dirname, 'index.html'), 'utf-8'));
      return;
    }
    if (pathname === '/preload.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end('window.sidecar = window.sidecar || {};\n');
      return;
    }
    if (STATIC_ASSETS[pathname]) {
      const [file, contentType] = STATIC_ASSETS[pathname];
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(readFileSync(join(__dirname, file), 'utf-8'));
      return;
    }
    if (pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (pathname === '/api/context') {
      const params = Object.fromEntries(url.searchParams.entries());
      const defaultConv = process.env.ANTIGRAVITY_CONVERSATION_ID || '';
      const conv = params.conversationId || defaultConv;
      if (conv && ID_RE.test(conv)) {
        const entry = telemetryWatches.get(conv);
        if (!entry) {
          getOrWatchLiveTelemetry(conv, '');
          await telemetryWatches.get(conv)?.pending;
        }
      }
      const body = buildContextResponse(params, defaultConv);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
      return;
    }
    if (pathname === '/api/conversations') {
      const body = handleConversationsRequest();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });

  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : port;
    console.log(`[context_panel] standalone server listening on http://127.0.0.1:${boundPort}`);
  });
}

start();
