import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  analyzeConversation,
  estimateTokens,
  formatCliContext,
  inferContextLimit,
  listConversations,
  parseJsonc,
  toFileUriIfExists,
  uriToPath,
} from '../sidecars/context_panel/analyzer.mjs';
import {
  extractLiveStepState,
  normalizeGeneratorMetadataList,
  parseProtoDurationMs,
  parseProtoTimestampMs,
  summarizeTtftStats,
} from '../sidecars/context_panel/ls_telemetry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

function makeTempEnv() {
  const root = mkdtempSync(join(tmpdir(), 'agy-ctx-test-'));
  const appData = join(root, 'antigravity');
  const workspace = join(root, 'workspace');
  mkdirSync(join(appData, 'brain'), { recursive: true });
  mkdirSync(join(appData, 'builtin', 'skills', 'demo-skill'), { recursive: true });
  mkdirSync(join(workspace, '.agents', 'rules'), { recursive: true });
  mkdirSync(join(workspace, 'src'), { recursive: true });

  writeFileSync(
    join(appData, 'builtin', 'skills', 'demo-skill', 'SKILL.md'),
    `---\nname: demo-skill\ndescription: Demo skill for testing context breakdown.\n---\n# Demo Skill\nDetailed instructions here.\n`
  );
  writeFileSync(join(workspace, '.agents', 'rules', 'style.md'), '# Style Rule\nAlways write clean tests.\n');
  writeFileSync(join(workspace, 'src', 'index.js'), 'export const answer = 42;\n');

  return { root, appData, workspace, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('parseJsonc strips single-line, multi-line comments and trailing commas', () => {
  const raw = `{
    // comment with https://url.example/path
    "name": "test // keep inside string",
    /* multi
       line */
    "items": [1, 2, 3,],
  }`;
  const parsed = parseJsonc(raw);
  assert.deepEqual(parsed, {
    name: 'test // keep inside string',
    items: [1, 2, 3],
  });
});

test('inferContextLimit detects model families and honors explicit overrides', () => {
  assert.equal(inferContextLimit('Gemini 4 Carbon (High)'), 1_048_576);
  assert.equal(inferContextLimit('gemini-1.5-pro'), 2_097_152);
  assert.equal(inferContextLimit('Gemini 4 Carbon (High)', 200_000), 200_000);
});

test('analyzeConversation reconciles token totals exactly with Gemini API telemetry', () => {
  const env = makeTempEnv();
  try {
    const conv = '11111111-2222-3333-4444-555555555555';
    const convDir = join(env.appData, 'brain', conv);
    const logsDir = join(convDir, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(convDir, 'plan.md'), '# Implementation Plan\nStep 1: Build.\n');

    const skillPath = join(env.appData, 'builtin', 'skills', 'demo-skill', 'SKILL.md');
    const srcPath = join(env.workspace, 'src', 'index.js');

    const transcript = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-16T20:00:00Z',
        content: '<USER_REQUEST>\nInspect index.js\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 4 Carbon (High).\n</USER_SETTINGS_CHANGE>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-16T20:00:02Z',
        input_tokens: 12000,
        cache_read_tokens: 0,
        output_tokens: 400,
        thinking: 'Reading skill and source file.',
        tool_calls: [
          { name: 'read_file', args: { Path: skillPath } },
          { name: 'read_file', args: { Path: srcPath } },
        ],
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-16T20:00:03Z',
        content: 'Skill file content output...',
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-16T20:00:03Z',
        content: 'export const answer = 42;',
      },
      {
        step_index: 4,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-16T20:00:05Z',
        input_tokens: 1200,
        cache_read_tokens: 12000,
        output_tokens: 250,
        thinking: 'Done inspecting.',
        content: 'The answer in src/index.js is 42.',
        tool_calls: [],
      },
    ];

    writeFileSync(
      join(logsDir, 'transcript_full.jsonl'),
      transcript.map((x) => JSON.stringify(x)).join('\n') + '\n'
    );

    const report = analyzeConversation({
      conversationId: conv,
      appDataDirs: [env.appData],
      workspacePaths: [env.workspace],
    });

    assert.equal(report.found, true);
    assert.equal(report.model.name, 'Gemini 4 Carbon (High)');
    assert.equal(report.model.contextLimit, 1_048_576);

    // Latest turn input = 1200 + 12000 = 13200, plus final output 250 = 13450 exact active tokens
    assert.equal(report.summary.totalActiveTokens, 13450);
    const breakdownSum = report.breakdown.reduce((acc, r) => acc + r.tokens, 0);
    assert.equal(breakdownSum, 13450);
    assert.equal(report.summary.totalActiveTokens + report.freeSpace.tokens, 1_048_576);

    // 20x10 = 200 cells
    assert.equal(report.grid.cells.length, 200);

    // Tracked files classification & clickable file:// URIs
    assert.equal(report.trackedFiles.artifacts.length, 1);
    assert.equal(report.trackedFiles.artifacts[0].name, 'plan.md');
    assert.match(report.trackedFiles.artifacts[0].uri, /^file:\/\//);
    assert.equal(report.trackedFiles.skills.length, 1);
    assert.equal(report.trackedFiles.skills[0].name, 'demo-skill/SKILL.md');
    assert.match(report.trackedFiles.skills[0].uri, /^file:\/\//);
    assert.equal(report.trackedFiles.workspace.length, 1);
    assert.equal(report.trackedFiles.workspace[0].name, 'src/index.js');
    assert.match(report.trackedFiles.workspace[0].uri, /^file:\/\//);

    // CLI text output sanity check
    const cli = formatCliContext(report);
    assert.match(cli, /Context Usage · Gemini 4 Carbon \(High\)/);
    assert.match(cli, /◉ User messages/);
    assert.match(cli, /⛁ System prompt/);
    assert.match(cli, /□ Free space/);
    assert.match(cli, /⊠ Checkpoint buffer/);
    assert.match(cli, /demo-skill\/SKILL\.md/);
    assert.match(cli, /src\/index\.js/);

    const list = listConversations({ appDataDirs: [env.appData] });
    assert.equal(list.length, 1);
    assert.equal(list[0].conversationId, conv);
  } finally {
    env.cleanup();
  }
});

test('analyzeConversation detects <CONTEXT_SUMMARY> compaction checkpoints and isolates historical tokens', () => {
  const env = makeTempEnv();
  try {
    const conv = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const logsDir = join(env.appData, 'brain', conv, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });

    const transcript = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        content: 'Initial big task',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        input_tokens: 95000,
        cache_read_tokens: 0,
        output_tokens: 2000,
        content: 'Completed phase 1.',
        tool_calls: [],
      },
      {
        step_index: 2,
        source: 'SYSTEM',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-16T20:10:00Z',
        content: '<CONTEXT_SUMMARY>\nSummary of phase 1 work.\n</CONTEXT_SUMMARY>',
      },
      {
        step_index: 3,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        content: 'Start phase 2',
      },
      {
        step_index: 4,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        input_tokens: 15000,
        cache_read_tokens: 0,
        output_tokens: 500,
        content: 'Starting phase 2.',
        tool_calls: [],
      },
    ];

    writeFileSync(
      join(logsDir, 'transcript_full.jsonl'),
      transcript.map((x) => JSON.stringify(x)).join('\n') + '\n'
    );

    const report = analyzeConversation({
      conversationId: conv,
      appDataDirs: [env.appData],
      workspacePaths: [env.workspace],
    });

    assert.equal(report.checkpoints.count, 1);
    assert.equal(report.checkpoints.compactedStepCount, 2);
    assert.equal(report.checkpoints.historicalCompactedTokens, 97000);
    // Active tokens reflect post-compaction window (15000 + 500 = 15500), NOT bloated by 97000!
    assert.equal(report.summary.totalActiveTokens, 15500);
    assert.ok(report.checkpoints.row.tokens > 0);
  } finally {
    env.cleanup();
  }
});

test('record_session.mjs hook writes session metadata to PLUGIN_DATA and prints {}', () => {
  const pluginData = mkdtempSync(join(tmpdir(), 'agy-hook-test-'));
  try {
    const conv = 'deadbeef-1234-5678-9abc-def012345678';
    const payload = JSON.stringify({
      conversationId: conv,
      workspacePaths: ['/tmp/example-ws'],
      modelName: 'Gemini 4 Pro',
      hookEventName: 'PreInvocation',
      invocationNum: 2,
    });
    const out = execFileSync('node', [join(REPO_ROOT, 'hooks', 'record_session.mjs')], {
      input: payload,
      env: { ...process.env, PLUGIN_DATA: pluginData },
      encoding: 'utf-8',
    });
    assert.equal(out.trim(), '{}');
    const saved = parseJsonc(
      readFileSync(join(pluginData, 'sessions', `${conv}.json`), 'utf-8')
    );
    assert.equal(saved.conversationId, conv);
    assert.equal(saved.modelName, 'Gemini 4 Pro');
    assert.deepEqual(saved.workspacePaths, ['/tmp/example-ws']);
  } finally {
    rmSync(pluginData, { recursive: true, force: true });
  }
});

test('Windows & cross-platform file URIs, drive-letter casing, and hooks.json shell execution work end-to-end', () => {
  const env = makeTempEnv();
  const tempRoot = mkdtempSync(join(tmpdir(), 'agy-win-test-'));
  try {
    const srcFile = join(env.workspace, 'src', 'index.js');
    const fileUri = toFileUriIfExists(srcFile);
    assert.ok(fileUri.startsWith('file:///'), `Expected file:/// URI, got: ${fileUri}`);
    assert.equal(uriToPath(fileUri), uriToPath(srcFile));

    if (process.platform === 'win32') {
      // VS Code / Electron %3A-encoded drive colon & lowercase drive letter matching
      const encodedUri = fileUri.replace(/^file:\/\/\/([A-Za-z]):/, (_, d) => `file:///${d.toLowerCase()}%3A`);
      assert.equal(uriToPath(encodedUri), uriToPath(srcFile));

      const lowerWs = env.workspace.replace(/^[A-Z]:/, (d) => d.toLowerCase());
      const upperSrc = srcFile.replace(/^[a-z]:/, (d) => d.toUpperCase());
      const conv = '22222222-3333-4444-5555-666666666666';
      const logsDir = join(env.appData, 'brain', conv, '.system_generated', 'logs');
      mkdirSync(logsDir, { recursive: true });
      writeFileSync(
        join(logsDir, 'transcript_full.jsonl'),
        [
          JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'hi' }),
          JSON.stringify({
            step_index: 1,
            source: 'MODEL',
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            input_tokens: 5000,
            output_tokens: 100,
            tool_calls: [{ name: 'read_file', args: { Path: upperSrc } }],
          }),
          JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'code' }),
        ].join('\n') + '\n'
      );
      const report = analyzeConversation({
        conversationId: conv,
        appDataDirs: [env.appData],
        workspacePaths: [lowerWs],
      });
      assert.equal(report.trackedFiles.workspace.length, 1);
      assert.equal(report.trackedFiles.workspace[0].name, 'src/index.js');
    }

    // Verify record_session.mjs resolves appData from native OS brain path when PLUGIN_DATA is unset
    const convHook = 'fedcba98-7654-3210-fedc-ba9876543210';
    const fakeBrainArtifactDir = join(tempRoot, 'custom_appdata', 'brain', convHook);
    const cleanEnv = { ...process.env };
    delete cleanEnv.PLUGIN_DATA;
    const hookOut = execFileSync('node', [join(REPO_ROOT, 'hooks', 'record_session.mjs')], {
      input: JSON.stringify({
        conversationId: convHook,
        artifactDirectoryPath: fakeBrainArtifactDir,
        hookEventName: 'SessionStart',
      }),
      env: cleanEnv,
      encoding: 'utf-8',
    });
    assert.equal(hookOut.trim(), '{}');
    const derivedSessionFile = join(
      tempRoot,
      'custom_appdata',
      'plugin_data',
      'antigravity-context-plugin',
      'sessions',
      `${convHook}.json`
    );
    const derivedSaved = JSON.parse(readFileSync(derivedSessionFile, 'utf-8'));
    assert.equal(derivedSaved.conversationId, convHook);

    // Also verify forward-slash (/brain/) transcriptPath works identically (Linux/macOS style)
    const convPosixHook = 'abcdef01-2345-6789-abcd-ef0123456789';
    const forwardSlashBrain = join(tempRoot, 'posix_appdata', 'brain', convPosixHook, 'transcript.jsonl').replace(/\\/g, '/');
    execFileSync('node', [join(REPO_ROOT, 'hooks', 'record_session.mjs')], {
      input: JSON.stringify({
        conversationId: convPosixHook,
        transcriptPath: forwardSlashBrain,
        hookEventName: 'SessionStart',
      }),
      env: cleanEnv,
      encoding: 'utf-8',
    });
    const posixSessionFile = join(
      tempRoot,
      'posix_appdata',
      'plugin_data',
      'antigravity-context-plugin',
      'sessions',
      `${convPosixHook}.json`
    );
    assert.equal(JSON.parse(readFileSync(posixSessionFile, 'utf-8')).conversationId, convPosixHook);

    // Verify hooks.json commands execute cleanly in the host shell (cmd /c on Windows, sh -c on Unix)
    const hooksCfg = JSON.parse(readFileSync(join(REPO_ROOT, 'hooks.json'), 'utf-8'));
    const tracker = hooksCfg['context-session-tracker'];
    const shellExe = process.platform === 'win32' ? 'cmd.exe' : 'sh';
    const shellFlag = process.platform === 'win32' ? '/c' : '-c';
    const hookDataDir = join(tempRoot, 'hook_plugin_data');

    const preCmd = tracker.PreInvocation[0].command;
    const preStdout = execFileSync(shellExe, [shellFlag, preCmd], {
      cwd: REPO_ROOT,
      input: JSON.stringify({ conversationId: convHook, hookEventName: 'PreInvocation' }),
      env: { ...process.env, PLUGIN_DATA: hookDataDir },
      encoding: 'utf-8',
    });
    assert.deepEqual(JSON.parse(preStdout.trim()), {});

    const stopCmd = tracker.Stop[0].command;
    const stopStdout = execFileSync(shellExe, [shellFlag, stopCmd], {
      cwd: REPO_ROOT,
      input: JSON.stringify({ conversationId: convHook, hookEventName: 'Stop' }),
      env: { ...process.env, PLUGIN_DATA: hookDataDir },
      encoding: 'utf-8',
    });
    assert.deepEqual(JSON.parse(stopStdout.trim()), { decision: 'allow' });
  } finally {
    env.cleanup();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('estimateTokens scales reasonably for empty, prose, and JSON inputs', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('Hello world from Antigravity context plugin.') > 5);
  assert.ok(estimateTokens(JSON.stringify({ a: [1, 2, 3], b: { c: 'test' } })) > 5);
});

test('GENERIC tool outputs mentioning <CONTEXT_SUMMARY> do not trigger false compaction checkpoints', () => {
  const env = makeTempEnv();
  try {
    const conv = '99999999-8888-7777-6666-555555555555';
    const logsDir = join(env.appData, 'brain', conv, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });

    const transcript = [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Run tests' },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        input_tokens: 14000,
        cache_read_tokens: 0,
        output_tokens: 300,
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'node --test' } }],
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        content: '✔ detects <CONTEXT_SUMMARY> compaction checkpoints\n<CONTEXT_SUMMARY>\ntest fixture\n</CONTEXT_SUMMARY>',
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        input_tokens: 1000,
        cache_read_tokens: 14000,
        output_tokens: 200,
        content: 'All tests passed.',
        tool_calls: [],
      },
    ];

    writeFileSync(
      join(logsDir, 'transcript_full.jsonl'),
      transcript.map((x) => JSON.stringify(x)).join('\n') + '\n'
    );

    const report = analyzeConversation({
      conversationId: conv,
      appDataDirs: [env.appData],
      workspacePaths: [env.workspace],
    });

    assert.equal(report.checkpoints.count, 0);
    assert.equal(report.summary.totalActiveTokens, 15200);
  } finally {
    env.cleanup();
  }
});

test('parseProtoDurationMs and parseProtoTimestampMs parse protojson formats accurately', () => {
  assert.equal(parseProtoDurationMs('1.423192s'), 1423);
  assert.equal(parseProtoDurationMs('0.085s'), 85);
  assert.equal(parseProtoDurationMs({ seconds: '2', nanos: 350_000_000 }), 2350);
  assert.equal(parseProtoDurationMs(null), null);

  const ts = parseProtoTimestampMs('2026-11-16T21:14:26.690123456Z');
  assert.equal(ts, Date.parse('2026-11-16T21:14:26.690Z'));
  assert.equal(parseProtoTimestampMs('0001-01-01T00:00:00Z'), null);
});

test('live TTFT tracks prefill, streaming first-token lock-in, and completed P50/P95 stats', () => {
  const env = makeTempEnv();
  try {
    const conv = '77777777-6666-5555-4444-333333333333';
    const logsDir = join(env.appData, 'brain', conv, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });

    const transcript = [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Turn 1' },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        input_tokens: 15000,
        cache_read_tokens: 0,
        output_tokens: 800,
        content: 'First reply.',
        tool_calls: [],
      },
      { step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Turn 2' },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        input_tokens: 2000,
        cache_read_tokens: 15000,
        output_tokens: 500,
        content: 'Second reply.',
        tool_calls: [],
      },
    ];
    writeFileSync(
      join(logsDir, 'transcript_full.jsonl'),
      transcript.map((x) => JSON.stringify(x)).join('\n') + '\n'
    );

    const records = normalizeGeneratorMetadataList([
      {
        stepIndices: [1],
        chatModel: {
          timeToFirstToken: '1.250s',
          streamingDuration: '8.000s',
          modelDisplayName: 'Gemini 4 Carbon (High)',
        },
      },
      {
        stepIndices: [3],
        chatModel: {
          timeToFirstToken: '2.400s',
          streamingDuration: '5.000s',
          modelDisplayName: 'Gemini 4 Carbon (High)',
        },
      },
    ]);

    // 1. Completed idle state with P50/P95 and tok/s
    const idleReport = analyzeConversation({
      conversationId: conv,
      appDataDirs: [env.appData],
      workspacePaths: [env.workspace],
      liveTelemetry: { records, liveStep: { active: false }, lsConnected: true },
      nowMs: 1_700_000_010_000,
    });
    assert.equal(idleReport.ttft.live.phase, 'idle');
    assert.equal(idleReport.ttft.stats.count, 2);
    assert.equal(idleReport.ttft.stats.latestMs, 2400);
    assert.equal(idleReport.ttft.stats.p50Ms, 1250);
    assert.equal(idleReport.ttft.stats.p95Ms, 2400);
    assert.equal(idleReport.ttft.latestOutputTokPerSec, 100); // 500 tok / 5.0s = 100 tok/s
    assert.match(formatCliContext(idleReport), /⏱ TTFT latest: 2\.40s · P50: 1\.25s · P95: 2\.40s/);

    // 2. Live prefill (waiting_first_token)
    const startIso = '2026-11-16T22:30:00.000Z';
    const startMs = Date.parse(startIso);
    const livePrefillStep = extractLiveStepState(
      [
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          status: 'CORTEX_STEP_STATUS_GENERATING',
          metadata: { createdAt: startIso },
        },
      ],
      'CASCADE_RUN_STATUS_RUNNING',
      startMs + 1850
    );
    assert.equal(livePrefillStep.phase, 'waiting_first_token');
    assert.equal(livePrefillStep.elapsedMs, 1850);

    // 3. First token arrives (viewableAt set while still streaming!)
    const firstTokIso = '2026-11-16T22:30:01.620Z';
    const liveStreamingStep = extractLiveStepState(
      [
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          status: 'CORTEX_STEP_STATUS_GENERATING',
          metadata: { createdAt: startIso, viewableAt: firstTokIso },
        },
      ],
      'CASCADE_RUN_STATUS_RUNNING',
      startMs + 4000
    );
    assert.equal(liveStreamingStep.phase, 'streaming');
    assert.equal(liveStreamingStep.ttftMs, 1620);
    assert.equal(liveStreamingStep.streamingElapsedMs, 2380);

    const streamingReport = analyzeConversation({
      conversationId: conv,
      appDataDirs: [env.appData],
      workspacePaths: [env.workspace],
      liveTelemetry: { records, liveStep: liveStreamingStep, lsConnected: true },
      nowMs: startMs + 4000,
    });
    assert.equal(streamingReport.ttft.live.phase, 'streaming');
    assert.equal(streamingReport.ttft.live.ttftMs, 1620);
    assert.match(formatCliContext(streamingReport), /⏱ Live TTFT: 1\.62s · Streaming response/);

    // 4. Stop hook contract outputs {"decision":"allow"}
    const pluginData = mkdtempSync(join(tmpdir(), 'agy-stop-hook-'));
    try {
      const stopOut = execFileSync('node', [join(REPO_ROOT, 'hooks', 'record_session.mjs'), '--stop'], {
        input: JSON.stringify({ conversationId: conv, hookEventName: 'Stop' }),
        env: { ...process.env, PLUGIN_DATA: pluginData },
        encoding: 'utf-8',
      });
      assert.deepEqual(JSON.parse(stopOut), { decision: 'allow' });
    } finally {
      rmSync(pluginData, { recursive: true, force: true });
    }

    assert.equal(summarizeTtftStats([]).count, 0);
  } finally {
    env.cleanup();
  }
});
