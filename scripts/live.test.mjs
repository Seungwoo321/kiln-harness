import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fit, mmss, createLive, createActivity, createTicker, colorOn, paintLine, elapsedStyle, logLine } from './lib/live.mjs';

const ev = (content, out = 0) => `${JSON.stringify({ type: 'assistant', message: { content, usage: { output_tokens: out } } })}\n`;

test('한글은 두 칸으로 세어 터미널 폭을 넘지 않게 자른다', () => {
  assert.equal(fit('abcdef', 10), 'abcdef');
  assert.ok([...fit('가나다라마바사아자차', 11)].length <= 6);
  assert.ok(fit('가나다라마바사아자차', 11).endsWith('…'));
  assert.equal(mmss(125), '02:05');
});

test('로그를 이어 읽으며 도구 호출·토큰·최근 활동을 요약한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kh-live-')); const log = join(dir, 'a.log');
  writeFileSync(log, ev([{ type: 'tool_use', name: 'Read', input: { file_path: `${dir}/extract/p.json` } }], 10));
  const act = createActivity(dir);
  assert.deepEqual(act(log).tools, ['Read extract/p.json']);
  appendFileSync(log, ev([{ type: 'tool_use', name: 'Bash', input: { command: 'git -C /r show abc:x' } }, { type: 'tool_use', name: 'Write', input: { file_path: `${dir}/stages/o.json` } }], 5));
  appendFileSync(log, '{"type":"result","subtype":"succ'); // 아직 덜 쓰인 줄은 다음 틱에 읽는다
  const s = act(log);
  assert.equal(s.toolCount, 3); assert.equal(s.outTokens, 15);
  assert.deepEqual(s.tools, ['Read extract/p.json', 'Bash git -C /r show abc:x', 'Write stages/o.json']);
  appendFileSync(log, 'ess"}\n'); assert.equal(act(log).toolCount, 3);
  appendFileSync(log, ev([{ type: 'tool_use', name: 'StructuredOutput', input: {} }]));
  assert.deepEqual(act(log).tools.at(-1), '결과 보고'); assert.equal(act(log).tools.length, 3);
});

test('codex 처럼 JSON 이 아닌 로그는 마지막 줄을 보여 준다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kh-live-')); const log = join(dir, 'c.log');
  writeFileSync(log, 'exec\nsed -n 1,40p foo.md\n');
  assert.equal(createActivity(dir)(log).text, 'sed -n 1,40p foo.md');
});

test('TTY 가 아니면 블록을 그리지 않고 1분마다 한 줄 신호만 낸다', () => {
  const out = []; const live = createLive({ isTTY: false, write: (s) => out.push(s) });
  const dir = mkdtempSync(join(tmpdir(), 'kh-live-'));
  const tk = createTicker({ live, root: dir, overview: () => ({ level: 5, startedAt: Date.now(), stages: [], totals: { calls: 0, tokens: 0, costUsd: 0 } }) });
  const t = (elapsedSec) => tk.tick({ stage: 'interpret', attempt: 1, max: 3, cfg: { runner: 'claude' }, logFile: join(dir, 'x.log'), elapsedSec });
  t(10); t(61); t(90); t(125);
  assert.equal(out.length, 2); assert.ok(out[0].includes('진행 중') && out[0].includes('01:01'));
});

test('TTY 에서는 같은 자리를 지우고 다시 그리며, 영구 로그는 블록을 지우고 찍는다', () => {
  const out = []; const live = createLive({ isTTY: true, columns: 80, write: (s) => out.push(s) });
  live.draw(['a', 'b']); live.draw(['c']); live.print('[x] done');
  assert.ok(out.some((s) => s.includes('\x1b[2A')) && out.some((s) => s.includes('\x1b[1A')));
  assert.equal(out.at(-1), '[x] done\n');
});

test('색은 TTY 에서만 켜고 NO_COLOR 면 끈다. 꺼지면 색 코드가 없다', () => {
  assert.equal(colorOn({ isTTY: true }, {}), true);
  assert.equal(colorOn({ isTTY: false }, {}), false);
  assert.equal(colorOn({ isTTY: true }, { NO_COLOR: '1' }), false);
  assert.equal(colorOn({ isTTY: false }, { FORCE_COLOR: '1' }), true);
  assert.equal(paintLine(false, [['abc', 'red'], ['def', 'bold']], 40), 'abcdef');
  assert.equal(logLine(false, 'S1', '통과 (1회째)'), '[S1] 통과 (1회째)');
});

test('색을 입혀도 보이는 폭은 cols 를 넘지 않고, 경과 시간은 길수록 경고색이다', () => {
  const strip = (x) => x.replace(/\x1b\[[0-9;]*m/g, '');
  const line = paintLine(true, [['가나다라마바사아자차', 'green'], ['abcdefghij', 'red']], 14);
  assert.ok(line.includes('\x1b[32m'));
  assert.ok([...strip(line)].reduce((n, ch) => n + (ch.codePointAt(0) >= 0xac00 ? 2 : 1), 0) <= 13);
  assert.deepEqual([elapsedStyle(60), elapsedStyle(400), elapsedStyle(1000)], ['green', 'yellow', 'red']);
  assert.ok(logLine(true, 'S3', '에이전트 실행 실패: x').includes('\x1b[31m'));
});
