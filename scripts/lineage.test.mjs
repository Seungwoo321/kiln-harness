import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { runPipeline } from './lib/pipeline.mjs';
import { validate } from './validate.mjs';
import { decide } from './decide.mjs';
import { register } from './register.mjs';
import { extract } from './extract.mjs';
import { buildLineage } from './lineage.mjs';

const ref = [{ sourceId: 'plan1', locator: 'L1-2' }];
const html = (extra = '') => `<html><body>\n<h1 id="a">화면</h1>\n<p>본문 마스킹은 부분 마스킹</p>\n${extra}</body></html>\n`;
const scopeOut = () => ({ surfaces: [{ id: 'S1', title: '화면', entry: '/x', change: 'new', sourceRefs: ref }], excluded: [] });
const draftOut = (extra = {}) => ({
  title: 'T', summary: 'S', newFiles: [], surfaces: scopeOut().surfaces, excluded: [],
  requirements: [{ id: 'R1', surface: 'S1', statement: '마스킹', acceptance: ['a'], basis: 'source', sourceRefs: ref }],
  states: [{ id: 'ST1', surface: 'S1', region: 'r', state: 's', condition: 'c', display: 'd', basis: 'source', sourceRefs: ref }],
  components: [{ id: 'C1', surface: 'S1', name: 'A', file: 'src/a.tsx', fileStatus: 'new', ds: { component: null, match: 'custom', reason: '없다' }, sourceRefs: ref }],
  apiBindings: [], i18n: [], gaps: [{ id: 'G1', surface: 'S1', current: 'c', target: 't' }],
  questions: [{ id: 'Q1', to: 'plan', question: '마스킹 범위?', options: [], assumption: '전체', impact: ['R1'], kind: 'confirm', claimType: 'wrong', evidence: '본문이 모호함', sourceRefs: ref }],
  tasks: [{ id: 'T1', title: '작업', files: ['src/a.tsx'], dependsOn: [], covers: ['S1', 'C1', 'R1', 'ST1', 'G1'], changeKind: 'new-page' }],
  ...extra,
});
const criticOut = () => ({ findings: [] });

function agent(over = {}) {
  const calls = [];
  const run = (spec) => {
    const stage = spec.prompt.includes('workplan.draft') ? 'interpret' : spec.prompt.includes('critic.json') ? 'critic' : 'scope';
    calls.push({ stage, prompt: spec.prompt });
    mkdirSync(join(spec.cwd, 'stages'), { recursive: true });
    const keepAll = () => {
      const draft = JSON.parse(readFileSync(join(spec.cwd, 'stages', 'workplan.draft.json'), 'utf8'));
      return { findings: [], questionVerdicts: (draft.questions ?? []).map((q) => ({ id: q.id, verdict: 'keep' })) };
    };
    const body = over[stage]?.(calls.filter((c) => c.stage === stage).length) ?? (stage === 'critic' ? keepAll() : { scope: scopeOut(), interpret: draftOut() }[stage]);
    writeFileSync(join(spec.cwd, 'stages', { scope: 'scope.json', interpret: 'workplan.draft.json', critic: 'critic.json' }[stage]), JSON.stringify(body));
    return { ok: true, status: { status: 'done', message: 'ok' }, tokens: 1, seconds: 0, costUsd: 0 };
  };
  return { run, calls };
}
const go = (dir, a, opts = {}) => runPipeline(dir, { env: {}, ...opts }, { runAgent: a.run, log: () => {} });

function makeCase(root, name, caseId, content, previous) {
  const dir = join(root, name); mkdirSync(dir);
  const plan = join(dir, 'plan.html'); writeFileSync(plan, content);
  writeFileSync(join(dir, 'inputs.json'), JSON.stringify({ caseId, inputs: [{ id: 'plan1', kind: 'plan-html', role: 'plan', path: plan }], ...(previous ? { previous: { case: previous } } : {}) }));
  return dir;
}

function previousCase() {
  const root = mkdtempSync(join(tmpdir(), 'kh-lin-'));
  const prev = makeCase(root, 'prev', 'fx-1', html());
  assert.equal(go(prev, agent()).ok, true);
  decide(prev, 'R1', 'decided', '전체 마스킹으로 간다');
  return { root, prev };
}

const followUp = (root, content, name = 'next') => makeCase(root, name, 'fx-2', content, 'prev');
const lineageDraft = (over = {}) => draftOut({
  questions: [{ id: 'Q2', to: 'plan', question: '아직 모호', options: [], assumption: 'x', impact: ['R1'], kind: 'confirm', claimType: 'wrong', evidence: '본문이 모호함', sourceRefs: ref }],
  lineage: { previous: 'fx-1', inherited: [{ ref: 'R1', status: 'kept', note: '전체 마스킹 유지', target: 'R1' }], resolved: [{ ref: 'Q1', status: 'still-open', note: '새 원본에도 없음', question: 'Q2' }] },
  ...over,
});

test('계보: 바뀐 원본은 영역으로, 이전 결정·열린 확인 요청은 기록으로 뽑는다', () => {
  const { root } = previousCase();
  const dir = followUp(root, html('<h2 id="b">추가 절</h2>\n<p>새 내용</p>\n'));
  register(dir); extract(dir);
  const lin = buildLineage(dir);
  const s = lin.sources[0];
  assert.equal(s.status, 'changed'); assert.ok(s.changedRegions.length >= 1); assert.ok(s.added.some((a) => a.value === '추가 절'));
  assert.deepEqual(lin.decisions.map((d) => d.id), ['R1']); assert.equal(lin.decisions[0].subject, '마스킹');
  assert.deepEqual(lin.openQuestions.map((q) => q.id), ['Q1']);
  assert.equal(lin.previous.caseId, 'fx-1');
});

test('계보: 이전 사례가 끝나지 않았으면 링크할 수 없다', () => {
  const root = mkdtempSync(join(tmpdir(), 'kh-lin-'));
  mkdirSync(join(root, 'prev'));
  const dir = followUp(root, html());
  const r = spawnSync('node', [join(import.meta.dirname, 'register.mjs'), dir], { encoding: 'utf8' });
  assert.equal(r.status, 2); assert.ok(r.stderr.includes('이전 사례에 sources.json·workplan.json 이 없습니다'));
});

test('범위: 변경 없는 원본만 근거인 화면은 거부한다', () => {
  const { root } = previousCase();
  const dir = followUp(root, html()); // 이전과 동일
  const r = go(dir, agent(), { stageAttempts: 1, loopAttempts: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.includes('이전 사례와 같은 원본만 근거')));
});

test('후속 해석: 이전 결정과 확인 요청을 처리하면 통과하고 프롬프트에 계보가 주입된다', () => {
  const { root } = previousCase();
  const dir = followUp(root, html('<h2 id="b">추가 절</h2>\n'));
  const a = agent({ interpret: () => lineageDraft() });
  const r = go(dir, a);
  assert.equal(r.ok, true);
  const plan = JSON.parse(readFileSync(join(dir, 'workplan.json'), 'utf8'));
  assert.equal(plan.lineage.inherited[0].status, 'kept');
  const interp = a.calls.find((c) => c.stage === 'interpret').prompt;
  assert.ok(interp.includes('[후속 사례]') && interp.includes('이전 결정 1건') && interp.includes('gap)')); 
  assert.ok(a.calls.find((c) => c.stage === 'scope').prompt.includes('plan1: changed'));
  const review = readFileSync(join(dir, 'review.html'), 'utf8');
  assert.ok(review.includes('id="sec-lineage"') && review.includes('전체 마스킹으로 간다'));
});

test('후속 검증: 결정 누락·충돌의 질문 누락·근거 없는 해소는 막는다', () => {
  const { root } = previousCase();
  const dir = followUp(root, html('<h2 id="b">추가 절</h2>\n'));
  assert.equal(go(dir, agent({ interpret: () => lineageDraft() })).ok, true);
  const base = JSON.parse(readFileSync(join(dir, 'workplan.json'), 'utf8'));
  const errs = (mut) => { const p = JSON.parse(JSON.stringify(base)); mut(p); return validate(dir, p); };
  assert.ok(errs((p) => { p.lineage.inherited = []; }).some((e) => e.includes('이전 결정 R1 가 처리되지 않음')));
  assert.ok(errs((p) => { p.lineage.inherited[0] = { ref: 'R1', status: 'conflict', note: '충돌' }; }).some((e) => e.includes('conflict 는')));
  assert.ok(errs((p) => { p.lineage.resolved[0] = { ref: 'Q1', status: 'resolved', note: '해소' }; }).some((e) => e.includes('근거(evidence)')));
  assert.ok(errs((p) => { p.lineage.resolved = []; }).some((e) => e.includes('이전 열린 확인 요청 Q1')));
  assert.ok(errs((p) => { delete p.lineage; }).some((e) => e.includes('lineage')));
  assert.ok(errs((p) => { p.lineage.inherited.push({ ref: 'ZZ', status: 'kept', note: 'x' }); }).some((e) => e.includes('이전 사례에 없는 결정')));
  // 충돌을 질문으로 올리면 통과한다 — 기획이 부분 마스킹, 이전 결정이 전체 마스킹인 경우
  assert.deepEqual(errs((p) => { p.lineage.inherited[0] = { ref: 'R1', status: 'conflict', note: '기획은 부분 마스킹', question: 'Q2' }; }), []);
  assert.deepEqual(errs((p) => { p.lineage.resolved[0] = { ref: 'Q1', status: 'resolved', note: '새 원본에 명시', evidence: [{ sourceId: 'plan1', locator: 'L2' }] }; }), []);
});
