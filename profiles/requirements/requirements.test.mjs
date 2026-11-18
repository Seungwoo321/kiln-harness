import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPipeline } from '../../scripts/lib/pipeline.mjs';

// 가상 요구 원본(과제)과 회의 기록. 상황·배경 문장까지 모두 조건으로 분류돼야 한다.
const BRIEF = ['# 과제', '고객은 미납 청구를 카드로 결제한다.', '카드 결제 청구는 세금계산서를 발행하지 않는다.', '이후 청구 없는 직접 결제가 붙을 수 있다.'].join('\n');
const NOTES = ['# 회의', '결제 실패 시 재시도는 한 번만 허용하기로 했다.'].join('\n');
const r = (sourceId, locator) => ({ sourceId, locator });

function reqCase(root, config = null) {
  const dir = join(root, 'req'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'brief.md'), BRIEF); writeFileSync(join(dir, 'notes.md'), NOTES);
  writeFileSync(join(dir, 'inputs.json'), JSON.stringify({ caseId: 'req', purpose: 'requirements', inputs: [
    { id: 'brief', kind: 'context-doc', role: 'plan', path: join(dir, 'brief.md') },
    { id: 'notes', kind: 'context-doc', role: 'context', path: join(dir, 'notes.md') },
  ] }));
  if (config) writeFileSync(join(dir, 'kh.config.json'), JSON.stringify(config));
  return dir;
}
const conditions = [
  { id: 'C-01', text: '미납 청구를 카드로 결제한다', sourceRefs: [r('brief', 'L2')] },
  { id: 'C-02', text: '카드 결제 청구는 세금계산서를 발행하지 않는다', sourceRefs: [r('brief', 'L3')] },
  { id: 'C-03', text: '청구 없는 직접 결제가 붙을 수 있다', sourceRefs: [r('brief', 'L4')] },
  { id: 'C-04', text: '결제 실패 재시도는 한 번만 허용한다', sourceRefs: [r('notes', 'L2')] },
];
const reqScope = (over = {}) => ({ conditions, nonConditions: [], excluded: [], ...over });
const reqDraft = (over = {}) => ({
  title: '카드 결제 요구', summary: 'S',
  requirements: [
    { id: 'R-01', statement: '고객은 미납 청구를 골라 카드로 결제한다', conditions: ['C-01'], sourceRefs: [r('brief', 'L2')], acceptance: [{ when: '미납 청구 2건을 골라 결제하면', then: '두 청구가 납부 완료가 된다' }] },
    { id: 'R-02', statement: '카드 결제 사실을 외부 청구 시스템이 알 수 있게 전달한다', conditions: ['C-02'], acceptance: [{ when: '카드 결제가 승인되면', then: '외부 청구 시스템에 결제 수단·청구별 금액이 전달된다' }] },
    { id: 'R-03', statement: '결제 기록은 청구 없이도 저장될 수 있다', conditions: ['C-03'], acceptance: [{ when: '청구 없이 금액만으로 결제 기록을 만들면', then: '저장된다' }] },
    { id: 'R-04', statement: '실패한 결제는 한 번만 다시 시도한다', conditions: ['C-04'], acceptance: [{ when: '결제가 두 번 실패하면', then: '세 번째 시도 버튼이 없다' }] },
  ],
  open: [{ id: 'U-01', question: '외부 청구 시스템 전달 방식(이벤트·API)', default: 'API 호출', impact: ['R-02'] }],
  changes: [{ id: 'CH-01', change: '재시도 1회 제한', reason: '회의 결정', sourceRefs: [r('notes', 'L2')] }],
  excluded: [], questions: [], decisions: [{ id: 'D-01', statement: '카드 결제는 세금계산서를 발행하지 않는다', rationale: '과제가 명시한다', sourceRefs: [r('brief', 'L3')] }],
  ...over,
});
function agent(outputs) {
  const prompts = {};
  const run = (spec) => {
    const stage = spec.prompt.includes('workplan.draft') ? 'interpret' : spec.prompt.includes('critic.json') ? 'critic' : 'scope';
    prompts[stage] = spec.prompt;
    mkdirSync(join(spec.cwd, 'stages'), { recursive: true });
    writeFileSync(join(spec.cwd, 'stages', { scope: 'scope.json', interpret: 'workplan.draft.json', critic: 'critic.json' }[stage]), JSON.stringify({ critic: { findings: [], questionVerdicts: [] }, ...outputs }[stage]));
    return { ok: true, status: { status: 'done', message: 'ok' }, tokens: 1, seconds: 0, costUsd: 0 };
  };
  return { run, prompts };
}
const go = (dir, a) => runPipeline(dir, { env: {}, stageAttempts: 1, loopAttempts: 1 }, { runAgent: a.run, log: () => {} });

test('requirements: 상황·배경 문장까지 조건으로 열거되고, 요구사항·수용기준·미결·변경 내역이 검토 화면에 나온다', () => {
  const dir = reqCase(mkdtempSync(join(tmpdir(), 'kh-req-')));
  const out = go(dir, agent({ scope: reqScope(), interpret: reqDraft() }));
  assert.equal(out.ok, true, JSON.stringify(out.violations));
  const plan = JSON.parse(readFileSync(join(dir, 'workplan.json'), 'utf8'));
  assert.equal(plan.kind, 'Requirements'); assert.deepEqual(plan.conditions.map((c) => c.id), ['C-01', 'C-02', 'C-03', 'C-04']);
  const html = readFileSync(join(dir, 'review.html'), 'utf8');
  assert.ok(html.includes('미결 — 기본값으로 진행') && html.includes('API 호출') && html.includes('재시도 1회 제한'));
});

test('requirements: 분류되지 않은 배경 문장, 검증할 수 없는 수용기준, 기본값 없는 미결, 예산 초과를 막는다', () => {
  const v = (outputs, config) => { const o = go(reqCase(mkdtempSync(join(tmpdir(), 'kh-req-')), config), agent(outputs)); assert.equal(o.ok, false); return o.violations.join('\n'); };
  assert.ok(v({ scope: reqScope({ conditions: conditions.slice(0, 3) }), interpret: reqDraft() }).includes('분류되지 않은 조건 후보 문장 1개 — notes L2'));
  assert.ok(v({ scope: reqScope(), interpret: reqDraft({ requirements: reqDraft().requirements.map((x) => (x.id === 'R-04' ? { ...x, acceptance: [{ then: '잘 동작한다' }] } : x)) }) }).includes('when(상황·조작)과 then'));
  assert.ok(v({ scope: reqScope(), interpret: reqDraft({ open: [{ id: 'U-01', question: 'q', impact: [] }] }) }).includes('default(정해지기 전까지 따르는 기본값)'));
  assert.ok(v({ scope: reqScope(), interpret: reqDraft({ open: [...reqDraft().open, { id: 'U-02', question: 'q2', default: 'd', impact: [] }] }) }, { profiles: { requirements: { openBudget: 1 } } }).includes('예산 1건을 넘음'));
});

test('프로파일 연결: design-review 가 앞 단계 requirements 의 조건·결정·미결을 다시 만들지 않고 이어받는다', () => {
  const root = mkdtempSync(join(tmpdir(), 'kh-chain-'));
  const req = reqCase(root);
  assert.equal(go(req, agent({ scope: reqScope(), interpret: reqDraft() })).ok, true);
  const dr = join(root, 'dr'); mkdirSync(dr);
  writeFileSync(join(dr, 'flow.md'), ['# 결제 흐름', '1. 결제를 요청한다.', '2. 승인되면 청구를 납부 완료로 바꾼다.'].join('\n'));
  writeFileSync(join(dr, 'inputs.json'), JSON.stringify({ caseId: 'dr', purpose: 'design-review', upstream: { case: 'req' }, inputs: [{ id: 'flow', kind: 'context-doc', role: 'subject', path: join(dr, 'flow.md') }] }));
  const coverage = conditions.map((c, i) => ({ id: `V-0${i + 1}`, condition: c.id, conditions: [c.id], status: c.id === 'C-01' ? 'covered' : 'missing', locations: c.id === 'C-01' ? [r('flow', 'L2-3')] : [], note: c.id === 'C-01' ? undefined : '설계에 없다' }));
  const draft = { title: 'T', summary: 'S', invariants: [], coverage, traces: [], remedies: [{ id: 'M-01', addresses: ['V-02', 'V-03', 'V-04'], proposal: '흐름에 추가한다', targets: [{ sourceId: 'flow', section: '결제 흐름' }] }], questions: [], decisions: [] };
  const a = agent({ scope: { conditions: [], nonConditions: [], invariants: [], excluded: [] }, interpret: draft });
  const out = go(dr, a);
  assert.equal(out.ok, true, JSON.stringify(out.violations));
  const plan = JSON.parse(readFileSync(join(dr, 'workplan.json'), 'utf8'));
  assert.deepEqual(plan.conditions.map((c) => [c.id, c.inherited]), conditions.map((c) => [c.id, 'req']));
  assert.ok(a.prompts.scope.includes('[앞 단계 사례 — req (Requirements)]') && a.prompts.scope.includes('C-01, C-02, C-03, C-04'));
  assert.ok(a.prompts.interpret.includes('D-01: 카드 결제는 세금계산서를 발행하지 않는다') && a.prompts.interpret.includes('U-01: 외부 청구 시스템 전달 방식'));
  const clash = go(dr, agent({ scope: { conditions: [{ id: 'C-02', text: '다시 쓴 조건', sourceRefs: [r('flow', 'L2')] }], nonConditions: [], invariants: [], excluded: [] }, interpret: draft }));
  assert.ok(clash.violations.some((x) => x.includes('C-02 는 앞 단계 사례(req)의 조건 id 다')));
});

