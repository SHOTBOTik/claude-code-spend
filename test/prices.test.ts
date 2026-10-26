import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CACHE_MULTIPLIERS, DEFAULT_PRICES, callCost, findPrice, fullRates, loadPrices, modelName, parsePriceTable } from '../src/prices.ts';
import { tempDir } from './fixtures.ts';

const tok = (input: number, output: number, cacheRead: number, cacheWrite5m: number, cacheWrite1h: number) =>
  ({ input, output, cacheWrite5m, cacheWrite1h, cacheRead });
const M = 1_000_000;
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

describe('cost with the cache multipliers', () => {
  it('the multipliers are 1.25 for a 5m write, 2 for a 1h write, 0.1 for a read', () => {
    assert.deepEqual(CACHE_MULTIPLIERS, { write5m: 1.25, write1h: 2, read: 0.1 });
    assert.deepEqual(fullRates({ input: 5, output: 25 }), { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 });
  });

  it('a million of each kind on a $5/$25 model: 5 + 25 + 6.25 + 10 + 0.5', () => {
    close(callCost(tok(M, M, M, M, M), DEFAULT_PRICES['claude-opus-4-7']!), 46.75);
  });

  it('each kind alone', () => {
    const p = DEFAULT_PRICES['claude-sonnet-4-6']!;
    close(callCost(tok(M, 0, 0, 0, 0), p), 3);
    close(callCost(tok(0, M, 0, 0, 0), p), 15);
    close(callCost(tok(0, 0, M, 0, 0), p), 0.3);
    close(callCost(tok(0, 0, 0, M, 0), p), 3.75);
    close(callCost(tok(0, 0, 0, 0, M), p), 6);
  });

  it('a model with its own read price takes it instead of 0.1x', () => {
    close(callCost(tok(0, 0, M, 0, 0), DEFAULT_PRICES['claude-opus-5-5']!), 0.2);
    close(callCost(tok(0, 0, 0, M, 0), DEFAULT_PRICES['claude-opus-5-5']!), 5);
    close(callCost(tok(0, 0, M, 0, 0), DEFAULT_PRICES['claude-fable-5-1']!), 0.25);
  });

  it('a long prompt tier is chosen by the prompt of the call, cache included', () => {
    const p = DEFAULT_PRICES['claude-haiku-5-5']!;
    close(callCost(tok(1000, 1000, 99_000, 0, 0), p), (1000 * 0.1 + 1000 * 0.5 + 99_000 * 0.01) / M);
    close(callCost(tok(1000, 1000, 99_001, 0, 0), p), (1000 * 0.5 + 1000 * 2.5 + 99_001 * 0.05) / M);
  });

  it('the cache pays: the same prompt read from the cache costs a tenth', () => {
    const p = DEFAULT_PRICES['claude-opus-4-7']!;
    const cold = callCost(tok(100_000, 0, 0, 0, 0), p);
    const warm = callCost(tok(0, 0, 100_000, 0, 0), p);
    close(warm, cold / 10);
  });
});

describe('finding the price of a model', () => {
  it('a date suffix, a [1m] suffix and a provider prefix are the same model', () => {
    for (const m of ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-haiku-4-5@20251001', 'anthropic.claude-haiku-4-5-20251001-v1:0', 'claude-haiku-4-5[1m]'])
      assert.equal(findPrice(m, DEFAULT_PRICES)?.id, 'claude-haiku-4-5', m);
    assert.equal(modelName('claude-opus-4-7 [1m]'), 'claude-opus-4-7');
  });

  it('the longest id wins: claude-opus-4-5 is not claude-opus-4', () => {
    assert.equal(findPrice('claude-opus-4-5-20251101', DEFAULT_PRICES)?.id, 'claude-opus-4-5');
    assert.equal(findPrice('claude-opus-4-20250514', DEFAULT_PRICES)?.id, 'claude-opus-4');
  });

  it('an unknown version is not priced as its neighbour', () => {
    assert.equal(findPrice('claude-opus-4-9', DEFAULT_PRICES), undefined);
    assert.equal(findPrice('claude-sonnet-5-5-preview', DEFAULT_PRICES), undefined);
    assert.equal(findPrice('gpt-x', DEFAULT_PRICES), undefined);
  });
});

describe('a price table from JSON', () => {
  it('a file entry replaces the default entry of its id; the rest stay', () => {
    const file = path.join(tempDir(), 'prices.json');
    fs.writeFileSync(file, JSON.stringify({ 'claude-opus-4-7': { input: 1, output: 2 }, 'my-model': { input: 0, output: 0, cacheRead: 0 } }));
    const t = loadPrices(file);
    close(callCost(tok(M, M, M, 0, 0), t['claude-opus-4-7']!), 1 + 2 + 0.1);
    assert.ok(t['my-model']);
    assert.deepEqual(t['claude-sonnet-4-6'], DEFAULT_PRICES['claude-sonnet-4-6']);
    assert.equal(loadPrices()['claude-opus-4-7']!.input, 5);
  });

  it('a wrong shape is an error that names the place', () => {
    assert.throws(() => parsePriceTable([]), /expected an object of models/);
    assert.throws(() => parsePriceTable({ m: { input: 1 } }), /m\.output/);
    assert.throws(() => parsePriceTable({ m: { input: 1, output: 2, cacheRead: -1 } }), /m\.cacheRead/);
    assert.throws(() => parsePriceTable({ m: { input: 1, output: 2, longPrompt: { input: 1, output: 2 } } }), /m\.longPrompt\.over/);
    const file = path.join(tempDir(), 'bad.json');
    fs.writeFileSync(file, '{ not json');
    assert.throws(() => loadPrices(file), /prices file/);
  });
});
