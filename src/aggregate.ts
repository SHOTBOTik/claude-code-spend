import { zeroTokens } from './collect.ts';
import { DEFAULT_PRICES, callCost, findPrice, promptTokens, type PriceTable } from './prices.ts';
import type { Call, GroupBy, Tokens } from './types.ts';

export interface Row {
  /** The model, the session id, or the day `YYYY-MM-DD`; `TOTAL` for the total. */
  key: string;
  calls: number;
  tokens: Tokens;
  /** Cache read / (input + cache read + cache write): the share of the prompt served from the cache. `null` with no prompt. */
  cacheHitRate: number | null;
  /** USD of the calls that have a price. */
  costUsd: number;
  /** Calls without a price: their model is not in the table. Then `costUsd` is less than the spend. */
  unpricedCalls: number;
  /** Of the cache write, how much had no split by lifetime in the data. */
  unsplitWrite: number;
}

export interface Report {
  by: GroupBy;
  rows: Row[];
  total: Row;
  /** Models seen without a price, sorted. */
  unpricedModels: string[];
}

export interface SummarizeOptions {
  by?: GroupBy;
  prices?: PriceTable;
  /** Only calls of this day and later, `YYYY-MM-DD` in the same time zone as the days. */
  since?: string;
  /** Days by UTC instead of local time. */
  utc?: boolean;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** The day of a moment, `YYYY-MM-DD`, local or UTC. */
export function dayOf(at: Date, utc = false): string {
  return utc
    ? `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
    : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** Cache read / (input + cache read + cache write); `null` when nothing was sent. */
export function cacheHitRate(t: Tokens): number | null {
  const prompt = promptTokens(t);
  return prompt > 0 ? t.cacheRead / prompt : null;
}

const emptyRow = (key: string): Row => ({ key, calls: 0, tokens: zeroTokens(), cacheHitRate: null, costUsd: 0, unpricedCalls: 0, unsplitWrite: 0 });

function addCall(row: Row, c: Call, cost: number | undefined): void {
  row.calls++;
  const t = row.tokens;
  t.input += c.tokens.input;
  t.output += c.tokens.output;
  t.cacheWrite5m += c.tokens.cacheWrite5m;
  t.cacheWrite1h += c.tokens.cacheWrite1h;
  t.cacheRead += c.tokens.cacheRead;
  row.unsplitWrite += c.unsplitWrite;
  if (cost === undefined) row.unpricedCalls++;
  else row.costUsd += cost;
}

const UNKNOWN = 'unknown';

/** Calls grouped by model, session or day, with their tokens, cache hit rate and cost. Each call is priced on its own. */
export function summarize(calls: Iterable<Call>, opts: SummarizeOptions = {}): Report {
  const by = opts.by ?? 'model';
  const prices = opts.prices ?? DEFAULT_PRICES;
  if (opts.since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) throw new Error(`since: expected YYYY-MM-DD, got ${opts.since}`);
  const rows = new Map<string, Row>();
  const total = emptyRow('TOTAL');
  const unpriced = new Set<string>();
  for (const c of calls) {
    const day = c.at ? dayOf(c.at, opts.utc) : undefined;
    if (opts.since !== undefined && (day === undefined || day < opts.since)) continue;
    const key = by === 'model' ? c.model : by === 'session' ? c.sessionId || UNKNOWN : (day ?? UNKNOWN);
    const found = findPrice(c.model, prices);
    if (!found) unpriced.add(c.model);
    const cost = found ? callCost(c.tokens, found.price) : undefined;
    let row = rows.get(key);
    if (!row) rows.set(key, (row = emptyRow(key)));
    addCall(row, c, cost);
    addCall(total, c, cost);
  }
  const list = [...rows.values()];
  for (const r of [...list, total]) r.cacheHitRate = cacheHitRate(r.tokens);
  if (by === 'day') list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  else list.sort((a, b) => b.costUsd - a.costUsd || promptTokens(b.tokens) - promptTokens(a.tokens) || (a.key < b.key ? -1 : 1));
  return { by, rows: list, total, unpricedModels: [...unpriced].sort() };
}
