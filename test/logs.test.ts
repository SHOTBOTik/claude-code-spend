import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readLogs } from '../src/logs.ts';
import { HAIKU, OPUS, line, tempDir, usage, userLine, writeLog } from './fixtures.ts';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

/** A projects directory: a session with a torn line, its sub-agent log in a subdirectory, a session of an older log format. */
function projects(): string {
  const dir = tempDir();
  writeLog(path.join(dir, 'project-one', 'sess-1.jsonl'), [
    userLine('sess-1'),
    line({ id: 'm1', session: 'sess-1', usage: usage(4, 120, 30_000, 0, 2000) }),
    line({ id: 'm1', session: 'sess-1', usage: usage(4, 150, 30_000, 0, 2000) }),
    '{"type":"assistant","message":{"id":"m2"',
    'not json at all',
    line({ id: 'm3', session: 'sess-1', at: '2026-01-11T12:00:00Z', usage: usage(6, 80, 32_000, 0, 500) }),
  ]);
  writeLog(path.join(dir, 'project-one', 'sess-1', 'subagents', 'agent-x.jsonl'), [
    line({ id: 's1', session: 'sess-1', model: HAIKU, sidechain: true, usage: usage(30, 60, 0, 4000, 0) }),
  ]);
  writeLog(path.join(dir, 'project-two', 'sess-2.jsonl'), [
    // An older log: no cache_creation split, no session id in the line.
    { ...line({ id: 'o1', usage: usage(100, 10, 0, 5000, 0, false) }), sessionId: undefined },
  ]);
  return dir;
}

describe('reading session logs', () => {
  it('every .jsonl under the directory, bad lines skipped and counted', async () => {
    const { collector, stats } = await readLogs(projects());
    assert.deepEqual(stats, { files: 3, lines: 8, badLines: 2, usageLines: 5, duplicates: 1, ignored: 0 });
    const calls = collector.calls();
    assert.equal(calls.length, 4);
    assert.deepEqual(calls.map((c) => c.sessionId).sort(), ['sess-1', 'sess-1', 'sess-1', 'sess-2']);
    assert.equal(calls.find((c) => c.messageId === 'o1')!.unsplitWrite, 5000);
  });

  it('a line is split at a line feed only: U+2028 in a string, CRLF and a line longer than a read chunk are whole', async () => {
    const dir = tempDir();
    const sep = line({ id: 'u1', usage: usage(1, 2, 0, 0, 0) });
    (sep.message as { content: unknown }).content = [{ type: 'text', text: 'a b c' }];
    const long = line({ id: 'u2', usage: usage(3, 4, 0, 0, 0) });
    (long.message as { content: unknown }).content = [{ type: 'text', text: 'x'.repeat(300_000) }];
    writeLog(path.join(dir, 'p', 's.jsonl'), [JSON.stringify(sep) + '\r', JSON.stringify(long) + '\r', '\r']);
    const { collector, stats } = await readLogs(dir);
    assert.equal(stats.badLines, 0);
    assert.equal(stats.lines, 2);
    assert.deepEqual(collector.calls().map((c) => c.tokens.output), [2, 4]);
  });

  it('a directory that is not there is an error', async () => {
    await assert.rejects(readLogs(path.join(tempDir(), 'none')), /not a directory/);
  });
});

describe('cli', () => {
  it('--json: the report with the read stats', () => {
    const out = execFileSync(process.execPath, [CLI, '--dir', projects(), '--json', '--utc'], { encoding: 'utf8' });
    const r = JSON.parse(out);
    assert.equal(r.by, 'model');
    assert.equal(r.read.badLines, 2);
    assert.deepEqual(r.rows.map((x: { key: string }) => x.key), [OPUS, HAIKU]);
    assert.deepEqual(r.total.tokens, { input: 140, output: 300, cacheWrite5m: 9000, cacheWrite1h: 2500, cacheRead: 62_000 });
    assert.equal(r.total.unsplitWrite, 5000);
  });

  it('the table, by day, since a day', () => {
    const out = execFileSync(process.execPath, [CLI, '--dir', projects(), '--by', 'day', '--since', '2026-01-11', '--utc'], { encoding: 'utf8' });
    assert.match(out, /bad lines skipped: 2/);
    assert.match(out, /^day\s+calls\s+input\s+output\s+write 5m\s+write 1h\s+cache read\s+hit rate\s+USD$/m);
    assert.match(out, /^2026-01-11\s+1\s+6\s+80\s+0\s+500\s+32,000\s+98\.4%\s+0\.02$/m);
    assert.doesNotMatch(out, /2026-01-10/);
  });

  it('a wrong option is exit code 2 with the usage', () => {
    const r = spawnSync(process.execPath, [CLI, '--by', 'week'], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--by: expected model, session, day/);
    assert.match(r.stderr, /Usage:/);
  });
});
