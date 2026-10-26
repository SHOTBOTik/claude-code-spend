import fs from 'node:fs';
import type { Tokens } from './types.ts';

/** Where the default table was taken from, and when it was last compared with it. Prices change: check them. */
export const PRICES_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';
export const PRICES_CHECKED = '2026-10-26';

/**
 * Prompt cache prices against the base input price, as the pricing page states them: a 5-minute write 1.25×, a
 * 1-hour write 2×, a read 0.1×. Some models have their own read price; the table names it for them.
 */
export const CACHE_MULTIPLIERS = { write5m: 1.25, write1h: 2, read: 0.1 } as const;

/** USD per million tokens. A cache price left out is derived from `input` by `CACHE_MULTIPLIERS`. */
export interface Rates {
  input: number;
  output: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  cacheRead?: number;
}

export interface ModelPrice extends Rates {
  /** Higher prices for a call whose prompt (input + cache read + cache write) is over `over` tokens. */
  longPrompt?: Rates & { over: number };
}

/** Model id (without a date suffix) to its prices. */
export type PriceTable = Record<string, ModelPrice>;

/** Claude API first-party prices, standard tier, global inference. */
export const DEFAULT_PRICES: PriceTable = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, longPrompt: { over: 100_000, input: 0.5, output: 2.5 } },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
};

/** Every price of a set of rates, the cache ones derived where not given. */
export function fullRates(r: Rates): Required<Rates> {
  return {
    input: r.input,
    output: r.output,
    cacheWrite5m: r.cacheWrite5m ?? r.input * CACHE_MULTIPLIERS.write5m,
    cacheWrite1h: r.cacheWrite1h ?? r.input * CACHE_MULTIPLIERS.write1h,
    cacheRead: r.cacheRead ?? r.input * CACHE_MULTIPLIERS.read,
  };
}

/** A model name as logs give it, brought to the id of the table: no `[1m]` suffix, no provider prefix. */
export function modelName(model: string): string {
  return model
    .replace(/(\s*\[[^\]]*\])+\s*$/, '')
    .trim()
    .replace(/^([a-z]{2,4}\.)?anthropic\./, '');
}

/** What may follow an id of the table: a date (`-20251001`, `@20251001`) and a provider version (`-v1:0`). */
const SUFFIX = /^([-@]\d{8})?(-v\d+(:\d+)?)?$/;

/** The id of the table a model is priced by, or `undefined`. An unknown version is not priced as its neighbour. */
export function findPrice(model: string, table: PriceTable): { id: string; price: ModelPrice } | undefined {
  const name = modelName(model);
  let best: string | undefined;
  for (const id of Object.keys(table)) {
    if (!name.startsWith(id) || !SUFFIX.test(name.slice(id.length))) continue;
    if (!best || id.length > best.length) best = id;
  }
  return best === undefined ? undefined : { id: best, price: table[best]! };
}

/** The prompt of a call: everything it sent, cached or not. */
export const promptTokens = (t: Tokens): number => t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;

/** USD of one call. A long prompt tier is chosen by the prompt of this call alone. */
export function callCost(t: Tokens, price: ModelPrice): number {
  const tier = price.longPrompt && promptTokens(t) > price.longPrompt.over ? price.longPrompt : price;
  const r = fullRates(tier);
  return (
    (t.input * r.input + t.output * r.output + t.cacheWrite5m * r.cacheWrite5m + t.cacheWrite1h * r.cacheWrite1h + t.cacheRead * r.cacheRead) /
    1e6
  );
}

const RATE_KEYS = ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'] as const;

function checkRates(where: string, v: unknown, required: boolean): void {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${where}: expected an object of prices`);
  const o = v as Record<string, unknown>;
  for (const k of RATE_KEYS) {
    const x = o[k];
    if (x === undefined && (!required || (k !== 'input' && k !== 'output'))) continue;
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) throw new Error(`${where}.${k}: expected a number of USD per million tokens, 0 or more`);
  }
}

/**
 * A price table from JSON: `{ "<model id>": { "input": 3, "output": 15, "cacheRead": 0.3, ... } }`, USD per million
 * tokens. Throws on a wrong shape, naming the place.
 */
export function parsePriceTable(json: unknown): PriceTable {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Error('prices: expected an object of models');
  const out: PriceTable = Object.create(null) as PriceTable;
  for (const [id, v] of Object.entries(json)) {
    checkRates(id, v, true);
    const p = v as ModelPrice;
    if (p.longPrompt !== undefined) {
      checkRates(`${id}.longPrompt`, p.longPrompt, true);
      const over = p.longPrompt.over;
      if (typeof over !== 'number' || !Number.isFinite(over) || over < 0) throw new Error(`${id}.longPrompt.over: expected a number of tokens`);
    }
    const entry: ModelPrice = { input: p.input, output: p.output };
    for (const k of ['cacheWrite5m', 'cacheWrite1h', 'cacheRead'] as const) if (p[k] !== undefined) entry[k] = p[k];
    if (p.longPrompt) entry.longPrompt = { ...p.longPrompt };
    out[id] = entry;
  }
  return out;
}

/** The default table with a JSON file over it: a model in the file replaces the default entry of that id whole. */
export function loadPrices(file?: string): PriceTable {
  const table: PriceTable = Object.assign(Object.create(null) as PriceTable, DEFAULT_PRICES);
  if (!file) return table;
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`prices file ${file}: ${(e as Error).message}`);
  }
  return Object.assign(table, parsePriceTable(json));
}
