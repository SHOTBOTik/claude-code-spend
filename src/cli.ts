#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { summarize } from './aggregate.ts';
import { formatTable } from './format.ts';
import { DEFAULT_LOG_DIR, readLogs } from './logs.ts';
import { PRICES_CHECKED, PRICES_SOURCE, loadPrices } from './prices.ts';
import type { GroupBy, UnsplitWrite } from './types.ts';

const USAGE = `claude-code-spend — token spend of Claude Code sessions, with the prompt cache broken down

Usage:
  node src/cli.ts [--dir <path>] [--since YYYY-MM-DD] [--by model|session|day] [--json]

Options:
  --dir <path>         session logs (default ~/.claude/projects), searched recursively for *.jsonl
  --since YYYY-MM-DD   only calls of this day and later
  --by <group>         model (default), session or day
  --json               the report as JSON instead of a table
  --prices <file>      JSON price table over the default one: { "<model>": { "input": 3, "output": 15 } }, USD per MTok
  --unsplit 5m|1h      where a cache write without a 5m/1h split goes (default 5m)
  --utc                days by UTC instead of local time
  -h, --help

Cost is an estimate by list prices (checked ${PRICES_CHECKED}, ${PRICES_SOURCE}): check them.
Exit code: 0 — report printed, 2 — usage or runtime error.`;

const GROUPS: GroupBy[] = ['model', 'session', 'day'];
const UNSPLIT: UnsplitWrite[] = ['5m', '1h'];

class UsageError extends Error {}

/** A path for the screen: the home directory as `~`. */
function shown(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length).split(path.sep).join('/') : p;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: 'string' },
      since: { type: 'string' },
      by: { type: 'string' },
      json: { type: 'boolean' },
      prices: { type: 'string' },
      unsplit: { type: 'string' },
      utc: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  if (positionals.length) throw new UsageError(`unexpected argument: ${positionals[0]}`);
  const by = (values.by ?? 'model') as GroupBy;
  if (!GROUPS.includes(by)) throw new UsageError(`--by: expected ${GROUPS.join(', ')}`);
  const unsplit = (values.unsplit ?? '5m') as UnsplitWrite;
  if (!UNSPLIT.includes(unsplit)) throw new UsageError('--unsplit: expected 5m or 1h');
  if (values.since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.since)) throw new UsageError('--since: expected YYYY-MM-DD');

  const dir = path.resolve(values.dir ?? DEFAULT_LOG_DIR);
  const prices = loadPrices(values.prices);
  const { collector, stats } = await readLogs(dir, { unsplitWrite: unsplit });
  const report = summarize(collector.calls(), { by, prices, since: values.since, utc: values.utc });

  if (values.json) {
    process.stdout.write(JSON.stringify({ dir: shown(dir), since: values.since ?? null, read: stats, pricesChecked: PRICES_CHECKED, ...report }, null, 2) + '\n');
  } else {
    const since = values.since ? `, since ${values.since}` : '';
    process.stdout.write(`${shown(dir)}${since}\n`);
    process.stdout.write(
      `${stats.files} files, ${stats.lines} lines, ${collector.calls().length} calls (duplicate lines merged: ${stats.duplicates}), bad lines skipped: ${stats.badLines}\n\n`,
    );
    process.stdout.write(formatTable(report, { unsplitAs: unsplit }));
    process.stdout.write(`\nUSD is an estimate by list prices checked ${PRICES_CHECKED}; check them at ${PRICES_SOURCE}\n`);
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    const usage = e instanceof UsageError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
    process.stderr.write(`claude-code-spend: ${(e as Error).message}\n${usage ? '\n' + USAGE + '\n' : ''}`);
    process.exitCode = 2;
  },
);
