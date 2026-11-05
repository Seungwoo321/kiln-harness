import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { exportGoal } from './export-goal.mjs';
import { canonical, sha256 } from './register.mjs';

const plan = () => ({
  caseId: 'fx', title: '목록 개선', summary: '목록에 필터를 더한다', inputDigests: ['d1'],
  requirements: [
    { id: 'R1', surface: 'S1', statement: 's', acceptance: ['필터를 고르면 목록이 줄어든다', '"전체" 는 필터를 푼다'] },
    { id: 'R2', surface: 'S1', statement: 's', acceptance: ['빈 목록이면 안내가 보인다'] },
  ],
  tasks: [
    { id: 'T2', title: '화면', files: ['b.tsx'], dependsOn: ['T1'], covers: ['R1', 'R2'], changeKind: 'feature-change', ticket: 'X-1' },
    { id: 'T1', title: '부품', files: ['a.tsx'], dependsOn: [], covers: ['C1'], changeKind: 'ds-component-edit' },
  ],
  questions: [{ id: 'Q-01' }],
});

function fixture({ status = 'passed', edit } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kh-goal-'));
  const p = plan();
  writeFileSync(join(dir, 'workplan.json'), JSON.stringify(p));
  writeFileSync(join(dir, 'run-status.json'), JSON.stringify({ result: status, workplanDigest: sha256(canonical(p)) }));
  writeFileSync(join(dir, 'decisions.json'), JSON.stringify({ decisions: [{ id: 'Q-01', stance: 'decided', note: 'n', itemDigest: 'x' }] }));
  if (edit) writeFileSync(join(dir, 'workplan.json'), JSON.stringify({ ...p, title: '바뀜' }));
  return dir;
}

test('목표 내보내기: 수용 기준은 계획서 문장 그대로, 단위는 의존 순서, 참조는 digest 와 함께', () => {
  const dir = fixture(); const g = exportGoal(dir);
  assert.equal(g.objective, '목록 개선');
  assert.deepEqual(g.criteria.map((c) => c.text), ['필터를 고르면 목록이 줄어든다', '"전체" 는 필터를 푼다', '빈 목록이면 안내가 보인다']);
  assert.deepEqual(g.criteria[0].units, ['T2']);
  assert.deepEqual(g.units.map((u) => [u.order, u.id]), [[1, 'T1'], [2, 'T2']]);
  assert.deepEqual(g.units[0].acceptance, []); // 요구사항을 덮지 않는 단위의 기준을 지어내지 않는다
  assert.deepEqual(g.units[1].acceptance.map((a) => a.text), g.criteria.map((c) => c.text));
  assert.equal(g.references.workplan.digest, sha256(canonical(plan())));
  assert.equal(g.references.decisions.count, 1);
  assert.deepEqual(g.openQuestions, ['Q-01']);
  assert.deepEqual(exportGoal(dir), g); // 같은 입력이면 같은 출력
});

test('목표 내보내기: 통과하지 않았거나 통과 뒤 계획서가 바뀌었으면 거부한다', () => {
  assert.throws(() => exportGoal(fixture({ status: 'failed' })), /승인된 분석이 아니다/);
  assert.throws(() => exportGoal(fixture({ edit: true })), /승인된 분석이 아니다/);
});

test('목표 내보내기: CLI 는 --out 으로 파일을 쓰고 실패하면 비정상 종료한다', () => {
  const dir = fixture(); const out = join(dir, 'goal.json');
  execFileSync(process.execPath, [join(import.meta.dirname, 'export-goal.mjs'), dir, '--out', out]);
  assert.equal(JSON.parse(execFileSync('cat', [out], { encoding: 'utf8' })).kind, 'WorkGoalExport');
  assert.throws(() => execFileSync(process.execPath, [join(import.meta.dirname, 'export-goal.mjs'), fixture({ status: 'failed' })], { stdio: 'pipe' }));
});
