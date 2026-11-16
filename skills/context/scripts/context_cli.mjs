#!/usr/bin/env node
/**
 * CLI reporter for the `/context` skill in Antigravity Desktop.
 *
 * Usage:
 *   node context_cli.mjs [--conversation <id>] [--workspace <path>] [--limit <tokens>] [--json]
 */
import { resolve } from 'node:path';
import { analyzeConversation, findAppDataDirs, formatCliContext, listConversations } from '../../../sidecars/context_panel/analyzer.mjs';

function parseArgs(argv) {
  const out = {
    conversationId: process.env.ANTIGRAVITY_CONVERSATION_ID || '',
    workspacePaths: [],
    limit: 0,
    json: false,
    list: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      out.json = true;
    } else if (a === '--list') {
      out.list = true;
    } else if ((a === '--conversation' || a === '-c') && argv[i + 1]) {
      out.conversationId = argv[++i];
    } else if ((a === '--workspace' || a === '-w') && argv[i + 1]) {
      out.workspacePaths.push(resolve(argv[++i]));
    } else if ((a === '--limit' || a === '-l') && argv[i + 1]) {
      out.limit = Number(argv[++i]) || 0;
    }
  }
  if (!out.workspacePaths.length && process.cwd()) {
    out.workspacePaths.push(resolve(process.cwd()));
  }
  return out;
}

const args = parseArgs(process.argv);
const appDataDirs = findAppDataDirs();

if (args.list) {
  const convs = listConversations({ appDataDirs });
  if (args.json) {
    process.stdout.write(JSON.stringify(convs, null, 2) + '\n');
  } else {
    for (const c of convs) {
      process.stdout.write(
        `${c.conversationId}  steps=${String(c.steps).padStart(4)}  tokens=${String(c.latestTokens).padStart(8)}  model=${c.modelName}\n`
      );
    }
  }
  process.exit(0);
}

const report = analyzeConversation({
  conversationId: args.conversationId,
  appDataDirs,
  workspacePaths: args.workspacePaths,
  contextLimitOverride: args.limit,
});

if (args.json) {
  const { grid, ...compact } = report;
  process.stdout.write(JSON.stringify({ ...compact, gridSummary: { cols: grid?.cols, rows: grid?.rows, totalCells: grid?.totalCells } }, null, 2) + '\n');
} else {
  process.stdout.write(formatCliContext(report));
}
