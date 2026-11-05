import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPipeline } from './lib/pipeline.mjs';
import { buildDelta, guardrails, triageViolations, preservedViolations, mergeFindings, criticScope, DEFAULTS } from './lib/triage.mjs';

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const ref = [{ sourceId: 'plan1', locator: 'L1-2' }];
const ctxRef = [...ref, { sourceId: 'ctx1', locator: 'L1' }];
const scopeOut = () => ({ surfaces: [{ id: 'S1', title: '화면', entry: '/x', change: 'new', sourceRefs: ref }], excluded: [] });
const draftOut = () => ({
  title: 'T', summary: 'S', newFiles: [{ file: 'src/a.tsx', reason: '새 화면' }],
  surfaces: scopeOut().surfaces, excluded: [],
  requirements: [{ id: 'R1', surface: 'S1', statement: '요구', acceptance: ['a'], basis: 'source', sourceRefs: ctxRef }],
  states: [{ id: 'ST1', surface: 'S1', region: 'r', state: 's', condition: 'c', display: 'd', basis: 'source', sourceRefs: ref }],
  components: [{ id: 'C1', surface: 'S1', name: 'A', file: 'src/a.tsx', fileStatus: 'new', ds: { component: null, match: 'custom', reason: '없다' }, sourceRefs: ref }],
  apiBindings: [], i18n: [], gaps: [{ id: 'G1', surface: 'S1', current: 'c', target: 't' }], questions: [],
  tasks: [{ id: 'T1', title: '작업', files: ['src/a.tsx'], dependsOn: [], covers: ['S1', 'C1', 'R1', 'ST1', 'G1'], changeKind: 'new-page' }],
});
const finding = (id, target) => ({ id, severity: 'medium', origin: 'design', target, message: 'm', evidence: 'plan1 L1', recommendation: 'r', stance: 'ask-design' });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kh-triage-'));
  const plan = join(dir, 'plan.html'); writeFileSync(plan, '<html><body><h1 id="a">화면</h1></body></html>\n');
  const note = join(dir, 'note.md'); writeFileSync(note, '# 메모\n- 하나\n');
  writeFileSync(join(dir, 'inputs.json'), JSON.stringify({ caseId: 'fx', inputs: [{ id: 'plan1', kind: 'plan-html', role: 'plan', path: plan }, { id: 'ctx1', kind: 'context-doc', role: 'context', path: note }] }));
  return { dir, plan, note };
}

// 가짜 에이전트 — script[stage](n, spec) 이 본문을 돌려준다. 증분 해석은 기존 workplan.json 을 베껴 쓴다.
function fakeAgent(script = {}) {
  const calls = [];
  const run = (spec) => {
    const p = spec.prompt;
    const stage = p.includes('stages/triage.json') ? 'triage' : p.includes('workplan.draft') ? 'interpret' : p.includes('stages/scope.json') ? 'scope' : 'critic';
    const n = calls.filter((c) => c.stage === stage).length + 1;
    calls.push({ stage, n, prompt: p });
    mkdirSync(join(spec.cwd, 'stages'), { recursive: true });
    const defaults = { scope: scopeOut(), interpret: draftOut(), critic: { findings: [finding('F-001', 'C1')] }, triage: { action: 'incremental', reason: '메모만 바뀜', impactIds: ['R1'] } };
    const body = script[stage]?.(n, spec) ?? defaults[stage];
    writeFileSync(join(spec.cwd, 'stages', { scope: 'scope.json', interpret: 'workplan.draft.json', critic: 'critic.json', triage: 'triage.json' }[stage]), JSON.stringify(body));
    return { ok: true, status: { status: 'done', message: 'ok' }, tokens: 10, seconds: 1, costUsd: 0.01 };
  };
  return { run, calls, count: (s) => calls.filter((c) => c.stage === s).length };
}
const go = (dir, agent, opts = {}) => runPipeline(dir, { env: {}, ...opts }, { runAgent: agent.run, log: () => {} });
const baseDraft = (spec) => { const { kind, schemaVersion, caseId, inputDigests, findings, level, ...body } = readJson(join(spec.cwd, 'workplan.json')); return body; };

test('성공한 실행은 history/<runId>/ 에 입력 digest 와 산출물을 남긴다', () => {
  const { dir } = fixture(); const agent = fakeAgent();
  assert.equal(go(dir, agent).ok, true);
  const [run] = readdirSync(join(dir, 'history'));
  assert.match(run, /^001-[0-9a-f]{8}$/);
  const meta = readJson(join(dir, 'history', run, 'meta.json'));
  assert.deepEqual(meta.inputs.map((i) => [i.id, i.role]), [['ctx1', 'context'], ['plan1', 'plan']]);
  for (const f of ['scope.json', 'workplan.json', 'critic.json']) assert.ok(existsSync(join(dir, 'history', run, f)), f);
  assert.equal(go(dir, agent).skipped, true); // 그대로면 스냅샷을 또 만들지 않는다
  assert.equal(readdirSync(join(dir, 'history')).length, 1);
});

test('보강 자료만 바뀌면 incremental: 영향 밖 항목은 그대로, 지적은 이월되고 판정이 리포트에 남는다', () => {
  const { dir, note } = fixture(); const first = fakeAgent();
  go(dir, first);
  const before = readJson(join(dir, 'workplan.json')); const run1 = readdirSync(join(dir, 'history'))[0];
  writeFileSync(note, '# 메모\n- 하나\n- 둘\n');
  const agent = fakeAgent({
    interpret: (n, spec) => { const d = baseDraft(spec); d.requirements[0].statement = '요구 v2'; return d; },
    critic: () => ({ findings: [finding('F-001', 'R1')] }),
  });
  const r = go(dir, agent);
  assert.equal(r.ok, true);
  assert.deepEqual(['triage', 'interpret', 'critic'].map(agent.count), [1, 1, 1]);
  assert.equal(agent.count('scope'), 0); // 범위를 이어받는다
  const after = readJson(join(dir, 'workplan.json'));
  assert.equal(after.requirements[0].statement, '요구 v2');
  for (const k of ['surfaces', 'states', 'components', 'gaps', 'tasks']) assert.deepEqual(after[k], before[k], k);
  assert.deepEqual(after.findings.map((f) => [f.id, f.target, f.carriedFrom]), [['F-001', 'C1', run1], ['F-002', 'R1', undefined]]);
  const t = readJson(join(dir, 'triage.json'));
  assert.equal(t.action, 'incremental'); assert.deepEqual(t.impactIds, ['R1']); assert.deepEqual(t.delta.changed, [{ id: 'ctx1', role: 'context' }]);
  assert.deepEqual(t.findings, { carried: [{ id: 'F-001', carriedFrom: run1 }], resolved: [], raised: ['F-002'] });
  const status = readJson(join(dir, 'run-status.json'));
  assert.equal(status.triage.action, 'incremental'); assert.equal(status.triage.delta, undefined);
  assert.equal(readdirSync(join(dir, 'history')).length, 2);
  assert.equal(go(dir, agent).skipped, true);
});

test('증분 해석이 영향 목록 밖 항목을 바꾸면 위반이고, 고치면 통과한다', () => {
  const { dir, note } = fixture(); go(dir, fakeAgent());
  writeFileSync(note, '# 메모\n- 셋\n');
  const agent = fakeAgent({
    interpret: (n, spec) => { const d = baseDraft(spec); d.requirements[0].statement = '요구 v2'; if (n === 1) d.components[0].name = '몰래 바꿈'; return d; },
    critic: () => ({ findings: [] }),
  });
  assert.equal(go(dir, agent).ok, true);
  assert.equal(agent.count('interpret'), 2);
  assert.ok(agent.calls.find((c) => c.stage === 'interpret' && c.n === 2).prompt.includes('영향 목록 밖 항목이 바뀜 — C1'));
  assert.deepEqual(readJson(join(dir, 'triage.json')).findings.carried.map((f) => f.id), ['F-001']); // 영향 밖(C1) 항목의 이전 지적은 그대로 이월
});

test('영향 항목의 이전 지적은 새 비평이 다시 하지 않으면 해소로 기록된다', () => {
  const { dir, note } = fixture(); go(dir, fakeAgent({ critic: () => ({ findings: [finding('F-001', 'R1')] }) }));
  writeFileSync(note, '# 메모\n- 일곱\n');
  const agent = fakeAgent({ interpret: (n, spec) => baseDraft(spec), critic: () => ({ findings: [] }) });
  assert.equal(go(dir, agent).ok, true);
  assert.deepEqual(readJson(join(dir, 'triage.json')).findings, { carried: [], resolved: ['F-001'], raised: [] });
  assert.equal(readJson(join(dir, 'workplan.json')).findings.length, 0);
});

test('증분 비평은 영향 밖 항목을 지적할 수 없다', () => {
  const { dir, note } = fixture(); go(dir, fakeAgent());
  writeFileSync(note, '# 메모\n- 넷\n');
  const agent = fakeAgent({ interpret: (n, spec) => baseDraft(spec), critic: (n) => ({ findings: [finding('F-009', n === 1 ? 'G1' : 'R1')] }) });
  assert.equal(go(dir, agent).ok, true);
  assert.equal(agent.count('critic'), 2);
  assert.ok(agent.calls.find((c) => c.stage === 'critic' && c.n === 2).prompt.includes('증분 비평은 영향·신규 항목만 대상으로 한다 — G1'));
});

test('범위를 정하는 입력(plan)이 바뀌면 가드레일이 rewrite 를 강제하고 triage 를 부르지 않는다', () => {
  const { dir, plan } = fixture(); go(dir, fakeAgent());
  writeFileSync(plan, '<html><body><h1 id="a">화면</h1><h1 id="b">새 화면</h1></body></html>\n');
  const agent = fakeAgent();
  assert.equal(go(dir, agent).ok, true);
  assert.equal(agent.count('triage'), 0); assert.equal(agent.count('scope'), 1);
  const t = readJson(join(dir, 'triage.json'));
  assert.equal(t.action, 'rewrite'); assert.deepEqual(t.guardrails.map((g) => g.rule), ['changed-ratio', 'scope-input'].filter((r) => t.guardrails.some((g) => g.rule === r)));
  assert.ok(t.guardrails.some((g) => g.rule === 'scope-input'));
});

test('--rewrite 는 보강 자료만 바뀌어도 triage 없이 전면 재작성한다', () => {
  const { dir, note } = fixture(); go(dir, fakeAgent());
  writeFileSync(note, '# 메모\n- 다섯\n');
  const agent = fakeAgent();
  assert.equal(go(dir, agent, { rewrite: true }).ok, true);
  assert.equal(agent.count('triage'), 0); assert.equal(agent.count('scope'), 1);
  assert.equal(existsSync(join(dir, 'triage.json')), false);
});

test('skip 판정: 해석·비평을 부르지 않고 계획서의 입력 digest 만 갱신하며, 다음 재실행은 그대로 건너뛴다', () => {
  const { dir, note } = fixture(); go(dir, fakeAgent());
  const before = readJson(join(dir, 'workplan.json'));
  writeFileSync(note, '# 메모\n- 오탈자 수정\n');
  const agent = fakeAgent({ triage: () => ({ action: 'skip', reason: '오탈자만 고쳐짐', impactIds: [], kept: [{ id: 'R1', reason: '내용 같음' }] }) });
  const r = go(dir, agent);
  assert.equal(r.ok, true); assert.equal(r.skipped, true);
  assert.deepEqual(['interpret', 'critic', 'scope'].map(agent.count), [0, 0, 0]);
  const after = readJson(join(dir, 'workplan.json'));
  assert.notDeepEqual(after.inputDigests, before.inputDigests);
  assert.deepEqual({ ...after, inputDigests: 0 }, { ...before, inputDigests: 0 });
  assert.equal(readJson(join(dir, 'run-status.json')).triage.action, 'skip');
  assert.equal(go(dir, agent).skipped, true); assert.equal(agent.count('triage'), 1);
});

test('triage 가 통과하지 못하면 전면 재작성으로 돌아가고 사유를 남긴다', () => {
  const { dir, note } = fixture(); go(dir, fakeAgent());
  writeFileSync(note, '# 메모\n- 여섯\n');
  const agent = fakeAgent({ triage: () => ({ action: 'incremental', reason: 'x', impactIds: [] }) });
  assert.equal(go(dir, agent, { stageAttempts: 2 }).ok, true);
  assert.equal(agent.count('triage'), 2); assert.equal(agent.count('scope'), 1);
  const t = readJson(join(dir, 'triage.json'));
  assert.equal(t.action, 'rewrite'); assert.ok(t.fallback[0].includes('impactIds 가 비었음'));
});

// ── 순수 함수 ───────────────────────────────────────────────────────────────
const snap = (inputs, plan = {}) => ({ runId: '001-aaaaaaaa', meta: { inputs }, plan });
const src = (id, role, sha256) => ({ id, role, sha256 });

test('delta: 추가·변경·삭제와 영향 후보(바뀐 입력을 근거로 든 항목)를 센다', () => {
  const plan = { requirements: [{ id: 'R1', sourceRefs: [{ sourceId: 'b', locator: 'x' }] }, { id: 'R2', sourceRefs: [{ sourceId: 'a', locator: 'x' }] }] };
  const d = buildDelta({ sources: [src('a', 'plan', '1'), src('b', 'context', '2x'), src('d', 'context', '4')] }, snap([src('a', 'plan', '1'), src('b', 'context', '2'), src('c', 'context', '3')], plan));
  assert.deepEqual([d.added, d.changed, d.removed].map((x) => x.map((i) => i.id)), [['d'], ['b'], ['c']]);
  assert.equal(d.unchanged, 1); assert.deepEqual(d.candidateIds, ['R1']); assert.equal(d.changedRatio, 0.75);
});

test('가드레일: 비율·삭제 수·범위 입력·입력 변화 없음', () => {
  const mk = (over) => ({ added: [], changed: [], removed: [], changedRatio: 0.1, candidateIds: [], ...over });
  const rules = (d) => guardrails(d, DEFAULTS).map((g) => g.rule);
  assert.deepEqual(rules(mk({ changed: [{ id: 'c', role: 'context' }] })), []);
  assert.deepEqual(rules(mk()), ['no-input-change']);
  assert.deepEqual(rules(mk({ changed: [{ id: 'c', role: 'context' }], changedRatio: 0.6 })), ['changed-ratio']);
  assert.deepEqual(rules(mk({ removed: [{ id: 'c', role: 'context' }, { id: 'd', role: 'context' }] })), ['removed-count']);
  assert.deepEqual(rules(mk({ added: [{ id: 'p', role: 'plan' }] })), ['scope-input']);
  assert.deepEqual(rules(mk({ removed: [{ id: 'p', role: 'design' }] })), ['scope-input']);
});

test('triage 출력 검사: 빈 영향 목록·없는 id·후보 누락·결정 변경 중 skip 을 거부한다', () => {
  const plan = { requirements: [{ id: 'R1' }, { id: 'R2' }] };
  const delta = { candidateIds: ['R1', 'R2'] };
  assert.deepEqual(triageViolations({ action: 'incremental', reason: 'r', impactIds: ['R1'], kept: [{ id: 'R2', reason: '같음' }] }, delta, plan), []);
  assert.ok(triageViolations({ action: 'incremental', reason: 'r', impactIds: [] }, delta, plan).some((v) => v.includes('impactIds 가 비었음')));
  assert.ok(triageViolations({ action: 'incremental', reason: 'r', impactIds: ['R9'] }, delta, plan).some((v) => v.includes('R9')));
  assert.ok(triageViolations({ action: 'incremental', reason: 'r', impactIds: ['R1'] }, delta, plan).some((v) => v.includes('R2')));
  assert.ok(triageViolations({ action: 'skip', reason: 'r' }, delta, plan, { decisionsChanged: true }).some((v) => v.includes('skip')));
  assert.ok(triageViolations({ action: 'maybe', reason: '' }, delta, plan).length >= 2);
});

test('증분 게이트·지적 이월: 영향 밖 항목 보존, 비평 범위, 이월 id 뒤로 새 지적 번호', () => {
  const before = { surfaces: [{ id: 'S1' }], requirements: [{ id: 'R1', surface: 'S1', statement: 'a' }, { id: 'R2', surface: 'S1', statement: 'b' }] };
  const after = { surfaces: [{ id: 'S1' }], requirements: [{ id: 'R1', surface: 'S1', statement: 'a2' }, { id: 'R2', surface: 'S1', statement: 'b!' }, { id: 'R3', surface: 'S1', statement: 'new' }] };
  assert.deepEqual(preservedViolations(before, after, ['R1']), ['영향 목록 밖 항목이 바뀜 — R2 (바꿔야 하면 impactIds 에 있어야 한다)']);
  assert.deepEqual(preservedViolations(before, { ...after, requirements: [after.requirements[0]] }, ['R1']), ['영향 목록 밖 항목이 사라짐 — R2']);
  const scope = criticScope(before, after, ['R1']);
  assert.deepEqual([...scope.ids].sort(), ['R1', 'R3']); assert.deepEqual([...scope.surfaces], ['S1']);
  const prev = [{ id: 'F-001', target: 'R1' }, { id: 'F-002', target: 'R2', carriedFrom: '001-x' }, { id: 'F-003', target: 'GONE' }];
  const m = mergeFindings(prev, [{ target: 'R3', message: 'n' }], scope, new Set(['R1', 'R2', 'R3']), '002-y');
  assert.deepEqual(m.findings.map((f) => [f.id, f.target, f.carriedFrom]), [['F-002', 'R2', '001-x'], ['F-004', 'R3', undefined]]);
  assert.deepEqual(m.report, { carried: [{ id: 'F-002', carriedFrom: '001-x' }], resolved: ['F-001', 'F-003'], raised: ['F-004'] });
});
