import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPipeline, loadConfig } from './lib/pipeline.mjs';
import { buildCatalog } from './catalog.mjs';
import { register } from './register.mjs';
import { extract } from './extract.mjs';
import { execFileSync } from 'node:child_process';
import { buildCommand, cleanEnv, which } from './lib/runner.mjs';
import { decide } from './decide.mjs';

const ref = [{ sourceId: 'plan1', locator: 'L1-2' }];
const scopeOut = () => ({ surfaces: [{ id: 'S1', title: '화면', entry: '/x', change: 'new', sourceRefs: ref }], excluded: [] });
const draftOut = () => ({
  title: 'T', summary: 'S', newFiles: [],
  surfaces: scopeOut().surfaces, excluded: [],
  requirements: [{ id: 'R1', surface: 'S1', statement: '요구', acceptance: ['a'], basis: 'source', sourceRefs: ref }],
  states: [{ id: 'ST1', surface: 'S1', region: 'r', state: 's', condition: 'c', display: 'd', basis: 'source', sourceRefs: ref }],
  components: [{ id: 'C1', surface: 'S1', name: 'A', file: 'src/a.tsx', fileStatus: 'new', ds: { component: null, match: 'custom', reason: '없다' }, sourceRefs: ref }],
  apiBindings: [], i18n: [], gaps: [{ id: 'G1', surface: 'S1', current: 'c', target: 't' }], questions: [],
  tasks: [{ id: 'T1', title: '작업', files: ['src/a.tsx'], dependsOn: [], covers: ['S1', 'C1', 'R1', 'ST1', 'G1'], changeKind: 'new-page' }],
});
const criticOut = () => ({ findings: [{ id: 'F-001', severity: 'medium', origin: 'design', target: 'R1', message: 'm', evidence: 'plan1 L1', recommendation: 'r', stance: 'ask-design' }] });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kh-pipe-'));
  const plan = join(dir, 'plan.html'); writeFileSync(plan, '<html><body><h1 id="a">화면</h1></body></html>\n');
  writeFileSync(join(dir, 'inputs.json'), JSON.stringify({ caseId: 'fx', inputs: [{ id: 'plan1', kind: 'plan-html', role: 'plan', path: plan }] }));
  return { dir, plan };
}

// 가짜 에이전트 — 프롬프트가 가리키는 결과 파일을 쓴다. script[stage] 로 시도별 동작을 바꾼다.
function fakeAgent(script = {}) {
  const calls = [];
  const run = (spec) => {
    const stage = spec.prompt.includes('stages/scope.json') && !spec.prompt.includes('workplan.draft') ? 'scope' : spec.prompt.includes('workplan.draft') ? 'interpret' : 'critic';
    const n = calls.filter((c) => c.stage === stage).length + 1;
    calls.push({ stage, n, prompt: spec.prompt, spec });
    mkdirSync(join(spec.cwd, 'stages'), { recursive: true });
    const custom = script[stage]?.(n, spec);
    if (custom === 'fail') return { ok: false, status: null, error: '실행 실패', tokens: 0, seconds: 1, costUsd: 0 };
    if (custom === 'needs-input') return { ok: true, status: { status: 'blocked', message: '자료 부족', missingInputs: ['백엔드 레포 — 응답 필드 확인에 필요'] }, tokens: 1, seconds: 0, costUsd: 0 };
    const body = custom ?? { scope: scopeOut(), interpret: draftOut(), critic: criticOut() }[stage];
    const file = { scope: 'scope.json', interpret: 'workplan.draft.json', critic: 'critic.json' }[stage];
    writeFileSync(join(spec.cwd, 'stages', file), JSON.stringify(body));
    return { ok: true, status: { status: 'done', message: 'ok' }, tokens: 100, seconds: 1, costUsd: 0.01 };
  };
  return { run, calls };
}
const quiet = { log: () => {}, env: {} };
const go = (dir, agent, opts = {}) => runPipeline(dir, { env: {}, ...opts }, { runAgent: agent.run, log: () => {} });

test('정상 흐름: 범위 → 해석 → 비평 → 렌더, 상태 기록', () => {
  const { dir } = fixture(); const agent = fakeAgent();
  const r = go(dir, agent);
  assert.equal(r.ok, true);
  const plan = JSON.parse(readFileSync(join(dir, 'workplan.json'), 'utf8'));
  assert.equal(plan.schemaVersion, 3); assert.equal(plan.findings.length, 1); assert.equal(plan.tasks[0].changeKind, 'new-page');
  for (const f of ['review.html', 'WORKPLAN.md', 'WORKPLAN.html', 'scope.json']) assert.ok(existsSync(join(dir, f)), f);
  const status = JSON.parse(readFileSync(join(dir, 'run-status.json'), 'utf8'));
  assert.equal(status.result, 'passed'); assert.equal(status.usage.calls, 3); assert.equal(status.stages.interpret.result, 'passed');
});

test('위반은 다음 시도의 프롬프트로 넘어가고, 고치면 통과한다', () => {
  const { dir } = fixture();
  const agent = fakeAgent({ interpret: (n) => { if (n === 1) { const d = draftOut(); d.tasks[0].covers = ['S1']; return d; } } });
  const r = go(dir, agent);
  assert.equal(r.ok, true);
  const second = agent.calls.filter((c) => c.stage === 'interpret')[1];
  assert.ok(second.prompt.includes('이전 시도의 위반') && second.prompt.includes('어느 task 도 다루지 않음'));
  assert.equal(JSON.parse(readFileSync(join(dir, 'run-status.json'), 'utf8')).stages.interpret.calls, 2);
});

test('단계가 소진되면 전체를 처음부터 다시 하고, 지난 위반을 교훈으로 넘긴다', () => {
  const { dir } = fixture();
  const agent = fakeAgent({ interpret: (n) => { if (n <= 2) { const d = draftOut(); d.tasks[0].covers = ['S1']; return d; } } });
  const r = go(dir, agent, { stageAttempts: 2, loopAttempts: 2 });
  assert.equal(r.ok, true); assert.equal(r.loop, 2);
  assert.equal(agent.calls.filter((c) => c.stage === 'scope').length, 2); // 2회차는 범위부터 다시
  const third = agent.calls.filter((c) => c.stage === 'interpret')[2];
  assert.ok(third.prompt.includes('지난 전체 시도에서 배운 것'));
  assert.ok(existsSync(join(dir, 'failed', 'loop-1', 'violations.json')));
});

test('최종 실패하면 파생 산출물을 지우고 원본·결정은 보존한다', () => {
  const { dir, plan } = fixture();
  const ok = fakeAgent(); go(dir, ok);
  decide(dir, 'R1', 'decided', '확정');
  const agent = fakeAgent({ interpret: () => { const d = draftOut(); d.tasks = []; return d; } });
  const r = go(dir, agent, { stageAttempts: 2, loopAttempts: 2, force: true });
  assert.equal(r.ok, false);
  for (const f of ['workplan.json', 'WORKPLAN.md', 'review.html', 'scope.json']) assert.ok(!existsSync(join(dir, f)), `${f} 가 남음`);
  assert.ok(existsSync(plan) && existsSync(join(dir, 'decisions.json')) && existsSync(join(dir, 'failed')));
  const status = JSON.parse(readFileSync(join(dir, 'run-status.json'), 'utf8'));
  assert.equal(status.result, 'failed'); assert.ok(status.violations.length > 0);
});

test('에이전트가 원본을 고치면 그 시도는 실패로 본다', () => {
  const { dir, plan } = fixture();
  const agent = fakeAgent({ scope: (n) => { if (n === 1) { writeFileSync(plan, '변조'); return scopeOut(); } } });
  const r = go(dir, agent, { stageAttempts: 1, loopAttempts: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.includes('원본이 수정됨')));
});

test('실행 실패도 시도로 세고 재시도한다', () => {
  const { dir } = fixture();
  const agent = fakeAgent({ critic: (n) => (n === 1 ? 'fail' : undefined) });
  assert.equal(go(dir, agent).ok, true);
  assert.equal(agent.calls.filter((c) => c.stage === 'critic').length, 2);
});

test('원본·결정이 그대로면 에이전트를 부르지 않는다', () => {
  const { dir } = fixture(); const first = fakeAgent(); go(dir, first);
  const again = fakeAgent(); const r = go(dir, again);
  assert.equal(r.skipped, true); assert.equal(again.calls.length, 0);
});

test('검토 수준이 바뀌면 같은 원본·결정이어도 범위만 이어받고 계획서는 처음부터 다시 해석하며, 프롬프트에 수준이 실린다', () => {
  const { dir } = fixture(); go(dir, fakeAgent());
  const same = fakeAgent(); assert.equal(go(dir, same, { level: 5 }).skipped, true); assert.equal(same.calls.length, 0);
  const lower = fakeAgent(); const r = go(dir, lower, { level: 2 });
  assert.equal(r.skipped, undefined);
  assert.equal(lower.calls.filter((c) => c.stage === 'scope').length, 0);
  assert.ok(lower.calls.filter((c) => c.stage === 'interpret').every((c) => c.prompt.includes('검토 수준 2/10') && !c.prompt.includes('기존 계획서가 workplan.json')));
  assert.equal(JSON.parse(readFileSync(join(dir, 'run-status.json'), 'utf8')).level, 2);
});

test('결정만 바뀌면 범위는 이어받고 기존 계획서 위에서 해석만 다시 한다', () => {
  const { dir } = fixture(); go(dir, fakeAgent());
  decide(dir, 'R1', 'follow-existing', '기존 패턴 따름');
  const agent = fakeAgent(); const r = go(dir, agent);
  assert.equal(r.ok, true);
  assert.equal(agent.calls.filter((c) => c.stage === 'scope').length, 0);
  const interp = agent.calls.find((c) => c.stage === 'interpret');
  assert.ok(interp.prompt.includes('기존 계획서가 workplan.json') && interp.prompt.includes('R1 (follow-existing)'));
  assert.ok(Array.isArray(JSON.parse(readFileSync(join(dir, 'run-status.json'), 'utf8')).changedIds));
});

test('비평의 지적에 근거(evidence)가 없으면 막힌다', () => {
  const { dir } = fixture();
  const agent = fakeAgent({ critic: (n) => { if (n === 1) return { findings: [{ ...criticOut().findings[0], evidence: '' }] }; } });
  assert.equal(go(dir, agent).ok, true);
  assert.ok(agent.calls.filter((c) => c.stage === 'critic')[1].prompt.includes('evidence'));
});

test('러너 명령: claude 와 codex 는 같은 입력으로 각자의 플래그를 만든다', () => {
  const spec = { model: 'm1', effort: 'high', role: 'ROLE', prompt: 'P', cwd: '/c', addDirs: ['/d'], gitRepos: ['/r'], schemaFile: '/s.json' };
  const c = buildCommand({ ...spec, runner: 'claude' });
  assert.ok(c.args.includes('--json-schema') && c.args.includes('--no-session-persistence') && c.args.includes('--strict-mcp-config'));
  assert.equal(c.args[c.args.indexOf('--model') + 1], 'm1'); assert.equal(c.args[c.args.indexOf('--effort') + 1], 'high');
  assert.ok(c.args.includes('Write(stages/**)')); assert.ok(!c.args.includes('--dangerously-skip-permissions'));
  assert.ok(c.args.includes('--add-dir'));
  assert.ok(c.args.includes('Bash(git -C /r show:*)') && c.args.includes('Bash(git -C /r grep:*)'));
  assert.ok(!c.args.some((a) => /git -C \*|commit|push|checkout/.test(a)));
  const x = buildCommand({ ...spec, runner: 'codex' });
  assert.equal(x.args[0], 'exec'); assert.ok(x.args.includes('--output-schema') && x.args.includes('--ephemeral'));
  assert.equal(x.args[x.args.indexOf('-m') + 1], 'm1'); assert.ok(x.args.includes('model_reasoning_effort=high'));
  assert.ok(x.args.at(-1).startsWith('ROLE') && x.args.at(-1).endsWith('P'));
  assert.ok(!x.args.includes('--add-dir'));
  assert.throws(() => buildCommand({ ...spec, runner: 'bogus' }), /runner/);
  assert.ok(!buildCommand({ ...spec, runner: 'claude', model: undefined }).args.includes('--model'));
});

test('설정: 단계별 runner·모델을 환경변수와 사례 설정으로 바꾼다', () => {
  const { dir } = fixture();
  assert.equal(loadConfig(dir, {}).stages.critic.model, 'opus');
  const cfg = loadConfig(dir, { KH_CRITIC_RUNNER: 'codex', KH_CRITIC_MODEL: 'gpt-x', KH_MODEL: 'haiku' });
  assert.equal(cfg.stages.critic.runner, 'codex'); assert.equal(cfg.stages.critic.model, 'gpt-x'); assert.equal(cfg.stages.interpret.model, 'haiku');
  // runner 를 바꾸면 기본 설정의 모델은 상속되지 않는다
  const other = loadConfig(dir, { KH_SCOPE_RUNNER: 'codex' });
  assert.equal(other.stages.scope.runner, 'codex'); assert.equal(other.stages.scope.model, undefined); assert.equal(other.stages.scope.effort, undefined);
  writeFileSync(join(dir, 'kh.config.json'), JSON.stringify({ limits: { loopAttempts: 1 }, stages: { scope: { runner: 'codex', model: 'm', effort: 'low' } } }));
  const c2 = loadConfig(dir, {});
  assert.equal(c2.limits.loopAttempts, 1); assert.equal(c2.limits.stageAttempts, 3); assert.equal(c2.stages.scope.runner, 'codex');
});

test('세션: 같은 주제는 세션 id 로 잇고, 비평은 새 세션이며, 재실행·재시작의 세션 규칙을 지킨다', () => {
  const { dir } = fixture(); const agent = fakeAgent();
  go(dir, agent);
  const by = (stage) => agent.calls.filter((c) => c.stage === stage).map((c) => c.spec.session);
  const [s1] = by('scope'); const [i1] = by('interpret'); const [c1] = by('critic');
  assert.equal(s1.mode, 'new'); assert.match(s1.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(i1, { mode: 'resume', id: s1.id }); // 범위 → 해석은 같은 세션을 잇는다
  assert.equal(c1, undefined); // 비평은 1회성 새 세션(생산자≠검증자)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')), { claude: s1.id });
  // 결정만 바뀐 재실행은 같은 주제 세션을 잇는다
  decide(dir, 'R1', 'decided', '확정');
  const again = fakeAgent(); go(dir, again);
  assert.deepEqual(again.calls.find((c) => c.stage === 'interpret').spec.session, { mode: 'resume', id: s1.id });
  // --force 는 새 세션이다
  const forced = fakeAgent(); go(dir, forced, { force: true });
  assert.equal(forced.calls.find((c) => c.stage === 'scope').spec.session.mode, 'new');
  assert.notEqual(forced.calls.find((c) => c.stage === 'scope').spec.session.id, s1.id);
});

test('세션: 전체 루프를 다시 시작하면 새 세션이고, 이어가기가 실패하면 새로 시작한다', () => {
  const { dir } = fixture();
  const agent = fakeAgent({ interpret: (n) => { if (n === 1) { const d = draftOut(); d.tasks = []; return d; } } });
  go(dir, agent, { stageAttempts: 1, loopAttempts: 2 });
  const scopes = agent.calls.filter((c) => c.stage === 'scope');
  assert.equal(scopes.length, 2); assert.notEqual(scopes[0].spec.session.id, scopes[1].spec.session.id);
  assert.equal(agent.calls.filter((c) => c.stage === 'interpret')[1].spec.session.id, scopes[1].spec.session.id);
});

test('세션: codex 는 첫 호출의 출력에서 세션 id 를 받아 이어간다', () => {
  const { dir } = fixture();
  const calls = [];
  const run = (spec) => {
    const stage = spec.prompt.includes('workplan.draft') ? 'interpret' : spec.prompt.includes('critic.json') ? 'critic' : 'scope';
    calls.push({ stage, session: spec.session });
    mkdirSync(join(spec.cwd, 'stages'), { recursive: true });
    const file = { scope: 'scope.json', interpret: 'workplan.draft.json', critic: 'critic.json' }[stage];
    writeFileSync(join(spec.cwd, 'stages', file), JSON.stringify({ scope: scopeOut(), interpret: draftOut(), critic: criticOut() }[stage]));
    return { ok: true, status: { status: 'done', message: 'ok' }, tokens: 1, seconds: 0, costUsd: 0, sessionId: stage === 'scope' ? 'aaaaaaaa-0000-0000-0000-000000000001' : undefined };
  };
  runPipeline(dir, { env: { KH_SCOPE_RUNNER: 'codex', KH_INTERPRET_RUNNER: 'codex', KH_CRITIC_RUNNER: 'codex' } }, { runAgent: run, log: () => {} });
  assert.deepEqual(calls[0].session, { mode: 'new', id: undefined });
  assert.deepEqual(calls[1].session, { mode: 'resume', id: 'aaaaaaaa-0000-0000-0000-000000000001' });
});

test('러너 명령: 세션 모드별 플래그', () => {
  const base = { model: 'm', role: 'R', prompt: 'P', cwd: '/c', schemaFile: '/s.json' };
  const fresh = buildCommand({ ...base, runner: 'claude' }).args;
  assert.ok(fresh.includes('--no-session-persistence') && !fresh.includes('--session-id') && !fresh.includes('--resume'));
  const nu = buildCommand({ ...base, runner: 'claude', session: { mode: 'new', id: 'U' } }).args;
  assert.equal(nu[nu.indexOf('--session-id') + 1], 'U'); assert.ok(!nu.includes('--no-session-persistence'));
  const re = buildCommand({ ...base, runner: 'claude', session: { mode: 'resume', id: 'U' } }).args;
  assert.equal(re[re.indexOf('--resume') + 1], 'U'); assert.ok(!re.includes('--session-id'));
  assert.ok(buildCommand({ ...base, runner: 'codex' }).args.includes('--ephemeral'));
  assert.ok(!buildCommand({ ...base, runner: 'codex', session: { mode: 'new' } }).args.includes('--ephemeral'));
  const cr = buildCommand({ ...base, runner: 'codex', session: { mode: 'resume', id: 'U' } }).args;
  assert.deepEqual(cr.slice(0, 2), ['exec', 'resume']); assert.ok(cr.includes('U'));
});

test('러너 환경: 터미널 래퍼를 PATH 에서 빼고 권한 대화를 열지 않는다', () => {
  const env = cleanEnv({ PATH: '/tmp/x/cmux-cli-shims/ABC:/usr/bin:/bin', HOME: '/h' });
  assert.equal(env.PATH, '/usr/bin:/bin'); assert.equal(env.CMUX_CLAUDE_HOOKS_DISABLED, '1'); assert.equal(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1'); assert.equal(env.HOME, '/h');
  assert.equal(which('/abs/claude', '/usr/bin'), '/abs/claude'); assert.equal(which('definitely-not-a-cmd', '/usr/bin'), 'definitely-not-a-cmd');
  const args = buildCommand({ runner: 'claude', role: 'R', prompt: 'P', cwd: '/c' }).args;
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
});

test('비평은 해석 게이트를 통과한 계획서 파일을 입력으로 받는다', () => {
  const { dir } = fixture(); const agent = fakeAgent();
  go(dir, agent);
  const critic = agent.calls.find((c) => c.stage === 'critic');
  assert.ok(critic.prompt.includes('stages/workplan.checked.json'));
  assert.ok(existsSync(join(dir, 'stages', 'workplan.checked.json')));
});

test('참조 카탈로그: 파일·코드 레포의 접근 방법과 없는 자료를 알려 준다', () => {
  const { dir } = fixture();
  const repo = mkdtempSync(join(tmpdir(), 'kh-repo-')); mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  execFileSync('git', ['-C', repo, 'init', '-q']); execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'i']);
  const inputs = JSON.parse(readFileSync(join(dir, 'inputs.json'), 'utf8'));
  inputs.inputs.push({ id: 'be', kind: 'code', role: 'implementation', repo, ref: 'HEAD', paths: ['src'], fetch: false, note: '백엔드 레포' });
  writeFileSync(join(dir, 'inputs.json'), JSON.stringify(inputs));
  register(dir); extract(dir);
  const c = buildCatalog(dir);
  const plan = c.sources.find((s) => s.id === 'plan1'); const be = c.sources.find((s) => s.id === 'be');
  assert.equal(plan.access, 'file'); assert.ok(plan.location.startsWith('사례 폴더 안')); assert.ok(plan.lines > 0);
  assert.equal(be.access, 'git'); assert.ok(be.read.some((r) => r.includes('git -C') && r.includes('grep')));
  assert.deepEqual(c.missingRoles.sort(), ['context', 'contract', 'design']);
  assert.ok(c.warnings.some((w) => w.startsWith('contract:') && w.includes('단정하지 않는다')));
  assert.ok(existsSync(join(dir, 'references.json')));
});

test('참조 카탈로그는 모든 단계의 프롬프트에 들어가고, 없는 자료는 지어내지 않게 한다', () => {
  const { dir } = fixture(); const agent = fakeAgent(); go(dir, agent);
  for (const c of agent.calls) assert.ok(c.prompt.includes('[참조 카탈로그') && c.prompt.includes('missingInputs') && c.prompt.includes('plan1 (plan, plan-html)'));
  assert.ok(agent.calls[0].prompt.includes('계약') && agent.calls[0].prompt.includes('없는 자료'));
});

test('필요한 자료가 입력에 없다고 알리면 재시도하지 않고 입력 보강을 요청한다', () => {
  const { dir } = fixture();
  const agent = fakeAgent({ interpret: () => 'needs-input' });
  const r = go(dir, agent);
  assert.equal(r.ok, false); assert.deepEqual(r.needsInput, ['백엔드 레포 — 응답 필드 확인에 필요']);
  assert.equal(agent.calls.filter((c) => c.stage === 'interpret').length, 1); // 재시도하지 않는다
  assert.equal(agent.calls.filter((c) => c.stage === 'critic').length, 0);
  const status = JSON.parse(readFileSync(join(dir, 'run-status.json'), 'utf8'));
  assert.equal(status.result, 'needs-input'); assert.equal(status.missingInputs.length, 1);
  assert.ok(existsSync(join(dir, 'stages', 'scope.json'))); // 지금까지의 작업은 보존한다
});
