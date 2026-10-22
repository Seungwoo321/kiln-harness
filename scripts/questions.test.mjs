import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPipeline } from './lib/pipeline.mjs';
import { validate } from './validate.mjs';
import { register } from './register.mjs';
import { extract } from './extract.mjs';

// 계약이 이미 정의한 것을 "원본에 정의가 없다"고 주장하는 질문이 만들어지는 경우를 재현한다.
const PLAN = `<html><body>\n<h1 id="a">내보내기 설정</h1>\n<p>형식 4종: CSV PDF XLSX JSON</p>\n<p>JSON 옵션: 들여쓰기, 인코딩</p>\n</body></html>\n`;
const CONTRACT = `# 내보내기 계약\n\n## ExportFormat\n\nCSV, PDF, XLSX, JSON 은 정식 형식이다.\n\n## option_schema\n\n옵션 정의는 모든 형식과 같이 서버가 내려준다. 미설정 형식도 정의를 제공한다.\n`;
const ref = [{ sourceId: 'plan1', locator: 'L3-4' }];
const specRef = { sourceId: 'spec', locator: 'option_schema' };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kh-q-'));
  writeFileSync(join(dir, 'plan.html'), PLAN); writeFileSync(join(dir, 'contract.md'), CONTRACT);
  writeFileSync(join(dir, 'inputs.json'), JSON.stringify({ caseId: 'fx', inputs: [
    { id: 'plan1', kind: 'plan-html', role: 'plan', path: join(dir, 'plan.html') },
    { id: 'spec', kind: 'context-doc', role: 'context', path: join(dir, 'contract.md') },
  ] }));
  return dir;
}
const notice = (over = {}) => ({ id: 'Q1', kind: 'notice', to: 'backend', question: 'JSON 옵션 키는 원본에 정의가 없어 개발이 정했다', options: [], assumption: 'indent·encoding 으로 정했다', impact: ['R2'], sourceRefs: ref, searched: [{ sourceId: 'plan1', scope: '전체' }, { sourceId: 'spec', scope: '전체' }], ...over });
const confirm = (over = {}) => ({ id: 'Q2', kind: 'confirm', claimType: 'mismatch', to: 'plan', question: '기획과 계약의 형식 수가 다르다', options: [], assumption: '계약을 따른다', impact: ['R1'], sourceRefs: [...ref, { sourceId: 'spec', locator: 'ExportFormat' }], ...over });
const scopeOut = () => ({ surfaces: [{ id: 'S1', title: '화면', entry: '/x', change: 'new', sourceRefs: ref }], excluded: [{ title: '계약', reason: '입력 문서', sourceRefs: [{ sourceId: 'spec', locator: 'ExportFormat' }] }] });
const draft = (questions = [notice()], extra = {}) => ({
  title: 'T', summary: 'S', newFiles: [], surfaces: scopeOut().surfaces, excluded: scopeOut().excluded,
  requirements: [
    { id: 'R1', surface: 'S1', statement: '형식 4종', acceptance: ['a'], basis: 'source', sourceRefs: ref },
    { id: 'R2', surface: 'S1', statement: 'JSON 옵션을 그린다', acceptance: ['a'], basis: 'inferred', question: 'Q1', sourceRefs: [] },
  ],
  states: [{ id: 'ST1', surface: 'S1', region: 'r', state: 's', condition: 'c', display: 'd', basis: 'source', sourceRefs: ref }],
  components: [{ id: 'C1', surface: 'S1', name: 'A', file: 'src/a.tsx', fileStatus: 'new', ds: { component: null, match: 'custom', reason: '없다' }, sourceRefs: ref }],
  apiBindings: [], i18n: [], gaps: [{ id: 'G1', surface: 'S1', current: 'c', target: 't' }], questions, decisions: [],
  tasks: [{ id: 'T1', title: '작업', files: ['src/a.tsx'], dependsOn: [], covers: ['S1', 'C1', 'R1', 'R2', 'ST1', 'G1'], changeKind: 'new-page' }],
  ...extra,
});
const prepared = (questions, extra) => { const dir = fixture(); register(dir); extract(dir); return { dir, body: draft(questions, extra) }; };
const errs = (questions, extra, mutate) => {
  const c = prepared(questions, extra);
  const plan = { schemaVersion: 2, kind: 'WorkPlan', caseId: 'fx', inputDigests: JSON.parse(readFileSync(join(c.dir, 'sources.json'), 'utf8')).sources.map((s) => s.sha256), ...c.body, findings: [] };
  mutate?.(plan);
  return validate(c.dir, plan);
};

// ── 질문(notice) ────────────────────────────────────────────────────────────
test('근거·찾아본 범위가 갖춰진 notice 는 통과한다', () => assert.deepEqual(errs([notice()]), []));
test('질문 종류가 없거나 모르는 종류면 막힌다', () => {
  assert.ok(errs([notice({ kind: undefined })]).some((e) => e.includes('kind')));
  assert.ok(errs([notice({ kind: 'ambiguous' })]).some((e) => e.includes('kind')));
});
test('notice 는 질문을 낳은 원본 위치가 있어야 하고 locator 는 실재해야 한다', () => {
  assert.ok(errs([notice({ sourceRefs: [] })]).some((e) => e.includes('sourceRefs 가 비었음')));
  assert.ok(errs([notice({ sourceRefs: [{ sourceId: 'plan1', locator: 'L90-99' }] })]).some((e) => e.includes('원본(')));
  assert.ok(errs([notice({ sourceRefs: [{ sourceId: 'plan1', locator: '#없는요소' }] })]).some((e) => e.includes('원본에 없는 locator')));
  assert.deepEqual(errs([notice({ sourceRefs: [{ sourceId: 'plan1', locator: '#a' }, specRef] })]), []);
});
test("notice 는 '정의가 없다'는 주장이므로 찾아본 범위에 계약·context 를 포함해야 한다", () => {
  assert.ok(errs([notice({ searched: undefined })]).some((e) => e.includes('어느 원본을 찾아봤는지')));
  assert.ok(errs([notice({ searched: [{ sourceId: 'plan1', scope: '전체' }] })]).some((e) => e.includes('원본 spec(context)를 찾아본 범위에 포함')));
  assert.ok(errs([notice({ searched: [{ sourceId: 'plan1', scope: '' }, { sourceId: 'spec', scope: '전체' }] })]).some((e) => e.includes('scope')));
});

// ── 질문(confirm) ───────────────────────────────────────────────────────────
test('confirm(mismatch)은 서로 다른 두 원본의 위치가 필요하다', () => {
  assert.deepEqual(errs([notice(), confirm()]), []);
  assert.ok(errs([notice(), confirm({ sourceRefs: [...ref, { sourceId: 'plan1', locator: 'L1-2' }] })]).some((e) => e.includes('서로 다른 두 원본')));
  assert.ok(errs([notice(), confirm({ sourceRefs: ref })]).some((e) => e.includes('서로 다른 두 원본')));
});
test('confirm(wrong·pattern)은 근거(evidence)가 필요하다', () => {
  assert.ok(errs([notice(), confirm({ claimType: 'wrong', evidence: undefined, sourceRefs: ref })]).some((e) => e.includes('evidence')));
  assert.deepEqual(errs([notice(), confirm({ claimType: 'wrong', evidence: '계약 L? 와 모순', sourceRefs: ref })]), []);
  assert.deepEqual(errs([notice(), confirm({ claimType: 'pattern', evidence: '기존 화면은 모달', sourceRefs: ref })]), []);
});
test('confirm 은 주장 종류가 필요하다', () => assert.ok(errs([notice(), confirm({ claimType: 'ambiguous' })]).some((e) => e.includes('claimType'))));
test('추론 항목은 kind=notice 질문을 가리켜야 한다', () => {
  assert.ok(errs([confirm({ id: 'Q1' })]).some((e) => e.includes('kind=notice')));
  assert.ok(errs([], undefined).some((e) => e.includes('question 이 없거나')));
});

// ── 결정(원본이 이미 답한 것) ───────────────────────────────────────────────
const decision = (over = {}) => ({ id: 'D-01', kind: 'answered-by-source', statement: 'JSON 은 정식 형식', rationale: '계약이 정의한다', sourceRefs: [specRef], ...over });
test('decisions: 근거·sourceRefs 가 갖춰지면 통과하고, 기준에 어긋나면 막힌다', () => {
  assert.deepEqual(errs([notice()], { decisions: [decision()] }), []);
  assert.ok(errs([notice()], { decisions: [decision({ sourceRefs: [] })] }).some((e) => e.includes('sourceRefs 가 비었음')));
  assert.ok(errs([notice()], { decisions: [decision({ rationale: '' })] }).some((e) => e.includes('rationale')));
  assert.ok(errs([notice()], { decisions: [decision({ sourceRefs: [{ sourceId: 'spec', locator: '없는절' }] })] }).some((e) => e.includes('원본에 없는 locator')));
  assert.ok(errs([notice()], { decisions: [decision({ kind: 'sources-agree' })] }).some((e) => e.includes('서로 다른 두 원본')));
  assert.deepEqual(errs([notice()], { decisions: [decision({ kind: 'sources-agree', sourceRefs: [...ref, specRef] })] }), []);
  assert.ok(errs([notice()], { decisions: [decision({ kind: 'dev-decides' })] }).some((e) => e.includes('kind')));
});

// ── 비평 단계 ───────────────────────────────────────────────────────────────
function agent(critic, questions = [notice()]) {
  const run = (spec) => {
    const stage = spec.prompt.includes('workplan.draft') ? 'interpret' : spec.prompt.includes('critic.json') ? 'critic' : 'scope';
    mkdirSync(join(spec.cwd, 'stages'), { recursive: true });
    const body = { scope: scopeOut(), interpret: draft(questions), critic: critic() }[stage];
    writeFileSync(join(spec.cwd, 'stages', { scope: 'scope.json', interpret: 'workplan.draft.json', critic: 'critic.json' }[stage]), JSON.stringify(body));
    return { ok: true, status: { status: 'done', message: 'ok' }, tokens: 1, seconds: 0, costUsd: 0 };
  };
  return { run };
}
const go = (dir, a, o = {}) => runPipeline(dir, { env: {}, stageAttempts: 1, loopAttempts: 1, ...o }, { runAgent: a.run, log: () => {} });
const demote = { id: 'Q1', verdict: 'demote', decision: { kind: 'answered-by-source', statement: 'JSON 은 정식 ExportFormat 이고 옵션은 서버가 내려준다', rationale: '계약이 이미 정의한다', sourceRefs: [specRef] } };

test('비평: 원본이 이미 답한 notice 는 decision 으로 내려가고, 기대던 추론 항목은 원본 근거 항목이 된다', () => {
  const dir = fixture();
  const r = go(dir, agent(() => ({ findings: [], questionVerdicts: [demote] })));
  assert.equal(r.ok, true);
  const plan = JSON.parse(readFileSync(join(dir, 'workplan.json'), 'utf8'));
  assert.equal(plan.questions.length, 0);
  assert.equal(plan.decisions.length, 1); assert.equal(plan.decisions[0].id, 'D-Q1'); assert.equal(plan.decisions[0].kind, 'answered-by-source');
  const r2 = plan.requirements.find((x) => x.id === 'R2');
  assert.equal(r2.basis, 'source'); assert.equal(r2.decision, 'D-Q1'); assert.ok(!('question' in r2)); assert.ok(r2.sourceRefs.some((x) => x.sourceId === 'spec'));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'run-status.json'), 'utf8')).removedQuestions, ['Q1']);
});
test('비평: 모든 질문에 판정이 있어야 한다', () => {
  const r = go(fixture(), agent(() => ({ findings: [], questionVerdicts: [] })));
  assert.equal(r.ok, false); assert.ok(r.violations.some((v) => v.includes('질문 Q1 의 판정')));
});
test('비평: demote 는 decision 과 실재하는 근거가 필요하다', () => {
  const none = go(fixture(), agent(() => ({ findings: [], questionVerdicts: [{ id: 'Q1', verdict: 'demote' }] })));
  assert.ok(none.violations.some((v) => v.includes('decision')));
  const fake = go(fixture(), agent(() => ({ findings: [], questionVerdicts: [{ ...demote, decision: { ...demote.decision, sourceRefs: [{ sourceId: 'spec', locator: '존재하지않는절' }] } }] })));
  assert.ok(fake.violations.some((v) => v.includes('원본에 없는 locator')));
  const bad = go(fixture(), agent(() => ({ findings: [], questionVerdicts: [{ ...demote, decision: { ...demote.decision, kind: 'dev-decides' } }] })));
  assert.ok(bad.violations.some((v) => v.includes('kind')));
});
test('비평: 추론 항목이 가리키는 notice 는 제거할 수 없고, 그 밖의 질문은 제거할 수 있다', () => {
  const r = go(fixture(), agent(() => ({ findings: [], questionVerdicts: [{ id: 'Q1', verdict: 'drop', reason: '중복' }] })));
  assert.equal(r.ok, false); assert.ok(r.violations.some((v) => v.includes('제거할 수 없음')));
  const dir = fixture();
  const ok = go(dir, agent(() => ({ findings: [], questionVerdicts: [{ id: 'Q1', verdict: 'keep' }, { id: 'Q2', verdict: 'drop', reason: '중복' }] }), [notice(), confirm()]));
  assert.equal(ok.ok, true);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'workplan.json'), 'utf8')).questions.map((q) => q.id), ['Q1']);
});
test('비평: keep 한 질문이 기준에 안 맞으면 막힌다(confirm 인데 한 원본뿐)', () => {
  const r = go(fixture(), agent(() => ({ findings: [], questionVerdicts: [{ id: 'Q1', verdict: 'keep' }, { id: 'Q2', verdict: 'keep' }] }), [notice(), confirm({ sourceRefs: ref })]));
  assert.equal(r.ok, false); assert.ok(r.violations.some((v) => v.includes('서로 다른 두 원본')));
});

test('검토 화면: 질문은 종류·담당자·근거 위치로, 결정은 별도 절로 보인다', () => {
  const dir = fixture();
  assert.equal(go(dir, agent(() => ({ findings: [], questionVerdicts: [{ id: 'Q1', verdict: 'keep' }, { id: 'Q2', verdict: 'keep' }] }), [notice(), confirm()]), {}).ok, true);
  const html = readFileSync(join(dir, 'review.html'), 'utf8');
  assert.ok(html.includes('알림 — 이렇게 정했다') && html.includes('확인 요청') && html.includes('원본끼리 다름') && html.includes('찾아본 범위'));
  const dir2 = fixture();
  assert.equal(go(dir2, agent(() => ({ findings: [], questionVerdicts: [demote] }))).ok, true);
  const html2 = readFileSync(join(dir2, 'review.html'), 'utf8');
  assert.ok(html2.includes('원본이 이미 답한 것') && html2.includes('id="D-Q1"') && html2.includes('원본이 명시함'));
});
