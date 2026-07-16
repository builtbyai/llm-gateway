#!/usr/bin/env node
/**
 * llm-gateway CLI — a thin, dependency-free entry point over the library.
 *
 * Usage:
 *   llm-gateway usage [--json] [--last <n>] [--records]
 *
 * Reads the append-only ledger at ~/.structure/usage.log and prints a
 * per-model / per-provider cost + cache rollup.
 */

import { readUsage, summarize, ledgerPath } from './usage/ledger.js';

interface UsageOpts {
  json: boolean;
  last?: number;
  records: boolean;
}

function parseUsageArgs(argv: string[]): UsageOpts {
  const opts: UsageOpts = { json: false, records: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--records') opts.records = true;
    else if (arg === '--last') {
      const n = parseInt(argv[++i] ?? '', 10);
      if (!Number.isNaN(n)) opts.last = n;
    } else if (arg.startsWith('--last=')) {
      const n = parseInt(arg.slice('--last='.length), 10);
      if (!Number.isNaN(n)) opts.last = n;
    }
  }
  return opts;
}

async function runUsage(argv: string[]): Promise<void> {
  const opts = parseUsageArgs(argv);
  const records = await readUsage(opts.last);

  if (opts.records) {
    if (opts.json) {
      console.log(JSON.stringify(records, null, 2));
    } else {
      for (const r of records) {
        console.log(
          `${r.timestamp}  ${r.model.padEnd(28)}  in=${r.inputTokens}  out=${r.outputTokens}  cache_read=${r.cacheReadInputTokens ?? 0}  $${r.costUsd.toFixed(4)}`
        );
      }
    }
    return;
  }

  const sum = summarize(records);

  if (opts.json) {
    console.log(JSON.stringify(sum, null, 2));
    return;
  }

  console.log(`\nUsage summary  (ledger: ${ledgerPath()})\n`);
  if (sum.totalCalls === 0) {
    console.log('  No usage recorded yet.');
    return;
  }
  console.log(`  Calls            : ${sum.totalCalls}`);
  console.log(`  Total cost       : $${sum.totalCostUsd.toFixed(4)}`);
  console.log(`  Input tokens     : ${sum.totalInputTokens.toLocaleString()}`);
  console.log(`  Output tokens    : ${sum.totalOutputTokens.toLocaleString()}`);
  console.log(`  Cache reads      : ${sum.totalCacheReads.toLocaleString()}`);
  console.log(`  Cache writes     : ${sum.totalCacheWrites.toLocaleString()}`);
  console.log(`  Cache hit rate   : ${(sum.cacheHitRate * 100).toFixed(1)}%`);

  console.log('\n  By model:');
  for (const [model, stats] of Object.entries(sum.byModel)) {
    console.log(
      `    ${model.padEnd(30)}  ${stats.calls} calls   $${stats.costUsd.toFixed(4)}   cache_read=${stats.cacheReads.toLocaleString()}`
    );
  }
  console.log('\n  By provider:');
  for (const [provider, stats] of Object.entries(sum.byProvider)) {
    console.log(
      `    ${provider.padEnd(30)}  ${stats.calls} calls   $${stats.costUsd.toFixed(4)}   cache_read=${stats.cacheReads.toLocaleString()}`
    );
  }
  console.log('');
}

function printHelp(): void {
  console.log(`llm-gateway — per-model, cache-aware LLM cost attribution

Usage:
  llm-gateway usage [--json] [--last <n>] [--records]

Commands:
  usage    Summarize token usage, USD cost, and cache-hit rate from the
           append-only ledger (default: ~/.structure/usage.log).

Options:
  --json       Emit JSON instead of a human-readable table.
  --last <n>   Only consider the last N ledger records.
  --records    Print individual records instead of the rollup.
  -h, --help   Show this help.`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'usage':
      await runUsage(rest);
      break;
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
