import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Collector, type CollectorOptions } from './collect.ts';

/** Where Claude Code keeps its session logs. */
export const DEFAULT_LOG_DIR = path.join(os.homedir(), '.claude', 'projects');

export interface ReadStats {
  files: number;
  lines: number;
  /** Lines that are not JSON: torn by a write in progress, cut short, or damaged. Skipped. */
  badLines: number;
  /** Lines with usage that were taken. */
  usageLines: number;
  /** Of them, the ones that repeated a call already seen and were merged into it. */
  duplicates: number;
  /** Assistant lines that could not be read as a call (no id, model or usage, or the `<synthetic>` model). */
  ignored: number;
}

/** Every `.jsonl` file under `dir`, sub-agent logs in session subdirectories too, in a stable order. */
export function findLogFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * Lines of a file split at a line feed only, a carriage return before it dropped. Not `readline`: it also splits at
 * U+2028 and U+2029, which JSON allows unescaped inside a string, and such a log line would come out as bad lines.
 */
async function* jsonLines(file: string): AsyncGenerator<string> {
  let pending: string[] = [];
  for await (const chunk of fs.createReadStream(file, { encoding: 'utf8' })) {
    const parts = (chunk as string).split('\n');
    if (parts.length === 1) {
      pending.push(parts[0]!);
      continue;
    }
    pending.push(parts[0]!);
    yield trimCr(pending.join(''));
    for (let i = 1; i < parts.length - 1; i++) yield trimCr(parts[i]!);
    pending = [parts[parts.length - 1]!];
  }
  const last = pending.join('');
  if (last) yield trimCr(last);
}

const trimCr = (s: string): string => (s.endsWith('\r') ? s.slice(0, -1) : s);

/** Feeds one log file to the collector, line by line; returns how many lines it had and how many were bad. */
export async function readLogFile(file: string, into: Collector): Promise<{ lines: number; badLines: number }> {
  const session = path.basename(file, '.jsonl');
  let lines = 0;
  let badLines = 0;
  for await (const text of jsonLines(file)) {
    if (!text.trim()) continue;
    lines++;
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      badLines++;
      continue;
    }
    into.feedLogLine(v, session);
  }
  return { lines, badLines };
}

/** Reads every session log under `dir` (default `~/.claude/projects`) into one collector. */
export async function readLogs(dir: string = DEFAULT_LOG_DIR, opts: CollectorOptions & { collector?: Collector } = {}): Promise<{ collector: Collector; stats: ReadStats }> {
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`not a directory: ${dir}`);
  const collector = opts.collector ?? new Collector(opts);
  const files = findLogFiles(dir);
  let lines = 0;
  let badLines = 0;
  for (const f of files) {
    const r = await readLogFile(f, collector);
    lines += r.lines;
    badLines += r.badLines;
  }
  const s = collector.stats;
  return { collector, stats: { files: files.length, lines, badLines, usageLines: s.taken, duplicates: s.duplicates, ignored: s.ignored } };
}
