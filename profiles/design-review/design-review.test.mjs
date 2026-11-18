import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPipeline } from '../../scripts/lib/pipeline.mjs';
import { classify } from '../../scripts/intake.mjs';
import { SCENARIOS } from './validate.mjs';

// 가상 결제 도메인: 요구 원본(plan) + 설계 문서 집합(subject). 배경 조건 두 개가 설계에 없고, '거래 없음'이면 즉시 다른 경로로 전환하는 흐름이 있다.
const REQ = [
  '# 카드 결제 요구',
  '청구 건을 카드로 결제한다.',
  '같은 청구는 두 번 승인되지 않아야 한다.',
  '카드로 결제한 청구 건은 세금계산서를 발행하지 않는다. 병행은 외부 청구 시스템 설정으로 처리한다.',
  '이후 청구 건 없이 금액을 직접 입력하는 결제가 붙을 수 있다.',
].join('\n');
const FLOW = [
  '# 결제 흐름',
  '1. 결제 요청을 승인 대행사로 보낸다.',
  '2. 응답이 없으면 거래 조회를 호출한다.',
  "3. 조회 결과가 '거래 없음'이면 즉시 다른 승인 경로로 다시 요청한다.",
  '4. 승인되면 청구를 납부 완료로 바꾼다.',
].join('\n');
const SCHEMA = ['# 스키마', 'payment(id, invoice_id NOT NULL, amount, status)', 'invoice(id, amount, status)'].join('\n');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kh-dr-'));
  for (const [f, t] of [['req.md', REQ], ['flow.md', FLOW], ['schema.md', SCHEMA]]) writeFileSync(join(dir, f), t);
  writeFileSync(join(dir, 'inputs.json'), JSON.stringify({ caseId: 'dr', purpose: 'design-review', inputs: [
    { id: 'req', kind: 'context-doc', role: 'plan', path: join(dir, 'req.md') },
    { id: 'flow', kind: 'context-doc', role: 'subject', path: join(dir, 'flow.md') },
    { id: 'schema', kind: 'context-doc', role: 'subject', path: join(dir, 'schema.md') },
  ] }));
  return dir;
}
const r = (sourceId, locator) => ({ sourceId, locator });
const conditions = [
  { id: 'C-01', text: '청구 건을 카드로 결제한다', sourceRefs: [r('req', 'L2')] },
  { id: 'C-02', text: '같은 청구는 두 번 승인되지 않는다', sourceRefs: [r('req', 'L3')] },
  { id: 'C-03', text: '카드 결제 청구는 세금계산서를 발행하지 않고 외부 청구 시스템이 병행을 처리한다', sourceRefs: [r('req', 'L4')] },
  { id: 'C-04', text: '청구 없는 직접 입력 결제가 붙을 수 있다', sourceRefs: [r('req', 'L5')] },
];
const invariants = [{ id: 'I-01', statement: '같은 청구는 두 번 승인되지 않는다', sourceRefs: [r('req', 'L3')] }];
const scope = (over = {}) => ({ conditions, nonConditions: [], invariants, excluded: [], ...over });
const trace = (scenario, over = {}) => ({ id: `X-${SCENARIOS.indexOf(scenario) + 1}`, invariant: 'I-01', scenario, verdict: 'holds', steps: [{ ref: r('flow', 'L2'), state: '승인 요청' }], ...over });
const lateArrival = trace('late-arrival', {
  verdict: 'breaks',
  steps: [{ ref: r('flow', 'L2'), state: '승인 요청 — 응답 지연' }, { ref: r('flow', 'L3'), state: '응답 없음 → 거래 조회' }, { ref: r('flow', 'L4'), state: "조회 '거래 없음' → 다른 경로로 재요청" }, { ref: r('flow', 'L5'), state: '첫 요청의 승인이 늦게 도착 → 두 경로 모두 승인' }],
  counterexample: '첫 승인이 조회 뒤에 도착하면 같은 청구가 두 번 승인된다',
});
const draft = (over = {}) => ({
  title: '카드 결제 설계 검토', summary: 'S', invariants,
  coverage: [
    { id: 'V-01', condition: 'C-01', conditions: ['C-01'], status: 'covered', locations: [r('flow', 'L2-5')] },
    { id: 'V-02', condition: 'C-02', conditions: ['C-02'], status: 'mention-only', locations: [r('flow', 'L4')], note: '중복 승인 방지 수단이 없다' },
    { id: 'V-03', condition: 'C-03', conditions: ['C-03'], status: 'missing', locations: [], note: '외부 청구 시스템으로 결제 수단·청구별 금액을 전달하는 흐름이 없다' },
    { id: 'V-04', condition: 'C-04', conditions: ['C-04'], status: 'missing', locations: [], note: 'payment.invoice_id NOT NULL 이라 청구 없는 결제를 담을 수 없다' },
  ],
  traces: SCENARIOS.map((s) => (s === 'late-arrival' ? lateArrival : trace(s))),
  remedies: [
    { id: 'M-01', addresses: ['V-02', 'X-4'], proposal: '조회 "거래 없음" 뒤 재요청 전에 첫 요청을 취소 확정하고, 청구 단위 승인 잠금을 둔다', targets: [{ sourceId: 'flow', section: '결제 흐름' }] },
    { id: 'M-02', addresses: ['V-03'], proposal: '결제 완료 시 외부 청구 시스템에 결제 수단·청구별 카드 금액을 전달한다', targets: [{ sourceId: 'flow', section: '결제 흐름' }] },
    { id: 'M-03', addresses: ['V-04'], proposal: 'payment.invoice_id 를 결제-청구 배분 표로 옮긴다', targets: [{ sourceId: 'schema', section: '스키마' }] },
  ],
  questions: [], decisions: [], ...over,
});
function agent({ s = scope(), d = draft() } = {}) {
  const run = (spec) => {
    const stage = spec.prompt.includes('workplan.draft') ? 'interpret' : spec.prompt.includes('critic.json') ? 'critic' : 'scope';
    mkdirSync(join(spec.cwd, 'stages'), { recursive: true });
    writeFileSync(join(spec.cwd, 'stages', { scope: 'scope.json', interpret: 'workplan.draft.json', critic: 'critic.json' }[stage]), JSON.stringify({ scope: s, interpret: d, critic: { findings: [], questionVerdicts: [] } }[stage]));
    return { ok: true, status: { status: 'done', message: 'ok' }, tokens: 1, seconds: 0, costUsd: 0 };
  };
  return { run };
}
const go = (dir, a) => runPipeline(dir, { env: {}, stageAttempts: 1, loopAttempts: 1 }, { runAgent: a.run, log: () => {} });

test('design-review: 누락 조건과 반례 경로가 단계별 문서 근거와 함께 검토 화면에 나온다', () => {
  const dir = fixture();
  const out = go(dir, agent());
  assert.equal(out.ok, true, JSON.stringify(out.violations));
  const plan = JSON.parse(readFileSync(join(dir, 'workplan.json'), 'utf8'));
  assert.equal(plan.kind, 'DesignReview');
  assert.deepEqual(plan.coverage.filter((x) => x.status === 'missing').map((x) => x.condition), ['C-03', 'C-04']);
  const html = readFileSync(join(dir, 'review.html'), 'utf8');
  assert.ok(html.includes('누락') && html.includes('지연 도착') && html.includes('깨짐') && html.includes('두 번 승인된다') && html.includes('<code>flow</code> L5'));
});

test('design-review: 커버리지 행·시나리오 행·반례·보완안·설계 문서 위치가 빠지면 막는다', () => {
  const v = (d) => { const o = go(fixture(), agent({ d })); assert.equal(o.ok, false); return o.violations.join('\n'); };
  assert.ok(v(draft({ coverage: draft().coverage.slice(0, 3) })).includes('조건 C-04 의 커버리지 행이 없음'));
  assert.ok(v(draft({ traces: draft().traces.filter((t) => t.scenario !== 'retry') })).includes('I-01 의 retry 시나리오 행이 없음'));
  assert.ok(v(draft({ traces: draft().traces.map((t) => (t.verdict === 'breaks' ? { ...t, counterexample: '' } : t)) })).includes('breaks 는 counterexample'));
  assert.ok(v(draft({ remedies: draft().remedies.slice(1) })).includes('mention-only 인데 보완안(remedies)이 없음'));
  assert.ok(v(draft({ coverage: draft().coverage.map((x) => (x.id === 'V-01' ? { ...x, locations: [r('req', 'L2')] } : x)) })).includes('검토 대상 설계 문서(subject)의 위치여야 함'));
  assert.ok(v(draft({ coverage: draft().coverage.map((x) => (x.id === 'V-01' ? { ...x, locations: [r('flow', 'L99')] } : x)) })).includes('행 범위가 원본'));
  assert.ok(v(draft({ coverage: draft().coverage.map((x) => (x.id === 'V-03' ? { ...x, status: 'excluded', note: '외부 시스템이 처리' } : x)) })).includes('excluded 는 범위의 제외 항목이 남는 의무 없음'));
});

test('design-review: 불변식이 없으면 반례 추적은 하지 않고 미검사로 보인다', () => {
  const dir = fixture();
  const none = go(dir, agent({ s: scope({ invariants: [] }), d: draft({ invariants: [], traces: [], remedies: draft().remedies.map((m) => ({ ...m, addresses: m.addresses.filter((a) => a.startsWith('V-')) })) }) }));
  assert.equal(none.ok, true, JSON.stringify(none.violations));
  assert.ok(readFileSync(join(dir, 'review.html'), 'utf8').includes('반례 추적 미검사'));
  const stray = go(fixture(), agent({ s: scope({ invariants: [] }), d: draft({ invariants: [] }) }));
  assert.ok(stray.violations.some((x) => x.includes('불변식이 없으면 traces 는 비어야 함')));
});

test('design-review 입력: subject 역할을 받고, 검토 대상 문서가 없으면 알린다', () => {
  const dir = fixture();
  const ok = classify({ case: 'd1', purpose: 'design-review', items: [{ path: join(dir, 'req.md'), role: 'plan' }, { path: join(dir, 'flow.md'), role: 'subject' }] });
  assert.deepEqual(ok.errors, []); assert.equal(ok.items[1].kind, 'context-doc'); assert.deepEqual(ok.warnings, []);
  const miss = classify({ case: 'd1', purpose: 'design-review', items: [{ path: join(dir, 'req.md'), role: 'plan' }] });
  assert.ok(miss.warnings.some((w) => w.startsWith('subject')));
});
