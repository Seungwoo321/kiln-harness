// 같은 입력 → 같은 출력: register·extract 를 임시 사례로 두 번 돌려 digest 가 같은지 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { register, canonical } from './register.mjs';
import { extract } from './extract.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kh-'));
  const html = join(dir, 'plan.html');
  writeFileSync(html, '<title>T</title>\n<h1>설정</h1>\n<div id="panel-a" data-panel="a"></div>\n<script>/* ── 알림 ── */ SCREENS[\'ops.x\'] = 1;</script>\n');
  const md = join(dir, 'ctx.md');
  writeFileSync(md, '# 주제\n## 범위\n- 항목\n| a | b |\n');
  writeFileSync(join(dir, 'inputs.json'), JSON.stringify({
    caseId: 't',
    inputs: [
      { id: 'p', kind: 'plan-html', role: 'plan', path: html },
      { id: 'c', kind: 'context-doc', role: 'context', path: md },
    ],
  }));
  return dir;
}

test('canonical 은 키 순서와 무관하다', () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), canonical({ a: [2, { c: 4, d: 3 }], b: 1 }));
});

test('register·extract 는 반복 실행해도 같은 digest 를 낸다', () => {
  const dir = fixture();
  const first = [register(dir).digest, extract(dir).map((x) => x.digest)];
  const snapshot = readFileSync(join(dir, 'extract', 'p.json'), 'utf8');
  const second = [register(dir).digest, extract(dir).map((x) => x.digest)];
  assert.deepEqual(first, second);
  assert.equal(readFileSync(join(dir, 'extract', 'p.json'), 'utf8'), snapshot);
});

test('html 앵커는 라우트 키·주석 마커·data-panel 을 잡는다', () => {
  const dir = fixture();
  register(dir);
  extract(dir);
  const types = JSON.parse(readFileSync(join(dir, 'extract', 'p.json'), 'utf8')).anchors.map((a) => `${a.type}:${a.value}`);
  for (const t of ['screen-key:ops.x', 'comment-marker:알림', 'data-panel:a', 'id:panel-a', 'h1:설정']) assert.ok(types.includes(t), t);
});
