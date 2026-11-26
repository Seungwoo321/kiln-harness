import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runPipeline } from './lib/pipeline.mjs';
import { decide, readDecisions, bulkAccepted } from './decide.mjs';

const PLAN = '<html><body>\n<p>목록에서 항목을 내보낸다.</p>\n<p>내보내기 형식은 CSV 다.</p>\n</body></html>\n';
const ref = (locator) => [{ sourceId: 'plan1', locator }];
const conditions = [{ id: 'C-01', text: '목록에서 항목을 CSV 로 내보낸다', sourceRefs: ref('L2-3') }];
const scope = { surfaces: [{ id: 'S1', title: '목록', entry: '/list', change: 'new', sourceRefs: ref('L2') }], excluded: [], conditions, nonConditions: [] };
const question = { id: 'Q-1', kind: 'notice', to: 'plan', question: 'CSV 구분자는 무엇인가?', options: ['쉼표', '탭'], whyExternal: '어느 원본도 정하지 않아 담당자만 정할 수 있다', assumption: '쉼표로 한다', impact: ['R-1'], sourceRefs: ref('L3'), searched: [{ sourceId: 'plan1', scope: '전체' }], conditions: ['C-01'] };
const draft = {
  title: 'T', summary: 'S', newFiles: [{ file: 'src/list.tsx', reason: '새 화면' }], surfaces: scope.surfaces, excluded: [],
  requirements: [{ id: 'R-1', surface: 'S1', statement: 'CSV 로 내보낸다', acceptance: ['a'], basis: 'source', sourceRefs: ref('L3'), conditions: ['C-01'] }],
  states: [{ id: 'ST-1', surface: 'S1', region: '목록', state: '빈', condition: '항목 없음', display: '버튼 비활성', basis: 'source', sourceRefs: ref('L2') }],
  components: [{ id: 'CMP-1', surface: 'S1', name: 'Export', file: 'src/list.tsx', fileStatus: 'new', ds: { component: null, match: 'custom', reason: '없다' }, sourceRefs: ref('L2') }],
  apiBindings: [], i18n: [], gaps: [], questions: [question], decisions: [],
  tasks: [{ id: 'T-1', title: '내보내기', files: ['src/list.tsx'], dependsOn: [], covers: ['S1', 'CMP-1', 'R-1', 'ST-1'], changeKind: 'new-page' }],
};

function fixture(config = null) {
  const dir = mkdtempSync(join(tmpdir(), 'kh-dec-'));
  writeFileSync(join(dir, 'plan.html'), PLAN);
  writeFileSync(join(dir, 'inputs.json'), JSON.stringify({ caseId: 'dec', inputs: [{ id: 'plan1', kind: 'plan-html', role: 'plan', path: join(dir, 'plan.html') }] }));
  if (config) writeFileSync(join(dir, 'kh.config.json'), JSON.stringify(config));
  return dir;
}
function agent(opinion = null) {
  const calls = []; const prompts = {};
  const run = (spec) => {
    const stage = spec.prompt.includes('second-opinion.json') ? 'second-opinion' : spec.prompt.includes('workplan.draft') ? 'interpret' : spec.prompt.includes('critic.json') ? 'critic' : 'scope';
    calls.push(stage); prompts[stage] = spec.prompt;
    mkdirSync(join(spec.cwd, 'stages'), { recursive: true });
    const body = { scope, interpret: draft, critic: { findings: [], questionVerdicts: [{ id: 'Q-1', verdict: 'keep' }] }, 'second-opinion': opinion }[stage];
    writeFileSync(join(spec.cwd, 'stages', { scope: 'scope.json', interpret: 'workplan.draft.json', critic: 'critic.json', 'second-opinion': 'second-opinion.json' }[stage]), JSON.stringify(body));
    return { ok: true, status: { status: 'done', message: 'ok' }, tokens: 1, seconds: 0, costUsd: 0 };
  };
  return { run, calls, prompts };
}
const go = (dir, a) => runPipeline(dir, { env: {}, stageAttempts: 1, loopAttempts: 1 }, { runAgent: a.run, log: () => {} });

test('결정 출처: 권장안 채택은 보여 준 선택지·고른 안과 함께 남고, 이유는 말한 것만 남는다', () => {
  const dir = fixture(); const first = go(dir, agent()); assert.equal(first.ok, true, JSON.stringify(first.violations));
  decide(dir, 'Q-1', 'decided', '쉼표로 한다', { origin: 'recommendation-accepted' });
  decide(dir, 'R-1', 'decided', 'UTF-8 BOM 을 붙인다', { reason: '엑셀에서 한글이 깨진다' });
  const [q, r] = ['Q-1', 'R-1'].map((id) => readDecisions(dir).find((d) => d.id === id));
  assert.equal(q.origin, 'recommendation-accepted'); assert.equal(q.chosen, 'recommended'); assert.ok(!('reason' in q));
  assert.deepEqual(q.optionsShown.map((o) => o.id), ['option-1', 'option-2', 'recommended']);
  assert.equal(r.origin, 'user'); assert.equal(r.reason, '엑셀에서 한글이 깨진다'); assert.deepEqual(r.optionsShown, []);
  assert.deepEqual([q.seq, r.seq], [1, 2]);
  const list = execFileSync(process.execPath, [new URL('./decide.mjs', import.meta.url).pathname, dir, '--list'], { encoding: 'utf8' });
  assert.ok(list.includes('Q-1\tdecided\trecommendation-accepted\t이유 없음') && list.includes('R-1\tdecided\tuser\t이유: 엑셀에서 한글이 깨진다'));
});

test('결정 출처: 권장안이 있는 항목은 출처가 필요하고, 출처와 고른 안이 어긋나면 거부한다', () => {
  const dir = fixture(); go(dir, agent());
  assert.throws(() => decide(dir, 'Q-1', 'decided', '쉼표'), /권장안이 있다 — 출처/);
  assert.throws(() => decide(dir, 'Q-1', 'decided', '탭', { origin: 'recommendation-rejected', chosen: 'recommended' }), /기각/);
  assert.throws(() => decide(dir, 'Q-1', 'decided', '세미콜론', { origin: 'user', chosen: 'option-9' }), /chosen 은 보여 준 선택지/);
  assert.throws(() => decide(dir, 'R-1', 'decided', 'x', { origin: 'recommendation-accepted' }), /권장안이 없다/);
  decide(dir, 'Q-1', 'decided', '탭으로 한다', { origin: 'recommendation-rejected', chosen: 'option-2' });
  assert.equal(readDecisions(dir)[0].chosen, 'option-2');
});

test('일괄 채택 감지: 이유 없는 권장안 채택이 연속 threshold 건 이상인 구간만 잡는다', () => {
  const d = (id, seq, origin, reason) => ({ id, seq, origin, ...(reason ? { reason } : {}) });
  const ds = [d('A', 1, 'recommendation-accepted'), d('B', 2, 'recommendation-accepted'), d('C', 3, 'recommendation-accepted'), d('D', 4, 'user'), d('E', 5, 'recommendation-accepted'), d('F', 6, 'recommendation-accepted', '근거 확인')];
  assert.deepEqual(bulkAccepted(ds, 3), [['A', 'B', 'C']]);
  assert.deepEqual(bulkAccepted(ds, 4), []);
  assert.deepEqual(bulkAccepted([{ id: 'legacy', stance: 'decided', note: 'x' }], 1), []); // 출처가 없는 이전 기록은 세지 않는다
});

test('독립 재검토: 반대한 권장안 채택은 반영하지 않고 반례와 함께 보이며, 같은 결정은 다시 묻지 않는다', () => {
  const dir = fixture({ review: { secondOpinion: true } });
  assert.equal(go(dir, agent()).ok, true);
  decide(dir, 'Q-1', 'decided', '쉼표로 한다', { origin: 'recommendation-accepted' });
  const no = { verdict: 'disagree', counterexamples: [{ statement: '원본 L3 은 형식만 말하고, 받는 시스템은 탭 구분을 요구할 수 있다', sourceRefs: ref('L3') }] };
  const a = agent(no);
  assert.equal(go(dir, a).ok, true);
  assert.ok(a.calls.includes('second-opinion'));
  assert.ok(a.prompts['second-opinion'].includes('채택하려는 안: recommended') && !a.prompts['second-opinion'].includes('decided'));
  assert.ok(!a.prompts.interpret.includes('쉼표로 한다'), '반대받은 결정은 해석 단계에 넘기지 않는다');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'run-status.json'), 'utf8')).secondOpinion, { disagreed: ['Q-1'] });
  assert.ok(readFileSync(join(dir, 'review.html'), 'utf8').includes('독립 재검토 반대 — 반영하지 않음'));
  const again = agent(no);
  go(dir, again);
  assert.ok(!again.calls.includes('second-opinion'), '같은 결정은 캐시를 쓴다');
});

test('독립 재검토: 동의하면 결정이 반영되고, 꺼져 있으면 재검토하지 않는다', () => {
  const dir = fixture({ review: { secondOpinion: true } });
  go(dir, agent());
  decide(dir, 'Q-1', 'decided', '쉼표로 한다', { origin: 'recommendation-accepted' });
  const a = agent({ verdict: 'agree', counterexamples: [], none: 'L3 과 계약을 확인했다' });
  go(dir, a);
  assert.ok(a.prompts.interpret.includes('쉼표로 한다'));
  const off = fixture();
  go(off, agent());
  decide(off, 'Q-1', 'decided', '쉼표로 한다', { origin: 'recommendation-accepted' });
  const b = agent();
  go(off, b);
  assert.ok(!b.calls.includes('second-opinion'));
});
