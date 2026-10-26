import type { Report, Row } from './aggregate.ts';

const int = (n: number): string => Math.round(n).toLocaleString('en-US');
const pct = (r: number | null): string => (r === null ? '-' : `${(r * 100).toFixed(1)}%`);

function usd(r: Row): string {
  if (r.unpricedCalls === r.calls) return '?';
  const s = r.costUsd < 0.01 && r.costUsd > 0 ? r.costUsd.toFixed(4) : r.costUsd.toFixed(2);
  return r.unpricedCalls ? `${s}*` : s;
}

const COLUMNS = ['calls', 'input', 'output', 'write 5m', 'write 1h', 'cache read', 'hit rate', 'USD'] as const;

function cells(r: Row): string[] {
  const t = r.tokens;
  return [r.key, int(r.calls), int(t.input), int(t.output), int(t.cacheWrite5m), int(t.cacheWrite1h), int(t.cacheRead), pct(r.cacheHitRate), usd(r)];
}

/** The report as a plain text table: one row per group, then the total and the notes. */
export function formatTable(report: Report, opts: { unsplitAs?: '5m' | '1h' } = {}): string {
  const head = [report.by, ...COLUMNS];
  const body = report.rows.map(cells);
  const total = cells(report.total);
  const all = [head, ...body, total];
  const widths = head.map((_, i) => Math.max(...all.map((row) => row[i]!.length)));
  const line = (row: string[]): string => row.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ').trimEnd();
  const rule = widths.map((w) => '-'.repeat(w)).join('  ');
  const out = [line(head), rule, ...body.map(line), rule, line(total)];
  const unsplit = report.total.unsplitWrite;
  if (report.unpricedModels.length)
    out.push('', `* no price for ${report.unpricedModels.join(', ')}: their tokens are counted, their cost is not. Add them with --prices <file>.`);
  if (unsplit > 0)
    out.push('', `${int(unsplit)} cache write tokens had no 5m/1h split and are counted as ${opts.unsplitAs ?? '5m'} (--unsplit 5m|1h).`);
  return out.join('\n') + '\n';
}
