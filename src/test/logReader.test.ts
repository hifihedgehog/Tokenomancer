import { test } from 'node:test';
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
