import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProfile, profileById, profileForPlan, DEFAULT_PURPOSE } from './lib/profile.mjs';

test('목적 프로파일: purpose 가 없으면 기본, 있으면 그것, 모르는 값은 거부', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kh-profile-'));
  assert.equal(loadProfile(dir).id, DEFAULT_PURPOSE);
  writeFileSync(join(dir, 'inputs.json'), JSON.stringify({ caseId: 'x', purpose: 'fe-workplan', inputs: [] }));
  assert.equal(loadProfile(dir).id, 'fe-workplan');
  writeFileSync(join(dir, 'inputs.json'), JSON.stringify({ caseId: 'x', purpose: 'no-such', inputs: [] }));
  assert.throws(() => loadProfile(dir), /알 수 없는 목적 프로파일 — no-such/);
});

test('계획서는 kind 로 프로파일을 찾는다 — kind 가 없으면 기본, 모르는 kind 는 거부', () => {
  assert.equal(profileForPlan({ kind: 'WorkPlan' }).id, 'fe-workplan');
  assert.equal(profileForPlan(null).id, DEFAULT_PURPOSE);
  assert.throws(() => profileForPlan({ kind: 'Nope' }), /kind 에 맞는 프로파일이 없음/);
});

// 엔진은 프로파일 계약만 호출한다 — 분류 단위·항목 섹션 이름을 직접 쓰면 다른 목적 프로파일이 같은 엔진을 쓸 수 없다.
test('엔진 코드는 프로파일의 단위·항목 섹션 이름을 직접 참조하지 않는다', () => {
  const p = profileById('fe-workplan');
  const names = [...p.sections, p.unit.ref];
  const engine = ['run.mjs', 'lib/pipeline.mjs', 'lib/triage.mjs', 'decide.mjs', 'lineage.mjs', 'catalog.mjs', 'lib/levels.mjs', 'lib/profile.mjs'];
  for (const f of engine) {
    const code = readFileSync(new URL(f, import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    for (const n of names) assert.ok(!new RegExp(`\\b${n}\\b`).test(code), `${f} 가 ${n} 를 직접 참조한다`);
  }
});
