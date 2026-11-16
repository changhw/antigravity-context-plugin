/**
 * Live TTFT (Time-To-First-Token) and streaming latency collector for Antigravity Desktop.
 *
 * Combines three sanctioned, read-only sources:
 *   1. Language Server trajectory & generator metadata RPCs (`ANTIGRAVITY_LS_ADDRESS`
 *      + `ANTIGRAVITY_CSRF_TOKEN`, injected into sidecars and hooks by Antigravity):
 *      - `GetCascadeTrajectory` / `GetCascadeTrajectorySteps`: live in-flight step
 *        status (`GENERATING` / `PENDING` / `RUNNING`), `metadata.createdAt`, and
 *        `metadata.viewableAt` (stamped when the first streamed token arrives!).
 *      - `GetCascadeTrajectoryGeneratorMetadata` (`includeMessages: false`):
 *        exact `chatModel.timeToFirstToken` and `chatModel.streamingDuration`
 *        (`google.protobuf.Duration`) per model turn.
 *   2. Persistent cache in `<plugin_data>/telemetry/<convId>.json` so `/context`
 *      CLI commands inside sandboxed sessions also have full TTFT history.
 *   3. `PreInvocation` / `PostInvocation` / `Stop` hook timestamps in
 *      `<plugin_data>/sessions/<convId>.json` for instant prefill start detection.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ID_RE = /^[0-9a-f-]{8,}$/i;

// ---------------------------------------------------------------------------
// Protobuf JSON Duration & Timestamp parsers
// ---------------------------------------------------------------------------

/**
 * Parses a protojson `google.protobuf.Duration` (e.g. "1.423192s" or {seconds, nanos})
 * into milliseconds, or null if absent/invalid.
 */
export function parseProtoDurationMs(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'number') {
    return Number.isFinite(val) && val >= 0 ? Math.round(val) : null;
  }
  if (typeof val === 'string') {
    const s = val.trim();
    const m = s.match(/^(-?\d+(?:\.\d+)?)s$/);
    if (!m) return null;
    const secs = Number.parseFloat(m[1]);
    return Number.isFinite(secs) && secs >= 0 ? Math.round(secs * 1000) : null;
  }
  if (typeof val === 'object') {
    const secs = Number(val.seconds ?? 0);
    const nanos = Number(val.nanos ?? 0);
    if (!Number.isFinite(secs) || !Number.isFinite(nanos)) return null;
    const ms = Math.round(secs * 1000 + nanos / 1e6);
    return ms >= 0 ? ms : null;
  }
  return null;
}

/**
 * Parses a protojson `google.protobuf.Timestamp` (ISO-8601 with up to 9 fractional digits,
 * or {seconds, nanos}) into epoch milliseconds, or null if absent/invalid.
 */
export function parseProtoTimestampMs(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'number') {
    return Number.isFinite(val) && val > 0 ? Math.round(val) : null;
  }
  if (typeof val === 'string') {
    const s = val.trim();
    if (!s || s.startsWith('0001-01-01')) return null;
    // Normalize nanosecond ISO strings (e.g. ".690123456Z") to millisecond precision
    const normalized = s.replace(/(\.\d{3})\d*(Z|[+-]\d{2}:\d{2})$/, '$1$2');
    const ms = Date.parse(normalized);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  if (typeof val === 'object') {
    const secs = Number(val.seconds ?? 0);
    const nanos = Number(val.nanos ?? 0);
    if (!Number.isFinite(secs) || secs <= 0) return null;
    return Math.round(secs * 1000 + (Number.isFinite(nanos) ? nanos / 1e6 : 0));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Disk telemetry cache (<plugin_data>/telemetry/<convId>.json)
// ---------------------------------------------------------------------------

export function telemetryFilePath(appData, convId) {
  if (process.env.PLUGIN_DATA) {
    return join(process.env.PLUGIN_DATA, 'telemetry', `${convId}.json`);
  }
  const base = appData || join(homedir(), '.gemini', 'antigravity');
  return join(base, 'plugin_data', 'antigravity-context-plugin', 'telemetry', `${convId}.json`);
}

export function readCachedTelemetry(appData, convId) {
  if (!convId || !ID_RE.test(convId)) return null;
  const candidates = [];
  if (process.env.PLUGIN_DATA) {
    candidates.push(join(process.env.PLUGIN_DATA, 'telemetry', `${convId}.json`));
  }
  if (appData) {
    candidates.push(join(appData, 'plugin_data', 'antigravity-context-plugin', 'telemetry', `${convId}.json`));
  }
  candidates.push(join(homedir(), '.gemini', 'antigravity', 'plugin_data', 'antigravity-context-plugin', 'telemetry', `${convId}.json`));

  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const parsed = JSON.parse(readFileSync(p, 'utf-8'));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // ignore unreadable file
    }
  }
  return null;
}

export function writeCachedTelemetry(appData, convId, data) {
  if (!convId || !ID_RE.test(convId)) return;
  try {
    const target = telemetryFilePath(appData, convId);
    const dir = join(target, '..');
    mkdirSync(dir, { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, target);
  } catch {
    // Non-fatal if filesystem is read-only (e.g., inside restricted sandbox)
  }
}

// ---------------------------------------------------------------------------
// Language Server Connect-RPC helpers
// ---------------------------------------------------------------------------

async function callLsRpc(method, body, timeoutMs = 1200) {
  const addr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!addr || !csrf) return null;
  const baseUrl = addr.startsWith('http://') || addr.startsWith('https://') ? addr : `http://${addr}`;
  const url = `${baseUrl}/exa.language_server_pb.LanguageServerService/${method}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': csrf,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Extracts normalized per-invocation TTFT & streaming records from a list of
 * `CortexStepGeneratorMetadata` objects.
 */
export function normalizeGeneratorMetadataList(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const chat = item.chatModel || item.chat_model;
    if (!chat || typeof chat !== 'object') continue;
    const rawIndices = item.stepIndices || item.step_indices || [];
    const stepIndices = Array.isArray(rawIndices)
      ? rawIndices.map((n) => Number(n)).filter((n) => Number.isFinite(n))
      : [];
    const ttftMs = parseProtoDurationMs(chat.timeToFirstToken ?? chat.time_to_first_token);
    const streamingMs = parseProtoDurationMs(chat.streamingDuration ?? chat.streaming_duration);
    const startMeta = chat.chatStartMetadata || chat.chat_start_metadata || {};
    const ctxMeta = startMeta.contextWindowMetadata || startMeta.context_window_metadata || {};
    const createdAtMs = parseProtoTimestampMs(startMeta.createdAt ?? startMeta.created_at);
    const maxContextTokens = Number(ctxMeta.maxContextTokens ?? ctxMeta.max_context_tokens) || 0;
    const estimatedTokensUsed = Number(ctxMeta.estimatedTokensUsed ?? ctxMeta.estimated_tokens_used) || 0;
    const usage = chat.usage || {};
    const modelDisplayName = String(chat.modelDisplayName || chat.model_display_name || chat.responseModel || chat.response_model || '');

    out.push({
      stepIndices,
      primaryStepIndex: stepIndices.length ? stepIndices[stepIndices.length - 1] : null,
      ttftMs,
      streamingMs,
      createdAtMs,
      modelDisplayName,
      maxContextTokens,
      estimatedTokensUsed,
      inputTokens: Number(usage.inputTokens ?? usage.input_tokens) || 0,
      outputTokens: Number(usage.outputTokens ?? usage.output_tokens) || 0,
      cacheReadTokens: Number(usage.cacheReadTokens ?? usage.cache_read_tokens) || 0,
      thinkingOutputTokens: Number(usage.thinkingOutputTokens ?? usage.thinking_output_tokens) || 0,
      retries: Number(chat.retries) || 0,
    });
  }
  return out;
}

const ACTIVE_STEP_STATUS_RE = /GENERATING|PENDING|RUNNING|QUEUED|WAITING|IN_PROGRESS/i;
const TERMINAL_STEP_STATUS_RE = /DONE|COMPLETE|ERROR|FAILED|CANCELED|CANCELLED/i;

function isPlannerStep(step) {
  if (!step || typeof step !== 'object') return false;
  const t = String(step.type ?? '');
  return t === '15' || /PLANNER_RESPONSE/i.test(t) || Boolean(step.plannerResponse || step.planner_response);
}

/**
 * Inspects tail steps + run status to detect live in-flight prefill or streaming TTFT.
 */
export function extractLiveStepState(steps, runStatus = '', nowMs = Date.now()) {
  const cascadeRunning = /RUNNING|GENERATING|ACTIVE/i.test(String(runStatus || ''));
  if (!Array.isArray(steps) || !steps.length) {
    return { active: false, cascadeRunning };
  }

  for (let i = steps.length - 1; i >= 0; i--) {
    const st = steps[i];
    if (!st || typeof st !== 'object') continue;
    const statusStr = String(st.status ?? '');
    const isTerminal = TERMINAL_STEP_STATUS_RE.test(statusStr);
    const isActive = !isTerminal && (ACTIVE_STEP_STATUS_RE.test(statusStr) || cascadeRunning);
    if (!isPlannerStep(st)) {
      // If a newer tool step is already running, the previous planner step is done
      if (isActive) return { active: false, cascadeRunning, activeToolStep: true };
      continue;
    }

    const meta = st.metadata || {};
    const createdAtMs = parseProtoTimestampMs(meta.createdAt ?? meta.created_at ?? meta.startedAt ?? meta.started_at);
    const viewableAtMs = parseProtoTimestampMs(meta.viewableAt ?? meta.viewable_at);
    const finishedAtMs = parseProtoTimestampMs(
      meta.finishedGeneratingAt ?? meta.finished_generating_at ?? meta.completedAt ?? meta.completed_at
    );

    if (isActive && !finishedAtMs) {
      if (viewableAtMs && createdAtMs && viewableAtMs >= createdAtMs) {
        return {
          active: true,
          phase: 'streaming',
          startedAtMs: createdAtMs,
          firstTokenAtMs: viewableAtMs,
          ttftMs: Math.max(0, viewableAtMs - createdAtMs),
          streamingElapsedMs: Math.max(0, nowMs - viewableAtMs),
          source: 'ls_live_step',
        };
      }
      const start = createdAtMs || nowMs;
      return {
        active: true,
        phase: 'waiting_first_token',
        startedAtMs: start,
        firstTokenAtMs: null,
        ttftMs: null,
        elapsedMs: Math.max(0, nowMs - start),
        source: 'ls_live_step',
      };
    }

    // Newest planner step is already finished; return its metadata fallback TTFT if viewableAt > createdAt
    if (viewableAtMs && createdAtMs && viewableAtMs > createdAtMs) {
      return {
        active: false,
        cascadeRunning,
        lastStepTtftMs: viewableAtMs - createdAtMs,
        lastStepStreamingMs: finishedAtMs && finishedAtMs >= viewableAtMs ? finishedAtMs - viewableAtMs : null,
      };
    }
    break;
  }

  return { active: false, cascadeRunning };
}

// ---------------------------------------------------------------------------
// Incremental in-memory + disk cache per conversation
// ---------------------------------------------------------------------------

const memState = new Map(); // convId -> { offset, records: [], updatedAtMs }

export async function collectLiveTelemetry(convId, appData = '') {
  if (!convId || !ID_RE.test(convId)) return null;

  const hasLs = Boolean(process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN);
  if (!hasLs) {
    return readCachedTelemetry(appData, convId);
  }

  let entry = memState.get(convId);
  if (!entry) {
    const disk = readCachedTelemetry(appData, convId);
    entry = {
      offset: Number(disk?.offset) || 0,
      records: Array.isArray(disk?.records) ? disk.records : [],
      updatedAtMs: 0,
    };
    memState.set(convId, entry);
  }

  // 1. Query lightweight trajectory status & counts
  const trajRes = await callLsRpc('GetCascadeTrajectory', {
    cascadeId: convId,
    disableRehydration: false,
  }, 1200);

  let runStatus = '';
  let totalSteps = 0;
  let totalGenMeta = 0;
  let tailSteps = [];

  if (trajRes && typeof trajRes === 'object') {
    runStatus = String(trajRes.status ?? '');
    const inlineSteps = trajRes.trajectory?.steps;
    totalSteps = Number(trajRes.numTotalSteps ?? trajRes.num_total_steps) || (Array.isArray(inlineSteps) ? inlineSteps.length : 0);
    totalGenMeta = Number(trajRes.numTotalGeneratorMetadata ?? trajRes.num_total_generator_metadata) || 0;

    if (Array.isArray(inlineSteps) && inlineSteps.length > 0) {
      tailSteps = inlineSteps.slice(-4);
    } else if (totalSteps > 0) {
      const stepOffset = Math.max(0, totalSteps - 4);
      const stepsRes = await callLsRpc('GetCascadeTrajectorySteps', {
        cascadeId: convId,
        stepOffset,
      }, 1000);
      if (Array.isArray(stepsRes?.steps)) {
        tailSteps = stepsRes.steps;
      }
    }
  }

  // 2. Incrementally fetch new GeneratorMetadata (includeMessages: false keeps payload < 2 KB/turn!)
  if (totalGenMeta < entry.offset) {
    // Conversation was rewound or restarted with fewer in-memory items; resync from 0
    entry.offset = 0;
    entry.records = [];
  }

  if (totalGenMeta > entry.offset || (trajRes && entry.offset === 0 && entry.records.length === 0)) {
    const genRes = await callLsRpc('GetCascadeTrajectoryGeneratorMetadata', {
      cascadeId: convId,
      generatorMetadataOffset: entry.offset,
      includeMessages: false,
    }, 1500);
    const rawItems = genRes?.generatorMetadata || genRes?.generator_metadata;
    if (Array.isArray(rawItems) && rawItems.length > 0) {
      const normalized = normalizeGeneratorMetadataList(rawItems);
      entry.records.push(...normalized);
      entry.offset += rawItems.length;
      writeCachedTelemetry(appData, convId, {
        conversationId: convId,
        offset: entry.offset,
        updatedAt: new Date().toISOString(),
        records: entry.records,
      });
    }
  }

  const liveStep = extractLiveStepState(tailSteps, runStatus, Date.now());
  entry.updatedAtMs = Date.now();

  return {
    conversationId: convId,
    offset: entry.offset,
    records: entry.records,
    liveStep,
    runStatus,
    lsConnected: Boolean(trajRes),
  };
}

/**
 * Compute summary statistics (latest, P50, P95, min, max) over positive TTFT values.
 */
export function summarizeTtftStats(ttftValuesMs) {
  const vals = (Array.isArray(ttftValuesMs) ? ttftValuesMs : [])
    .filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  if (!vals.length) {
    return {
      count: 0,
      latestMs: null,
      p50Ms: null,
      p95Ms: null,
      minMs: null,
      maxMs: null,
      avgMs: null,
    };
  }
  const latestMs = vals[vals.length - 1];
  const sorted = [...vals].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  const sum = vals.reduce((a, b) => a + b, 0);
  return {
    count: vals.length,
    latestMs,
    p50Ms: pick(0.5),
    p95Ms: pick(0.95),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    avgMs: Math.round(sum / vals.length),
  };
}
