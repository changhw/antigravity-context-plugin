#!/usr/bin/env node
/**
 * Lightweight, non-blocking lifecycle hook for antigravity-context-plugin.
 *
 * Captures per-conversation runtime metadata (active modelName, workspacePaths,
 * transcriptPath, artifactDirectoryPath, cwd) into PLUGIN_DATA so the Context
 * sidecar panel and /context skill always know the exact active model and
 * workspaces without injecting anything into the prompt.
 *
 * Always writes `{}` to stdout and exits 0.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const ID_RE = /^[0-9a-f-]{8,}$/i;

function resolveSessionsDir(payload) {
  if (process.env.PLUGIN_DATA) {
    return join(process.env.PLUGIN_DATA, 'sessions');
  }
  // Derive <appData> from transcriptPath or artifactDirectoryPath when present:
  // <appData>/brain/<conv>/.system_generated/logs/transcript.jsonl
  const candidates = [payload?.transcriptPath, payload?.artifactDirectoryPath].filter(
    (p) => typeof p === 'string' && p.includes('/brain/')
  );
  for (const p of candidates) {
    const idx = p.indexOf('/brain/');
    if (idx > 0) {
      const appData = p.slice(0, idx);
      return join(appData, 'plugin_data', 'antigravity-context-plugin', 'sessions');
    }
  }
  return join(homedir(), '.gemini', 'antigravity', 'plugin_data', 'antigravity-context-plugin', 'sessions');
}

async function main() {
  let raw = '';
  try {
    process.stdin.setEncoding('utf-8');
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 256 * 1024) break;
    }
    const payload = raw.trim() ? JSON.parse(raw) : {};
    const conv = typeof payload?.conversationId === 'string' ? payload.conversationId.trim() : '';
    if (conv && ID_RE.test(conv)) {
      const dir = resolveSessionsDir(payload);
      mkdirSync(dir, { recursive: true });
      const record = {
        conversationId: conv,
        workspacePaths: Array.isArray(payload.workspacePaths)
          ? payload.workspacePaths.filter((x) => typeof x === 'string' && x)
          : [],
        transcriptPath: typeof payload.transcriptPath === 'string' ? payload.transcriptPath : '',
        artifactDirectoryPath: typeof payload.artifactDirectoryPath === 'string' ? payload.artifactDirectoryPath : '',
        modelName: typeof payload.modelName === 'string' ? payload.modelName : '',
        cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
        invocationNum: Number.isFinite(payload.invocationNum) ? payload.invocationNum : null,
        hookEventName: typeof payload.hookEventName === 'string' ? payload.hookEventName : '',
        updatedAt: new Date().toISOString(),
      };
      const target = join(dir, `${conv}.json`);
      const tmp = `${target}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
      renameSync(tmp, target);
    }
  } catch {
    // Never block or fail an agent turn.
  }
  process.stdout.write('{}\n');
}

main();
