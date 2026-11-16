#!/usr/bin/env node
/**
 * Lightweight, non-blocking lifecycle hook for antigravity-context-plugin.
 *
 * Captures per-conversation runtime metadata (active modelName, workspacePaths,
 * in-flight invocation start timestamps) and snapshots Language Server TTFT
 * generator telemetry into PLUGIN_DATA without injecting anything into prompts.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { collectLiveTelemetry } from '../sidecars/context_panel/ls_telemetry.mjs';

const ID_RE = /^[0-9a-f-]{8,}$/i;
const isStopArg = process.argv.includes('--stop');

function resolveAppData(payload) {
  const candidates = [payload?.transcriptPath, payload?.artifactDirectoryPath].filter(
    (p) => typeof p === 'string' && p.includes('/brain/')
  );
  for (const p of candidates) {
    const idx = p.indexOf('/brain/');
    if (idx > 0) return p.slice(0, idx);
  }
  return join(homedir(), '.gemini', 'antigravity');
}

function resolveSessionsDir(appData) {
  if (process.env.PLUGIN_DATA) {
    return join(process.env.PLUGIN_DATA, 'sessions');
  }
  return join(appData, 'plugin_data', 'antigravity-context-plugin', 'sessions');
}

function safeMtime(p) {
  try {
    return p && existsSync(p) ? statSync(p).mtimeMs : 0;
  } catch {
    return 0;
  }
}

function readExistingRecord(target) {
  try {
    if (!existsSync(target)) return {};
    const parsed = JSON.parse(readFileSync(target, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function main() {
  let isStop = isStopArg;
  try {
    let raw = '';
    process.stdin.setEncoding('utf-8');
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 256 * 1024) break;
    }
    const payload = raw.trim() ? JSON.parse(raw) : {};
    const eventName = typeof payload?.hookEventName === 'string' ? payload.hookEventName : '';
    if (eventName === 'Stop') isStop = true;

    const conv = typeof payload?.conversationId === 'string' ? payload.conversationId.trim() : '';
    if (conv && ID_RE.test(conv)) {
      const appData = resolveAppData(payload);
      const dir = resolveSessionsDir(appData);
      mkdirSync(dir, { recursive: true });
      const target = join(dir, `${conv}.json`);
      const prev = readExistingRecord(target);
      const nowIso = new Date().toISOString();
      const trPath = typeof payload.transcriptPath === 'string' && payload.transcriptPath
        ? payload.transcriptPath
        : (prev.transcriptPath || '');

      const inFlight = eventName === 'PreInvocation';
      const record = {
        ...prev,
        conversationId: conv,
        workspacePaths: Array.isArray(payload.workspacePaths) && payload.workspacePaths.length
          ? payload.workspacePaths.filter((x) => typeof x === 'string' && x)
          : (prev.workspacePaths || []),
        transcriptPath: trPath,
        artifactDirectoryPath: typeof payload.artifactDirectoryPath === 'string' && payload.artifactDirectoryPath
          ? payload.artifactDirectoryPath
          : (prev.artifactDirectoryPath || ''),
        modelName: typeof payload.modelName === 'string' && payload.modelName
          ? payload.modelName
          : (prev.modelName || ''),
        cwd: typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : (prev.cwd || ''),
        invocationNum: Number.isFinite(payload.invocationNum) ? payload.invocationNum : (prev.invocationNum ?? null),
        hookEventName: eventName || prev.hookEventName || '',
        inFlight,
        invocationStartedAt: inFlight ? nowIso : (prev.invocationStartedAt || ''),
        preInvocationTranscriptMtime: inFlight ? safeMtime(trPath) : (prev.preInvocationTranscriptMtime || 0),
        lastCompletedAt: !inFlight && (eventName === 'PostInvocation' || eventName === 'Stop')
          ? nowIso
          : (prev.lastCompletedAt || ''),
        updatedAt: nowIso,
      };

      const tmp = `${target}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
      renameSync(tmp, target);

      // Snapshot generator TTFT metadata into PLUGIN_DATA on completion events
      if (eventName === 'PostInvocation' || eventName === 'Stop') {
        await collectLiveTelemetry(conv, appData);
      }
    }
  } catch {
    // Never block or fail an agent turn.
  }

  process.stdout.write(isStop ? '{"decision":"allow"}\n' : '{}\n');
}

main();
