import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPipeline } from './lib/pipeline.mjs';
import { htmlStatements, markdownStatements, docxStatements, rangeOf } from './lib/conditions.mjs';

// 범위에서 화면을 제외하면 그 조건이 이 시스템에 남기는 의무까지 사라지던 경우를 재현한다(가상 결제·청구 도메인).
const PLAN = [
  '<html><head><title>카드 결제</title><style>p{color:red}</style></head><body>',
  '<h1>카드 결제 도입</h1>',
  '<p>청구 건을 카드로 결제하는 화면을 추가한다.</p>',
  '<p>카드로 결제한 청구 건은 세금계산서를 발행하지 않는다. 병행이 필요한 고객은 외부 청구 시스템 설정으로 별도 처리한다.</p>',
  '<p>이후 청구 건 없이 담당자가 금액을 직접 입력해 결제하는 경우도 붙을 수 있다.</p>',
  '<script>const x = "스크립트 문구";</script>',
  '</body></html>',
].join('\n');
const ref = (locator) => [{ sourceId: 'plan1', locator }];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kh-cond-'));
  writeFileSync(join(dir, 'plan.html'), PLAN);
  writeFileSync(join(dir, 'inputs.json'), JSON.stringify({ caseId: 'cond', inputs: [{ id: 'plan1', kind: 'plan-html', role: 'plan', path: join(dir, 'plan.html') }] }));
  return dir;
}

const conditions = [
  { id: 'C-01', text: '청구 건을 카드로 결제하는 화면을 추가한다', sourceRefs: ref('L3') },
  { id: 'C-02', text: '카드 결제 청구 건은 세금계산서를 발행하지 않고, 병행은 외부 청구 시스템이 처리한다', sourceRefs: ref('L4') },
  { id: 'C-03', text: '청구 없이 금액을 직접 입력하는 결제가 붙을 수 있다', sourceRefs: ref('L5') },
];
const excluded = (residual) => [
  { title: '세금계산서 발행·병행 처리 화면', reason: '외부 청구 시스템의 화면', sourceRefs: ref('L4'), conditions: ['C-02'], ...(residual ? { residual: residual.a } : {}) },
  { title: '직접 결제 화면', reason: '이번 범위 밖', sourceRefs: ref('L5'), conditions: ['C-03'], ...(residual ? { residual: residual.b } : {}) },
];
const residual = { a: { obligations: [{ statement: '외부 청구 시스템에 결제 수단과 청구별 카드 결제 금액을 전달한다' }] }, b: { obligations: [{ statement: '데이터 모델이 청구 없는 결제를 수용한다' }] } };
const scopeOut = (over = {}) => ({ surfaces: [{ id: 'S1', title: '카드 결제', entry: '/pay', change: 'new', sourceRefs: ref('L3') }], excluded: excluded(residual), conditions, nonConditions: [], ...over });
const draft = (over = {}) => ({
  title: 'T', summary: 'S', newFiles: [{ file: 'src/pay.tsx', reason: '새 화면' }], surfaces: scopeOut().surfaces,
  excluded: excluded({ a: { obligations: [{ ...residual.a.obligations[0], handledBy: ['R-2'] }] }, b: { obligations: [{ ...residual.b.obligations[0], handledBy: ['R-3'] }] } }),
  requirements: [
    { id: 'R-1', surface: 'S1', statement: '청구 건을 카드로 결제한다', acceptance: ['a'], basis: 'source', sourceRefs: ref('L3'), conditions: ['C-01'] },
    { id: 'R-2', surface: 'S1', statement: '결제 완료 시 외부 청구 시스템에 결제 수단·청구별 카드 금액을 전달한다', acceptance: ['a'], basis: 'source', sourceRefs: ref('L4'), conditions: ['C-02'] },
    { id: 'R-3', surface: 'S1', statement: '결제 기록은 청구 배분 없이도 저장된다', acceptance: ['a'], basis: 'source', sourceRefs: ref('L5'), conditions: ['C-03'] },
  ],
  states: [{ id: 'ST-1', surface: 'S1', region: '결제', state: '오류', condition: '실패', display: '메시지', basis: 'source', sourceRefs: ref('L3') }], components: [{ id: 'CMP-1', surface: 'S1', name: 'Pay', file: 'src/pay.tsx', fileStatus: 'new', ds: { component: null, match: 'custom', reason: '없다' }, sourceRefs: ref('L3') }],
  apiBindings: [], i18n: [], gaps: [], questions: [], decisions: [],
  tasks: [{ id: 'T-1', title: '결제', files: ['src/pay.tsx'], dependsOn: [], covers: ['S1', 'CMP-1', 'R-1', 'R-2', 'R-3', 'ST-1'], changeKind: 'new-page' }],
  ...over,
});
function agent({ scope = scopeOut(), plan = draft(), critic = { findings: [], questionVerdicts: [] } } = {}) {
  const prompts = {};
  const run = (spec) => {
    const stage = spec.prompt.includes('workplan.draft') ? 'interpret' : spec.prompt.includes('critic.json') ? 'critic' : 'scope';
    prompts[stage] = spec.prompt;
    mkdirSync(join(spec.cwd, 'stages'), { recursive: true });
    writeFileSync(join(spec.cwd, 'stages', { scope: 'scope.json', interpret: 'workplan.draft.json', critic: 'critic.json' }[stage]), JSON.stringify({ scope, interpret: plan, critic }[stage]));
    return { ok: true, status: { status: 'done', message: 'ok' }, tokens: 1, seconds: 0, costUsd: 0 };
  };
  return { run, prompts };
}
const go = (dir, a) => runPipeline(dir, { env: {}, stageAttempts: 1, loopAttempts: 1 }, { runAgent: a.run, log: () => {} });

test('문장 목록: HTML 은 스크립트·스타일·제목을 뺀 줄, Markdown 은 제목·코드 블록·표 구분선을 뺀 줄, docx 는 문단 순번', () => {
  assert.deepEqual(htmlStatements(PLAN).map((s) => s.locator), ['L3', 'L4', 'L5']);
  assert.deepEqual(markdownStatements('# 제목\n\n본문 조건\n```\n코드\n```\n| a | b |\n|---|---|\n| 1 | 2 |').map((s) => [s.locator, s.text]), [['L3', '본문 조건'], ['L7', '| a | b |'], ['L9', '| 1 | 2 |']]);
  assert.deepEqual(docxStatements([{ type: 'heading1', value: '절', order: 1 }, { type: 'paragraph', value: '조건', order: 2 }, { type: 'table', rows: [['a', 'b']], order: 3 }]).map((s) => s.locator), ['P2', 'P3']);
  assert.deepEqual(rangeOf('L3-5', 'plan-html'), [3, 5]); assert.deepEqual(rangeOf('P4', 'plan-doc'), [4, 4]); assert.equal(rangeOf('#id', 'plan-html'), null);
});

test('범위 게이트: 분류되지 않은 조건 문장과 남는 의무를 적지 않은 제외 항목을 막는다', () => {
  const r = go(fixture(), agent({ scope: scopeOut({ conditions: [conditions[0]], excluded: excluded(null) }) }));
  assert.equal(r.ok, false);
  const v = r.violations.join('\n');
  assert.ok(v.includes('분류되지 않은 조건 후보 문장 2개') && v.includes('L4') && v.includes('L5'));
  assert.ok(v.includes('excluded[0]: residual 이 없음') && v.includes('excluded[1]: residual 이 없음'));
});

test('범위 게이트: 프롬프트가 조건 후보 문장의 위치와 분류 계약을 알린다', () => {
  const a = agent();
  go(fixture(), a);
  assert.ok(a.prompts.scope.includes('[조건 커버리지') && a.prompts.scope.includes('plan1(3개, L 번호)'));
  assert.ok(a.prompts.interpret.includes('[조건 매핑') && a.prompts.critic.includes('[조건 매핑 점검]'));
});

test('해석 게이트: 제외한 화면의 조건이 남긴 의무가 요구사항으로 이어지면 통과하고, 검토 화면에 조건 커버리지가 보인다', () => {
  const dir = fixture();
  const r = go(dir, agent());
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  const plan = JSON.parse(readFileSync(join(dir, 'workplan.json'), 'utf8'));
  assert.deepEqual(plan.conditions.map((c) => c.id), ['C-01', 'C-02', 'C-03']);
  const html = readFileSync(join(dir, 'review.html'), 'utf8');
  assert.ok(html.includes('조건 커버리지') && html.includes('id="C-02"') && html.includes('외부 청구 시스템에 결제 수단'));
});

test('해석 게이트: 처리 항목이 없는 조건과 이어지지 않은 남는 의무를 막는다', () => {
  const unmapped = go(fixture(), agent({ plan: draft({ requirements: draft().requirements.map((x) => (x.id === 'R-1' ? { ...x, conditions: [] } : x)) }) }));
  assert.equal(unmapped.ok, false); assert.ok(unmapped.violations.some((v) => v.includes('조건 C-01 를 처리한 항목이 없음')));
  const loose = go(fixture(), agent({ plan: draft({ excluded: excluded(residual) }) }));
  assert.equal(loose.ok, false); assert.ok(loose.violations.some((v) => v.includes('handledBy(이어진 요구사항·질문 id)가 없음')));
});

test('비평: 질문을 결정으로 내리면 조건과 남는 의무의 연결을 결정이 이어받는다', () => {
  const q = { id: 'Q-1', kind: 'notice', to: 'backend', question: '외부 청구 시스템 전달 형식', options: [], assumption: '결제 수단·금액', impact: [], sourceRefs: ref('L4'), searched: [{ sourceId: 'plan1', scope: '전체' }], conditions: ['C-02'] };
  const plan = draft({ questions: [q], requirements: draft().requirements.map((x) => (x.id === 'R-2' ? { ...x, conditions: [] } : x)), excluded: excluded({ a: { obligations: [{ ...residual.a.obligations[0], handledBy: ['Q-1'] }] }, b: { obligations: [{ ...residual.b.obligations[0], handledBy: ['R-3'] }] } }) });
  const demote = { id: 'Q-1', verdict: 'demote', decision: { kind: 'answered-by-source', statement: '결제 수단과 금액을 보낸다', rationale: '원본이 정한다', sourceRefs: ref('L4') } };
  const dir = fixture();
  const r = go(dir, agent({ plan, critic: { findings: [], questionVerdicts: [demote] } }));
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  const out = JSON.parse(readFileSync(join(dir, 'workplan.json'), 'utf8'));
  assert.deepEqual(out.decisions.find((d) => d.id === 'D-Q-1').conditions, ['C-02']);
  assert.deepEqual(out.excluded[0].residual.obligations[0].handledBy, ['D-Q-1']);
  const drop = go(fixture(), agent({ plan, critic: { findings: [], questionVerdicts: [{ id: 'Q-1', verdict: 'drop', reason: '중복' }] } }));
  assert.equal(drop.ok, false); assert.ok(drop.violations.some((v) => v.includes('남는 의무 1: handledBy(이어진 요구사항·질문 id)가 없음')));
});
