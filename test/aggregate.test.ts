import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cacheHitRate, summarize } from '../src/aggregate.ts';
import { Collector } from '../src/collect.ts';
import { DEFAULT_PRICES, callCost } from '../src/prices.ts';
import { HAIKU, OPUS, SONNET, line, usage } from './fixtures.ts';

const tok = (input: number, output: number, cacheRead: number, cacheWrite5m: number, cacheWrite1h: number) =>
  ({ input, output, cacheWrite5m, cacheWrite1h, cacheRead });
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

/** Two sessions, two days, three models. */
function calls() {
  const c = new Collector();
  for (const l of [
    line({ id: 'a1', session: 's1', model: OPUS, at: '2026-01-10T09:00:00Z', usage: usage(10, 100, 0, 0, 20_000) }),
    line({ id: 'a1', session: 's1', model: OPUS, at: '2026-01-10T09:00:00Z', usage: usage(10, 300, 0, 0, 20_000) }),
    line({ id: 'a2', session: 's1', model: OPUS, at: '2026-01-10T09:01:00Z', usage: usage(5, 200, 20_000, 0, 1000) }),
    line({ id: 'a3', session: 's1', model: HAIKU, at: '2026-01-10T09:02:00Z', sidechain: true, usage: usage(50, 40, 0, 3000, 0) }),
    line({ id: 'b1', session: 's2', model: SONNET, at: '2026-01-11T15:00:00Z', usage: usage(1000, 500, 9000, 0, 0) }),
    line({ id: 'b2', session: 's2', model: 'claude-unknown-9', at: '2026-01-11T15:05:00Z', usage: usage(7, 7, 0, 0, 0) }),
  ])
    c.feedLogLine(l);
  return c.calls();
}

describe('cache hit rate', () => {
  it('is read / (input + read + 5m write + 1h write)', () => {
    close(cacheHitRate(tok(10, 999, 60, 20, 10))!, 60 / 100);
    assert.equal(cacheHitRate(tok(0, 50, 0, 0, 0)), null);
    assert.equal(cacheHitRate(tok(100, 0, 0, 0, 0)), 0);
  });
});

describe('summary by model', () => {
  const r = summarize(calls(), { by: 'model', utc: true });

  it('one row per model, the duplicate merged, the most expensive first', () => {
    assert.deepEqual(r.rows.map((x) => x.key), [OPUS, SONNET, HAIKU, 'claude-unknown-9']);
    const opus = r.rows[0]!;
    assert.equal(opus.calls, 2);
    assert.deepEqual(opus.tokens, tok(15, 500, 20_000, 0, 21_000));
    close(opus.cacheHitRate!, 20_000 / (15 + 20_000 + 21_000));
  });

  it('the cost is the sum of the calls by the table', () => {
    const opus = DEFAULT_PRICES['claude-opus-4-7']!;
    close(r.rows[0]!.costUsd, callCost(tok(10, 300, 0, 0, 20_000), opus) + callCost(tok(5, 200, 20_000, 0, 1000), opus));
    close(r.rows[0]!.costUsd, (15 * 5 + 500 * 25 + 21_000 * 10 + 20_000 * 0.5) / 1e6);
  });

  it('a model without a price: its tokens are in the total, its cost is not, and it is named', () => {
    assert.deepEqual(r.unpricedModels, ['claude-unknown-9']);
    const unknown = r.rows.find((x) => x.key === 'claude-unknown-9')!;
    assert.equal(unknown.unpricedCalls, 1);
    assert.equal(unknown.costUsd, 0);
    assert.equal(r.total.calls, 5);
    assert.equal(r.total.unpricedCalls, 1);
    assert.equal(r.total.tokens.input, 15 + 50 + 1000 + 7);
    close(r.total.costUsd, r.rows.reduce((s, x) => s + x.costUsd, 0));
  });
});

describe('summary by session and by day', () => {
  it('by session', () => {
    const r = summarize(calls(), { by: 'session', utc: true });
    assert.deepEqual(r.rows.map((x) => [x.key, x.calls]), [['s1', 3], ['s2', 2]]);
    assert.deepEqual(r.rows[0]!.tokens, tok(65, 540, 20_000, 3000, 21_000));
  });

  it('by day, in the order of days', () => {
    const r = summarize(calls(), { by: 'day', utc: true });
    assert.deepEqual(r.rows.map((x) => [x.key, x.calls]), [['2026-01-10', 3], ['2026-01-11', 2]]);
    close(r.rows[1]!.cacheHitRate!, 9000 / (1007 + 9000));
  });

  it('since: only the days from it on', () => {
    const r = summarize(calls(), { by: 'day', utc: true, since: '2026-01-11' });
    assert.deepEqual(r.rows.map((x) => x.key), ['2026-01-11']);
    assert.equal(r.total.calls, 2);
    assert.throws(() => summarize(calls(), { since: '11.01.2026' }), /YYYY-MM-DD/);
  });

  it('the totals of every grouping are the same', () => {
    const totals = (['model', 'session', 'day'] as const).map((by) => summarize(calls(), { by, utc: true }).total);
    for (const t of totals) assert.deepEqual(t.tokens, totals[0]!.tokens);
  });
});
