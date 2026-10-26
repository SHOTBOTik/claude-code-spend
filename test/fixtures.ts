import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Usage } from '../src/types.ts';

/** Synthetic data only: made-up ids, sessions and counts. */
export const OPUS = 'claude-opus-4-7';
export const SONNET = 'claude-sonnet-4-6';
export const HAIKU = 'claude-haiku-4-5-20251001';

/** `usage` with a 5m/1h split, or without one when `split` is false. */
export function usage(input: number, output: number, read: number, w5m: number, w1h: number, split = true): Usage {
  const u: Usage = { input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: w5m + w1h };
  if (split) u.cache_creation = { ephemeral_5m_input_tokens: w5m, ephemeral_1h_input_tokens: w1h };
  return u;
}

export interface LineOpts {
  id: string;
  req?: string;
  model?: string;
  session?: string;
  at?: string;
  sidechain?: boolean;
  usage: Usage;
}

let n = 0;

/** An assistant line of a Claude Code session log. */
export function line(o: LineOpts): Record<string, unknown> {
  return {
    type: 'assistant',
    sessionId: o.session ?? 'sess-a',
    requestId: o.req ?? `req-${o.id}`,
    timestamp: o.at ?? '2026-01-10T12:00:00.000Z',
    isSidechain: o.sidechain ?? false,
    uuid: `uuid-${++n}`,
    message: { id: o.id, model: o.model ?? OPUS, role: 'assistant', type: 'message', content: [{ type: 'text', text: 'synthetic' }], usage: o.usage },
  };
}

export const userLine = (session = 'sess-a'): Record<string, unknown> => ({
  type: 'user',
  sessionId: session,
  timestamp: '2026-01-10T11:59:00.000Z',
  message: { role: 'user', content: 'synthetic' },
});

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-test-'));
}

/** Writes JSONL: objects become JSON lines, strings go as they are (for bad lines). */
export function writeLog(file: string, lines: (object | string)[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n', 'utf8');
}
