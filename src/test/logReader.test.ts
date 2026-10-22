import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventParser, LogTailer } from '../logReader';

const line = (o: object) => JSON.stringify(o);
const asst = (id: string, req: string, ts: string, usage: object, model = 'claude-fable-5-1') =>
  line({ type: 'assistant', requestId: req, timestamp: ts, message: { id, model, usage, content: [{ type: 'text', text: 'héllo ✓' }] } });

test('counts streaming duplicates and resumed copies once', () => {
  const p = new EventParser();
  const ts = new Date().toISOString();
  const a = p.parseLine(asst('m1', 'r1', ts, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000 }));
  const b = p.parseLine(asst('m1', 'r1', ts, { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 1000 }));
  const c = p.parseLine(asst('m1', 'r1', ts, { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 1000 }));
  assert.ok(a && b);
  assert.equal(c, null, 'exact repeat adds nothing');
  assert.equal(a!.tokens.output + b!.tokens.output, 50);
  assert.equal(b!.tokens.input, 0);
  assert.equal(p.parseLine(line({ type: 'user', message: { content: 'hi' } })), null);
  assert.equal(p.parseLine(asst('m2', 'r2', ts, { input_tokens: 1 }, '<synthetic>')), null);
  assert.equal(p.parseLine('{not json'), null);
});

test('splits 5m and 1h cache writes when the breakdown is present', () => {
  const p = new EventParser();
  const e = p.parseLine(asst('m3', 'r3', new Date().toISOString(), {
    input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 300,
    cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
  }));
  assert.equal(e!.tokens.cacheWrite5m, 100);
  assert.equal(e!.tokens.cacheWrite1h, 200);
  assert.equal(e!.wu, (100 * 12.5 + 200 * 20) / 1e6);
});

test('tails files incrementally, handles half-written lines and skips old files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cul-'));
  const proj = path.join(dir, 'projects', 'C--Users-me-repo');
  fs.mkdirSync(path.join(proj, 'sess', 'subagents'), { recursive: true });
  const f = path.join(proj, 's1.jsonl');
  const now = Date.now();
  const ts = new Date(now - 1000).toISOString();

  const l1 = asst('a', 'r', ts, { input_tokens: 100, output_tokens: 10 });
  const l2 = asst('b', 'r', ts, { input_tokens: 200, output_tokens: 20 });
  // write line 1 fully and line 2 cut in the middle of a multi-byte character
  const b2 = Buffer.from(l2 + '\n', 'utf8');
  const cut = b2.indexOf(Buffer.from('é')) + 1;
  fs.writeFileSync(f, Buffer.concat([Buffer.from(l1 + '\n'), b2.subarray(0, cut)]));

  // subagent log in a nested folder
  fs.writeFileSync(path.join(proj, 'sess', 'subagents', 'agent-1.jsonl'), asst('c', 'r', ts, { output_tokens: 7 }, 'claude-haiku-5-5') + '\n');

  // an old file that should be ignored
  const old = path.join(proj, 'old.jsonl');
  fs.writeFileSync(old, asst('z', 'r', new Date(now - 30 * 864e5).toISOString(), { output_tokens: 999 }) + '\n');
  const t = (now - 30 * 864e5) / 1000; fs.utimesSync(old, t, t);

  const tailer = new LogTailer(() => path.join(dir, 'projects'), 8 * 864e5);
  const first = tailer.scan(now);
  assert.deepEqual(first.map(e => e.tokens.output).sort((x, y) => x - y), [7, 10]);

  fs.appendFileSync(f, b2.subarray(cut));
  const second = tailer.scan(now);
  assert.equal(second.length, 1);
  assert.equal(second[0].tokens.output, 20, 'line completed later is parsed intact');
  assert.equal(tailer.scan(now).length, 0, 'nothing new');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('marks the first event of each request, so streamed and resumed lines are not counted as requests', () => {
  const p = new EventParser();
  const ts = new Date().toISOString();
  const a = p.parseLine(asst('m1', 'r1', ts, { input_tokens: 10, output_tokens: 5 }));
  const b = p.parseLine(asst('m1', 'r1', ts, { input_tokens: 10, output_tokens: 50 }));
  const c = p.parseLine(asst('m2', 'r2', ts, { input_tokens: 7, output_tokens: 1 }));
  assert.deepEqual([a?.first, b?.first, c?.first], [true, false, true]);
  // a leading all-zero line adds nothing, so the request counts on its first line that does
  assert.equal(p.parseLine(asst('m3', 'r3', ts, { input_tokens: 0, output_tokens: 0 })), null);
  assert.equal(p.parseLine(asst('m3', 'r3', ts, { input_tokens: 4, output_tokens: 2 }))?.first, true);
  assert.equal(p.parseLine(asst('m3', 'r3', ts, { input_tokens: 4, output_tokens: 9 }))?.first, false);
  // a resumed copy that grew is the same request
  assert.equal(p.parseLine(asst('m1', 'r1', ts, { input_tokens: 10, output_tokens: 60 }))?.first, false);
});

const realFs = require('fs') as typeof import('fs'); // the module object itself, so its methods can be mocked

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tkm-'));
  const proj = path.join(dir, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  return { dir, proj, projects: () => path.join(dir, 'projects') };
}
const usageLine = (i: number, ts: string, extra = '') =>
  line({ type: 'assistant', requestId: `r${i}`, timestamp: ts, message: { id: `m${i}`, model: 'claude-fable-5-1', usage: { input_tokens: 1, output_tokens: i + 1 }, content: [{ type: 'text', text: extra }] } });

test('reads a 10 MB file in chunks, growing the read for a line longer than a chunk', () => {
  const { dir, proj, projects } = tmpProject();
  const ts = new Date().toISOString();
  const big = 'A'.repeat(6 << 20); // a 6 MB screenshot: one line, longer than the 4 MB chunk
  const lines: string[] = [];
  for (let i = 0; i < 6000; i++) lines.push(usageLine(i, ts), line({ type: 'user', message: { content: 'x'.repeat(200) } }));
  lines.splice(5000, 0, line({ type: 'user', message: { content: [{ type: 'image', data: big }] } }), usageLine(9000, ts, big));
  fs.writeFileSync(path.join(proj, 's.jsonl'), lines.join('\n') + '\n');
  assert.ok(fs.statSync(path.join(proj, 's.jsonl')).size > 10 << 20);
  const tailer = new LogTailer(projects, 8 * 864e5);
  const evs = tailer.scan();
  assert.equal(evs.length, 6001);
  assert.equal(evs.filter(e => e.tokens.output === 9001).length, 1, 'the long usage line is parsed');
  assert.equal(tailer.scan().length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('skips a line over the cap and keeps the lines around it, even while it is still being written', () => {
  const { dir, proj, projects } = tmpProject();
  const ts = new Date().toISOString();
  const f = path.join(proj, 's.jsonl');
  const logs: string[] = [];
  const tailer = new LogTailer(projects, 8 * 864e5, undefined, { chunkBytes: 64, maxLineBytes: 1024, log: m => logs.push(m) });
  fs.writeFileSync(f, `${usageLine(1, ts)}\n${usageLine(2, ts, 'z'.repeat(3000))}\n${usageLine(3, ts)}\n`);
  assert.deepEqual(tailer.scan().map(e => e.tokens.output), [2, 4]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Skipped a log line over/);
  // an over-long line still being written: skipped as it grows, and the line after it is read
  fs.appendFileSync(f, usageLine(4, ts, 'y'.repeat(3000)).slice(0, 2500));
  assert.deepEqual(tailer.scan(), []);
  fs.appendFileSync(f, `${usageLine(4, ts, 'y'.repeat(3000)).slice(2500)}\n${usageLine(5, ts)}\n`);
  assert.deepEqual(tailer.scan().map(e => e.tokens.output), [6]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a file that cannot be opened costs no other file its events, and is read once it can be', () => {
  const { dir, proj, projects } = tmpProject();
  const ts = new Date().toISOString();
  const bad = path.join(proj, 'bad.jsonl'), good = path.join(proj, 'good.jsonl');
  fs.writeFileSync(bad, `${usageLine(1, ts)}\n${usageLine(2, ts)}\n`);
  fs.writeFileSync(good, `${usageLine(3, ts)}\n`);
  const logs: string[] = [];
  const tailer = new LogTailer(projects, 8 * 864e5, undefined, { log: m => logs.push(m) });
  const open = realFs.openSync;
  const m = mock.method(realFs, 'openSync', (p: fs.PathLike, ...rest: any[]) => {
    if (String(p) === bad) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return (open as any)(p, ...rest);
  });
  try {
    assert.deepEqual(tailer.scan().map(e => e.tokens.output), [4]);
    assert.deepEqual(tailer.scan(), []);
    assert.equal(logs.length, 1, 'logged once, not on every scan');
  } finally { m.mock.restore(); }
  assert.deepEqual(tailer.scan().map(e => e.tokens.output).sort(), [2, 3]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a read that fails partway keeps what was parsed and resumes right after it', () => {
  const { dir, proj, projects } = tmpProject();
  const ts = new Date().toISOString();
  const lines = Array.from({ length: 8 }, (_, i) => usageLine(i, ts));
  fs.writeFileSync(path.join(proj, 's.jsonl'), lines.join('\n') + '\n');
  const tailer = new LogTailer(projects, 8 * 864e5, undefined, { chunkBytes: lines[0].length * 2 + 10 });
  const read = realFs.readSync;
  let calls = 0;
  const m = mock.method(realFs, 'readSync', (...args: any[]) => {
    if (++calls === 3) throw new Error('EIO: i/o error');
    return (read as any)(...args);
  });
  let first: number[];
  try { first = tailer.scan().map(e => e.tokens.output); } finally { m.mock.restore(); }
  assert.ok(first.length >= 2 && first.length < 8, `${first.length} before the failure`);
  const rest = tailer.scan().map(e => e.tokens.output);
  assert.deepEqual([...first, ...rest], [1, 2, 3, 4, 5, 6, 7, 8], 'each line exactly once, in order');
  fs.rmSync(dir, { recursive: true, force: true });
});
