import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Collector } from '../src/collect.ts';
import { HAIKU, OPUS, line, usage } from './fixtures.ts';

const tok = (input: number, output: number, cacheRead: number, cacheWrite5m: number, cacheWrite1h: number) =>
  ({ input, output, cacheWrite5m, cacheWrite1h, cacheRead });

function fed(lines: unknown[], c = new Collector()): Collector {
  for (const l of lines) c.feedLogLine(l);
  return c;
}

describe('deduplication', () => {
  it('lines of one message and request are one call: the largest of every field, not the sum', () => {
    const c = fed([
      line({ id: 'msg_1', usage: usage(3, 10, 5000, 0, 800) }),
      line({ id: 'msg_1', usage: usage(3, 40, 5000, 0, 800) }),
      line({ id: 'msg_1', usage: usage(3, 25, 5000, 0, 800) }),
    ]);
    const calls = c.calls();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.tokens, tok(3, 40, 5000, 0, 800));
    assert.equal(calls[0]!.seen, 3);
    assert.deepEqual(c.stats, { taken: 3, duplicates: 2, ignored: 0 });
  });

  it('the same message id under another request id is another call', () => {
    const c = fed([line({ id: 'msg_1', req: 'req_a', usage: usage(1, 1, 0, 0, 0) }), line({ id: 'msg_1', req: 'req_b', usage: usage(1, 1, 0, 0, 0) })]);
    assert.equal(c.calls().length, 2);
  });

  it('a call copied into another session file is counted once, under the session it was first seen in', () => {
    const c = fed([
      line({ id: 'msg_1', session: 'first', usage: usage(2, 7, 100, 50, 0) }),
      line({ id: 'msg_1', session: 'resumed', usage: usage(2, 7, 100, 50, 0) }),
    ]);
    assert.equal(c.calls().length, 1);
    assert.equal(c.calls()[0]!.sessionId, 'first');
  });

  it('lines that are not a call are passed by: other types, <synthetic>, no id, no usage', () => {
    const c = fed([
      { type: 'user', message: { content: 'x' } },
      { type: 'summary' },
      null,
      42,
      line({ id: 'msg_s', model: '<synthetic>', usage: usage(0, 0, 0, 0, 0) }),
      { ...line({ id: 'msg_x', usage: usage(1, 1, 0, 0, 0) }), message: { model: OPUS, usage: usage(1, 1, 0, 0, 0) } },
      { ...line({ id: 'msg_y', usage: usage(1, 1, 0, 0, 0) }), message: { id: 'msg_y', model: OPUS } },
    ]);
    assert.equal(c.calls().length, 0);
    assert.equal(c.stats.ignored, 3);
  });

  it('counts that are not numbers count as nothing', () => {
    const c = fed([line({ id: 'msg_1', usage: { input_tokens: 'many' as unknown as number, output_tokens: -5, cache_read_input_tokens: Number.NaN } })]);
    assert.deepEqual(c.calls()[0]!.tokens, tok(0, 0, 0, 0, 0));
  });
});

describe('the cache write split', () => {
  it('with the split: 5m and 1h as given', () => {
    assert.deepEqual(fed([line({ id: 'm', usage: usage(1, 2, 30, 400, 500) })]).calls()[0]!.tokens, tok(1, 2, 30, 400, 500));
  });

  it('without cache_creation: the whole write goes to 5m by default and is counted as unsplit', () => {
    const call = fed([line({ id: 'm', usage: usage(1, 2, 30, 900, 0, false) })]).calls()[0]!;
    assert.deepEqual(call.tokens, tok(1, 2, 30, 900, 0));
    assert.equal(call.unsplitWrite, 900);
  });

  it('without cache_creation and unsplitWrite 1h: the whole write goes to 1h', () => {
    const call = fed([line({ id: 'm', usage: usage(1, 2, 30, 900, 0, false) })], new Collector({ unsplitWrite: '1h' })).calls()[0]!;
    assert.deepEqual(call.tokens, tok(1, 2, 30, 0, 900));
  });

  it('a split that names only a part: the rest goes by the rule', () => {
    const u = { ...usage(1, 2, 0, 0, 0, false), cache_creation_input_tokens: 700, cache_creation: { ephemeral_1h_input_tokens: 200 } };
    const call = fed([line({ id: 'm', usage: u })]).calls()[0]!;
    assert.deepEqual(call.tokens, tok(1, 2, 0, 500, 200));
    assert.equal(call.unsplitWrite, 500);
  });

  it('a split with the 5m and 1h fields null: as if there was none', () => {
    const u = {
      ...usage(0, 0, 0, 0, 0, false),
      cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: null, ephemeral_1h_input_tokens: null },
    };
    assert.deepEqual(fed([line({ id: 'm', usage: u })]).calls()[0]!.tokens, tok(0, 0, 0, 300, 0));
  });
});

describe('Agent SDK messages', () => {
  const at = new Date('2026-01-10T12:00:00Z');
  const assistant = (id: string, u: ReturnType<typeof usage>, parent: string | null = null, model = HAIKU) => ({
    type: 'assistant',
    session_id: 'sdk-1',
    parent_tool_use_id: parent,
    uuid: 'u',
    message: { id, model, usage: u, content: [] },
  });

  it('assistant messages of one id merge; a sub-agent is a sidechain call', () => {
    const c = new Collector();
    c.feedSdkMessage(assistant('msg_1', usage(2, 5, 1000, 0, 300)), at);
    c.feedSdkMessage(assistant('msg_1', usage(2, 9, 1000, 0, 300)), at);
    c.feedSdkMessage(assistant('msg_2', usage(4, 3, 0, 600, 0), 'toolu_1'), at);
    c.feedSdkMessage({ type: 'result', subtype: 'success', total_cost_usd: 1 }, at);
    const [a, b] = c.calls();
    assert.equal(c.calls().length, 2);
    assert.deepEqual(a!.tokens, tok(2, 9, 1000, 0, 300));
    assert.equal(a!.sessionId, 'sdk-1');
    assert.equal(a!.sidechain, false);
    assert.equal(b!.sidechain, true);
    assert.equal(a!.at!.toISOString(), at.toISOString());
  });

  it('message_delta of a stream_event brings the final output of its call', () => {
    const c = new Collector();
    c.feedSdkMessage(assistant('msg_1', usage(2, 1, 0, 0, 0)), at);
    c.feedSdkMessage({ type: 'stream_event', api_message_id: 'msg_1', event: { type: 'message_delta', usage: { output_tokens: 250 } } }, at);
    c.feedSdkMessage({ type: 'stream_event', api_message_id: 'msg_unknown', event: { type: 'message_delta', usage: { output_tokens: 99 } } }, at);
    c.feedSdkMessage({ type: 'stream_event', event: { type: 'message_stop' } }, at);
    assert.equal(c.calls().length, 1);
    assert.equal(c.calls()[0]!.tokens.output, 250);
  });
});
