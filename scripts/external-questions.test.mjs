import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPipeline } from './lib/pipeline.mjs';
import { validate } from '../profiles/fe-workplan/validate.mjs';
import { register } from './register.mjs';
import { extract } from './extract.mjs';

// 외부 담당 질문 분류 — 한쪽 원본(계약)이 차이를 이미 정해 둔 경우를 외부 질문으로 올리지 않는다. 가상 데이터만 쓴다.
// A: 기획이 미결로 열어 둔 항목에 계약이 답했다. B: 계약이 '하지 않는다'를 명시했다. C: 어느 원본도 정하지 않았다(진짜 외부 결정).
const CASES = {
  A: {
    plan: '<html><body>\n<h1 id="run">실행 기록</h1>\n<p>실행마다 저장값이 보호 처리본인지 여부를 서버가 내려줘야 한다.</p>\n<p>어떤 값으로 줄지는 정해야 할 것(미결).</p>\n</body></html>\n',
    contract: '# 기록 계약\n\n## ViewResponse\n\n열람 응답에 flagApplied 를 추가한다. 프로젝트에 보호 규칙이 적용되고 있는지를 뜻하며 실행 단위 값이 아니라 프로젝트 현재 상태다.\n',
    anchor: 'ViewResponse', planLoc: 'L3-4', notice: false,
  },
  B: {
    plan: '<html><body>\n<h1 id="stats">리소스 통계</h1>\n<p>외부 등록 리소스에서도 도구별 호출 통계 표를 보인다.</p>\n</body></html>\n',
    contract: '# 통계 계약\n\n## ToolStats\n\n외부 리소스는 도구별 통계를 낼 수 없어 supported=false, 빈 결과로 내린다.\n',
    anchor: 'ToolStats', planLoc: 'L3', notice: true,
  },
  C: {
    plan: '<html><body>\n<h1 id="list">목록</h1>\n<p>목록은 한 화면에 20건씩 보인다.</p>\n</body></html>\n',
    contract: '# 목록 계약\n\n## ListQuery\n\n목록 조회의 기본 페이지 크기는 50건이다. 화면별 크기를 허용하는지는 정하지 않았다.\n',
    anchor: 'ListQuery', planLoc: 'L3', notice: false,
  },
};

function fixture(c) {
  const dir = mkdtempSync(join(tmpdir(), 'kh-eq-'));
  writeFileSync(join(dir, 'plan.html'), c.plan); writeFileSync(join(dir, 'contract.md'), c.contract);
  writeFileSync(join(dir, 'inputs.json'), JSON.stringify({ caseId: 'fx', inputs: [
    { id: 'plan1', kind: 'plan-html', role: 'plan', path: join(dir, 'plan.html') },
    { id: 'api', kind: 'context-doc', role: 'contract', path: join(dir, 'contract.md') },
  ] }));
  return dir;
}
const planRef = (c) => [{ sourceId: 'plan1', locator: c.planLoc }];
const apiRef = (c) => [{ sourceId: 'api', locator: c.anchor }];
const searchedAll = [{ sourceId: 'plan1', scope: '전체' }, { sourceId: 'api', scope: '전체' }];
const scopeOut = (c) => ({ surfaces: [{ id: 'S1', title: '화면', entry: '/x', change: 'new', sourceRefs: planRef(c) }],
  excluded: [{ title: '계약', reason: '입력 문서', sourceRefs: apiRef(c), residual: { none: '입력 문서일 뿐 남는 의무 없음' } }],
  conditions: [], nonConditions: [{ sourceId: 'plan1', locator: 'L1-500', reason: '픽스처 — 조건 없음' }] });
const draft = (c, { questions = [], decisions = [] } = {}) => ({
  title: 'T', summary: 'S', newFiles: [{ file: 'src/a.tsx', reason: '새 화면' }], surfaces: scopeOut(c).surfaces, excluded: scopeOut(c).excluded,
  requirements: [{ id: 'R1', surface: 'S1', statement: '화면을 그린다', acceptance: ['a'], basis: 'source', sourceRefs: planRef(c) }],
  states: [{ id: 'ST1', surface: 'S1', region: 'r', state: 's', condition: 'c', display: 'd', basis: 'source', sourceRefs: planRef(c) }],
  components: [{ id: 'C1', surface: 'S1', name: 'A', file: 'src/a.tsx', fileStatus: 'new', ds: { component: null, match: 'custom', reason: '없다' }, sourceRefs: planRef(c) }],
  apiBindings: [], i18n: [], gaps: [{ id: 'G1', surface: 'S1', current: 'c', target: 't' }], questions, decisions,
  tasks: [{ id: 'T1', title: '작업', files: ['src/a.tsx'], dependsOn: [], covers: ['S1', 'C1', 'R1', 'ST1', 'G1'], changeKind: 'new-page' }],
});
// 두 원본의 차이를 백엔드에 확인하는 질문 — 이슈가 지적한 형태.
const confirmQ = (c, over = {}) => ({ id: 'Q1', kind: 'confirm', claimType: 'mismatch', to: 'backend', question: '기획과 계약이 다르다', options: [], whyExternal: '서버만 정할 수 있다',
  assumption: '계약을 따른다', impact: ['R1'], sourceRefs: [...planRef(c), ...apiRef(c)], searched: searchedAll, ...over });
const decisionD = (c) => ({ id: 'D-01', kind: 'answered-by-source', statement: '계약을 따른다', rationale: '계약이 그 차이를 명시적으로 정했다', sourceRefs: apiRef(c) });
const noticeQ = (c) => ({ id: 'Q2', kind: 'notice', to: 'plan', question: '기획 화면의 해당 영역이 비게 된다', options: [], whyExternal: '계약이 정했고 기획이 화면을 바꿔야 한다',
  assumption: '계약을 따른다(D-01) — 해당 영역은 빈 상태로 둔다', impact: ['R1'], sourceRefs: [...planRef(c), ...apiRef(c)], searched: searchedAll });

const v4 = (dir, body) => ({ schemaVersion: 4, kind: 'WorkPlan', caseId: 'fx', inputDigests: JSON.parse(readFileSync(join(dir, 'sources.json'), 'utf8')).sources.map((s) => s.sha256), ...body, findings: [] });
const check = (c, body, mutate) => { const dir = fixture(c); register(dir); extract(dir); const p = v4(dir, body); mutate?.(p); return validate(dir, p); };

test('외부 질문은 whyExternal 이 있어야 한다 — confirm·notice 모두', () => {
  const c = CASES.A;
  assert.deepEqual(check(c, draft(c, { questions: [confirmQ(c)], decisions: [] })), []);
  for (const bad of [undefined, '', '  ']) {
    assert.ok(check(c, draft(c, { questions: [confirmQ(c, { whyExternal: bad })] })).some((e) => e.includes('whyExternal')));
    assert.ok(check(c, draft(c, { questions: [noticeQ(c)] }), (p) => { p.questions[0].whyExternal = bad; }).some((e) => e.includes('whyExternal')));
  }
});
test('confirm 은 계약·context 를 찾아본 범위에 포함해야 한다(시안 동작 충돌은 면제)', () => {
  const c = CASES.A;
  assert.ok(check(c, draft(c, { questions: [confirmQ(c, { searched: undefined })] })).some((e) => e.includes('어느 원본을 찾아봤는지')));
  assert.ok(check(c, draft(c, { questions: [confirmQ(c, { searched: [{ sourceId: 'plan1', scope: '전체' }] })] })).some((e) => e.includes('원본 api(contract)를 찾아본 범위에 포함')));
  assert.ok(check(c, draft(c, { questions: [confirmQ(c, { searched: [{ sourceId: 'plan1', scope: '' }, { sourceId: 'api', scope: '전체' }] })] })).some((e) => e.includes('scope')));
  const exempt = confirmQ(c, { searched: undefined, to: 'design', designEvidence: { sourceId: 'plan1', interaction: 'I1' } });
  assert.ok(!check(c, draft(c, { questions: [exempt] })).some((e) => e.includes('찾아봤는지')));
  assert.ok(check(c, draft(c, { questions: [{ ...exempt, whyExternal: '' }] })).some((e) => e.includes('whyExternal')));
});
test('이전 형식(v3)의 계획서는 새 규칙을 받지 않는다', () => {
  const c = CASES.A;
  const q = confirmQ(c, { whyExternal: undefined, searched: undefined });
  assert.deepEqual(check(c, draft(c, { questions: [q] }), (p) => { p.schemaVersion = 3; }), []);
});

// ── 파이프라인: 해석 게이트와 비평 ──────────────────────────────────────────
function agent(c, { interpret, critic }) {
  const prompts = []; let attempt = 0;
  const run = (spec) => {
    const stage = spec.prompt.includes('workplan.draft') ? 'interpret' : spec.prompt.includes('critic.json') ? 'critic' : 'scope';
    mkdirSync(join(spec.cwd, 'stages'), { recursive: true });
    if (stage === 'interpret') prompts.push(spec.prompt);
    const body = { scope: () => scopeOut(c), interpret: () => interpret(++attempt), critic: () => critic?.() ?? { findings: [], questionVerdicts: JSON.parse(readFileSync(join(spec.cwd, 'stages', 'workplan.checked.json'), 'utf8')).questions.map((q) => ({ id: q.id, verdict: 'keep' })) } }[stage]();
    writeFileSync(join(spec.cwd, 'stages', { scope: 'scope.json', interpret: 'workplan.draft.json', critic: 'critic.json' }[stage]), JSON.stringify(body));
    return { ok: true, status: { status: 'done', message: 'ok' }, tokens: 1, seconds: 0, costUsd: 0 };
  };
  return { run, prompts };
}
const go = (dir, a) => runPipeline(dir, { env: {}, stageAttempts: 2, loopAttempts: 1 }, { runAgent: a.run, log: () => {} });
const readPlan = (dir) => JSON.parse(readFileSync(join(dir, 'workplan.json'), 'utf8'));

for (const key of ['A', 'B']) {
  const c = CASES[key];
  test(`사례 ${key}: 계약이 정한 차이를 백엔드 확인으로 올리면 해석 게이트가 되돌리고, 결정(+알림)으로 고치면 통과한다`, () => {
    const dir = fixture(c);
    // 첫 시도: 계약을 찾아보지 않고 백엔드에 다시 묻는다 → 막힌다. 두 번째 시도: 계약을 따르는 결정으로 내린다.
    const a = agent(c, { interpret: (n) => (n === 1
      ? draft(c, { questions: [confirmQ(c, { searched: [{ sourceId: 'plan1', scope: '전체' }] })] })
      : draft(c, { decisions: [decisionD(c)], questions: c.notice ? [noticeQ(c)] : [] })) });
    const r = go(dir, a);
    assert.equal(r.ok, true);
    assert.ok(a.prompts[1].includes('원본 api(contract)를 찾아본 범위에 포함해야 함'));
    const plan = readPlan(dir);
    assert.equal(plan.schemaVersion, 4);
    assert.ok(!plan.questions.some((q) => q.to === 'backend'));
    assert.deepEqual(plan.decisions.map((d) => d.sourceRefs[0].sourceId), ['api']);
    assert.equal(plan.questions.length, c.notice ? 1 : 0);
    if (c.notice) assert.deepEqual([plan.questions[0].kind, plan.questions[0].to], ['notice', 'plan']);
  });
  test(`사례 ${key}: 형식을 갖춰 올라온 백엔드 확인도 비평이 계약의 문장으로 결정으로 내린다`, () => {
    const dir = fixture(c);
    const demote = { id: 'Q1', verdict: 'demote', decision: { kind: 'answered-by-source', statement: '계약을 따른다', rationale: '계약이 그 차이를 명시적으로 정했다', sourceRefs: apiRef(c) } };
    const r = go(dir, agent(c, { interpret: () => draft(c, { questions: [confirmQ(c)] }), critic: () => ({ findings: [], questionVerdicts: [demote] }) }));
    assert.equal(r.ok, true);
    const plan = readPlan(dir);
    assert.equal(plan.questions.length, 0);
    assert.deepEqual([plan.decisions[0].id, plan.decisions[0].sourceRefs[0].locator], ['D-Q1', c.anchor]);
  });
}

test('사례 C: 어느 원본도 정하지 않은 진짜 외부 질문은 해석·비평을 지나 그대로 남는다', () => {
  const c = CASES.C; const dir = fixture(c);
  const q = confirmQ(c, { question: '화면별 페이지 크기를 허용하는가', whyExternal: '계약이 화면별 크기 허용 여부를 정하지 않았고 서버 정책이다' });
  const r = go(dir, agent(c, { interpret: () => draft(c, { questions: [q] }), critic: () => ({ findings: [], questionVerdicts: [{ id: 'Q1', verdict: 'keep' }] }) }));
  assert.equal(r.ok, true);
  const plan = readPlan(dir);
  assert.deepEqual(plan.questions.map((x) => [x.id, x.to, x.kind]), [['Q1', 'backend', 'confirm']]);
  assert.equal(plan.decisions.length, 0);
  assert.ok(readFileSync(join(dir, 'review.html'), 'utf8').includes('외부 결정 이유'));
});
