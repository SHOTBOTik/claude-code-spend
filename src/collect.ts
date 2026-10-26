import type { Call, LogLine, SdkMessage, Tokens, UnsplitWrite, Usage } from './types.ts';

export const zeroTokens = (): Tokens => ({ input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A token count as a line gives it; anything that is not one counts as nothing. */
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** The largest of every field seen for a call: a line is a snapshot of the call so far, never a part to add. */
interface Raw {
  input: number;
  output: number;
  write: number;
  named5m: number;
  named1h: number;
  read: number;
}

interface Entry {
  call: Call;
  raw: Raw;
}

export interface CollectorOptions {
  /** Where a cache write without a `cache_creation` split goes. Default `5m`, the API's default lifetime. */
  unsplitWrite?: UnsplitWrite;
}

export interface FeedStats {
  /** Lines or messages with usage that were taken. */
  taken: number;
  /** Of them, the ones that only repeated a call already seen. */
  duplicates: number;
  /** Assistant lines or messages that could not be read as a call: no id, no model, no usage, or `<synthetic>`. */
  ignored: number;
}

/**
 * Calls of the model, merged by message and request id. Feed it lines of Claude Code session logs, messages of the
 * Agent SDK, or both for different sessions; read `calls()`.
 */
export class Collector {
  private entries = new Map<string, Entry>();
  /** Message id to entry, for `stream_event` frames that carry only the message id. */
  private byMessage = new Map<string, Entry>();
  private readonly unsplit: UnsplitWrite;
  readonly stats: FeedStats = { taken: 0, duplicates: 0, ignored: 0 };

  constructor(opts: CollectorOptions = {}) {
    this.unsplit = opts.unsplitWrite ?? '5m';
  }

  /** One parsed line of a session log. Lines of other types are passed by; never throws. */
  feedLogLine(line: unknown, fallbackSession = ''): void {
    if (!isObject(line) || line.type !== 'assistant') return;
    const l = line as LogLine;
    const at = typeof l.timestamp === 'string' ? new Date(l.timestamp) : undefined;
    this.take({
      message: l.message,
      requestId: typeof l.requestId === 'string' && l.requestId ? l.requestId : undefined,
      sessionId: typeof l.sessionId === 'string' && l.sessionId ? l.sessionId : fallbackSession,
      at: at && !Number.isNaN(at.getTime()) ? at : undefined,
      sidechain: l.isSidechain === true,
    });
  }

  /** One message of the Agent SDK `query()` stream. `at` is when it came; default now. Never throws. */
  feedSdkMessage(m: SdkMessage | unknown, at: Date = new Date()): void {
    if (!isObject(m)) return;
    if (m.type === 'assistant') {
      this.take({
        message: m.message as LogLine['message'],
        sessionId: typeof m.session_id === 'string' ? m.session_id : '',
        at,
        sidechain: typeof m.parent_tool_use_id === 'string',
      });
      return;
    }
    if (m.type !== 'stream_event' || typeof m.api_message_id !== 'string') return;
    const e = this.byMessage.get(m.api_message_id);
    const ev = m.event;
    if (!e || !isObject(ev) || ev.type !== 'message_delta' || !isObject(ev.usage)) return;
    e.raw.output = Math.max(e.raw.output, count(ev.usage.output_tokens));
    this.settle(e);
  }

  /** The calls seen so far, in the order they were first seen. */
  calls(): Call[] {
    return [...this.entries.values()].map((e) => e.call);
  }

  private take(f: { message: unknown; requestId?: string; sessionId: string; at?: Date; sidechain: boolean }): void {
    const msg = f.message;
    if (!isObject(msg)) return void this.stats.ignored++;
    const { id, model, usage } = msg;
    // `<synthetic>` is a message the CLI wrote itself (an error, a refused turn): no model was asked.
    if (typeof id !== 'string' || !id || typeof model !== 'string' || !model || model === '<synthetic>' || !isObject(usage)) {
      this.stats.ignored++;
      return;
    }
    const u = usage as Usage;
    const split = isObject(u.cache_creation) ? u.cache_creation : {};
    const key = f.requestId ? `${id}|${f.requestId}` : id;
    this.stats.taken++;
    let e = this.entries.get(key);
    if (e) this.stats.duplicates++;
    else {
      e = {
        call: {
          key, messageId: id, requestId: f.requestId, model, sessionId: f.sessionId, at: f.at, sidechain: f.sidechain,
          tokens: zeroTokens(), unsplitWrite: 0, seen: 0,
        },
        raw: { input: 0, output: 0, write: 0, named5m: 0, named1h: 0, read: 0 },
      };
      this.entries.set(key, e);
      if (!this.byMessage.has(id)) this.byMessage.set(id, e);
    }
    const r = e.raw;
    r.input = Math.max(r.input, count(u.input_tokens));
    r.output = Math.max(r.output, count(u.output_tokens));
    r.write = Math.max(r.write, count(u.cache_creation_input_tokens));
    r.named5m = Math.max(r.named5m, count(split.ephemeral_5m_input_tokens));
    r.named1h = Math.max(r.named1h, count(split.ephemeral_1h_input_tokens));
    r.read = Math.max(r.read, count(u.cache_read_input_tokens));
    e.call.seen++;
    if (!e.call.at && f.at) e.call.at = f.at;
    this.settle(e);
  }

  /** Tokens of a call from its raw maxima: what the split does not name goes by `unsplitWrite`. */
  private settle(e: Entry): void {
    const r = e.raw;
    const rest = Math.max(0, r.write - r.named5m - r.named1h);
    const t = e.call.tokens;
    t.input = r.input;
    t.output = r.output;
    t.cacheRead = r.read;
    t.cacheWrite5m = r.named5m + (this.unsplit === '5m' ? rest : 0);
    t.cacheWrite1h = r.named1h + (this.unsplit === '1h' ? rest : 0);
    e.call.unsplitWrite = rest;
  }
}
