import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate } from './validate.mjs';
import { decide, remove, staleDecisions } from './decide.mjs';
import { renderReview } from './render-review.mjs';

const ref = [{ sourceId: 'plan1', locator: 'L1-2' }];
const basePlan = () => ({
  schemaVersion: 2, kind: 'WorkPlan', caseId: 'fx', inputDigests: ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)], title: 'T', summary: 'S',
  surfaces: [{ id: 'S1', title: '화면', entry: '/x', change: 'new', sourceRefs: ref }], excluded: [],
  requirements: [{ id: 'R1', surface: 'S1', statement: '요구', acceptance: ['a'], basis: 'source', sourceRefs: ref }],
  states: [{ id: 'ST1', surface: 'S1', region: 'r', state: 's', condition: 'c', display: 'd', basis: 'source', sourceRefs: ref }],
  components: [{ id: 'C1', surface: 'S1', name: 'A', file: 'src/a.tsx', fileStatus: 'existing', ds: { component: 'Btn', match: 'exact', reason: '같다' }, sourceRefs: ref }],
  apiBindings: [{ id: 'A1', operationId: 'getX', surface: 'S1', component: 'C1', trigger: 'load', request: '-', response: '-', errors: '-', sourceRefs: ref }],
  i18n: [], gaps: [{ id: 'G1', surface: 'S1', current: 'c', target: 't' }],
  questions: [{ id: 'Q1', to: 'plan', question: '?', options: [], assumption: 'x', impact: ['R1'], kind: 'confirm', claimType: 'wrong', evidence: '잘못됨', sourceRefs: [{ sourceId: 'plan1', locator: '화면제목' }] }],
  tasks: [{ id: 'T1', title: '작업 <b>', files: ['src/a.tsx'], dependsOn: [], covers: ['S1', 'C1', 'A1', 'R1', 'ST1', 'G1'], changeKind: 'new-page' }],
  findings: [{ id: 'F1', severity: 'high', origin: 'design', target: 'R1', message: '<script>alert(1)</script>', recommendation: '확인', stance: 'ask-design' }],
});

function fixture(mutate = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kh-'));
  mkdirSync(join(dir, 'extract'));
  const sources = [
    { id: 'plan1', role: 'plan', sha256: 'a'.repeat(64) },
    { id: 'fe', role: 'implementation', sha256: 'b'.repeat(64) },
    { id: 'api', role: 'contract', sha256: 'c'.repeat(64) },
  ];
  writeFileSync(join(dir, 'sources.json'), JSON.stringify({ caseId: 'fx', sources }));
  writeFileSync(join(dir, 'extract', 'plan1.json'), JSON.stringify({ anchors: [{ type: 'h1', value: '화면제목', line: 1 }] }));
  writeFileSync(join(dir, 'extract', 'fe.json'), JSON.stringify({ anchors: [{ type: 'file', value: 'src/a.tsx' }] }));
  writeFileSync(join(dir, 'extract', 'api.json'), JSON.stringify({ anchors: [{ type: 'operation', value: 'getX' }] }));
  const plan = basePlan(); mutate(plan);
  writeFileSync(join(dir, 'workplan.json'), JSON.stringify(plan));
  return dir;
}

test('v2 정상 계획서는 통과한다', () => assert.deepEqual(validate(fixture()), []));
test('changeKind 가 없으면 막힌다', () => assert.ok(validate(fixture((p) => delete p.tasks[0].changeKind)).some((e) => e.includes('changeKind'))));
test('new-page 는 새 화면을 다뤄야 한다', () => {
  const errs = validate(fixture((p) => { p.surfaces[0].change = 'changed'; }));
  assert.ok(errs.some((e) => e.includes('change:new')));
});
test('api-wiring 은 apiBinding 을 다뤄야 한다', () => {
  const errs = validate(fixture((p) => { p.tasks[0].changeKind = 'api-wiring'; p.tasks[0].covers = ['S1', 'C1', 'A1']; p.tasks[0].covers = ['C1', 'S1']; p.apiBindings = []; }));
  assert.ok(errs.some((e) => e.includes('api-wiring')));
});
test('지적의 target 이 없으면 막힌다', () => assert.ok(validate(fixture((p) => { p.findings[0].target = 'NOPE'; })).some((e) => e.includes('target'))));
test('v1 계획서는 v2 규칙을 받지 않는다', () => assert.deepEqual(validate(fixture((p) => { p.schemaVersion = 1; delete p.tasks[0].changeKind; delete p.findings; })), []));

test('결정은 기록되고, 없는 id 는 거부되며, 항목이 바뀌면 stale 로 드러난다', () => {
  const dir = fixture();
  decide(dir, 'R1', 'follow-existing', '기존 패턴 따름');
  assert.deepEqual(validate(dir), []);
  assert.throws(() => decide(dir, 'ZZ', 'decided', 'x'), /없는 id/);
  assert.throws(() => decide(dir, 'R1', 'bogus', 'x'), /stance/);
  const plan = JSON.parse(readFileSync(join(dir, 'workplan.json'), 'utf8'));
  assert.equal(staleDecisions(dir, plan).length, 0);
  plan.requirements[0].statement = '바뀐 요구';
  assert.equal(staleDecisions(dir, plan).length, 1);
  remove(dir, 'R1');
  assert.equal(JSON.parse(readFileSync(join(dir, 'decisions.json'), 'utf8')).decisions.length, 0);
});

test('지적·작업에 대한 결정을 같은 id 의 결정 기록으로 이어받으면 stale 이 아니고, 결정 기록에 직접 한 결정은 바뀌면 stale 이다', () => {
  const dir = fixture();
  const plan = JSON.parse(readFileSync(join(dir, 'workplan.json'), 'utf8'));
  plan.findings[0].id = 'F-001'; writeFileSync(join(dir, 'workplan.json'), JSON.stringify(plan));
  decide(dir, 'F-001', 'decided', '원본대로 한다');
  assert.equal(JSON.parse(readFileSync(join(dir, 'decisions.json'), 'utf8')).decisions[0].section, 'findings');
  const record = { id: 'F-001', kind: 'answered-by-source', statement: '원본대로 한다', rationale: '사용자 결정', sourceRefs: [] };
  const rerun = { ...plan, findings: [], decisions: [record] };
  assert.deepEqual(staleDecisions(dir, rerun), []);
  const legacy = JSON.parse(readFileSync(join(dir, 'decisions.json'), 'utf8')); delete legacy.decisions[0].section; // section 없는 이전 기록
  writeFileSync(join(dir, 'decisions.json'), JSON.stringify(legacy));
  assert.deepEqual(staleDecisions(dir, rerun), []);
  assert.equal(staleDecisions(dir, { ...plan, findings: [{ ...plan.findings[0], message: '바뀐 지적' }] }).length, 1, '지적이 지적으로 남아 바뀌면 stale');
  decide(dir, 'T1', 'decided', '작업을 결정으로 둔다'); // 작업에 대한 결정도 결정 기록으로 이어받으면 stale 이 아니다
  assert.deepEqual(staleDecisions(dir, { ...rerun, tasks: [], decisions: [record, { ...record, id: 'T1' }] }), []);
  remove(dir, 'T1');
  writeFileSync(join(dir, 'workplan.json'), JSON.stringify(rerun));
  decide(dir, 'F-001', 'decided', '결정 기록을 다시 확인');
  assert.equal(staleDecisions(dir, { ...rerun, decisions: [{ ...record, statement: '바뀐 결정' }] }).length, 1, '결정 기록에 직접 한 결정은 바뀌면 stale');
});

test('검토 HTML 은 결정적이고, id 앵커가 있고, 입력을 이스케이프한다', () => {
  const dir = fixture();
  decide(dir, 'F1', 'ask-design', '디자이너 확인');
  const a = renderReview(dir); const b = renderReview(dir);
  assert.equal(a, b);
  assert.ok(a.includes('id="R1"') && a.includes('id="F1"'));
  assert.ok(!a.includes('<script>alert(1)</script>'));
  assert.ok(a.includes('&lt;script&gt;') && a.includes('디자이너 확인'));
});

test('한 시안의 적합성 결과는 전체 시안 목록의 부분집합이면 표시한다', t => {
  const dir = fixture(p => { p.designSpecDigests = ['design-a', 'design-b']; });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [digest, expected] of [['design-a', true], ['stale-design', false]]) {
    writeFileSync(join(dir, 'conformance.json'), JSON.stringify({ inputDigests: [digest], rows: [], status: 'passed' }));
    assert.equal(renderReview(dir).includes('id="sec-conformance"'), expected);
  }
});
