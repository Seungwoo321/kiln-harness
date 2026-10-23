// 에이전트 러너 — 같은 역할 md·프롬프트를 `claude -p` 또는 `codex exec` 로 1회성 실행한다. 단계마다 새 세션이다.
// 모델·effort 는 이름을 코드에 박지 않고 설정(kh.config.json)에서 그대로 넘긴다 — 두 CLI 가 지원하는 모델이면 무엇이든 된다.
// 에이전트는 파일을 쓰고(결과물), 최종 응답은 작은 상태 JSON 이다. 결과물의 합격 여부는 스크립트(게이트)가 판정한다.
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, accessSync, openSync, closeSync, constants } from 'node:fs';
import { join } from 'node:path';

export const STATUS_SCHEMA = {
  type: 'object',
  properties: { status: { type: 'string', enum: ['done', 'blocked'] }, message: { type: 'string' }, missingInputs: { type: 'array', items: { type: 'string' } } },
  required: ['status', 'message', 'missingInputs'],
  additionalProperties: false,
};

// 에이전트 실행 환경 — 터미널 멀티플렉서가 PATH 앞에 끼워 넣은 CLI 래퍼(cmux-cli-shims)는 권한 요청 훅을 주입해
// 사람의 응답을 기다리며 헤드리스 실행을 멈춘다(실측: 해석 단계 15분 정지). 래퍼를 PATH 에서 빼고 훅을 끈다.
export function cleanEnv(env = process.env) {
  const path = (env.PATH ?? '').split(':').filter((d) => d && !/cmux-cli-shims/.test(d)).join(':');
  // 상위 폴더의 CLAUDE.md·AGENTS.md 체인을 읽지 않게 한다 — 사례 폴더가 큰 워크스페이스 아래에 있어도 세션마다 수만 토큰이 붙지 않는다(실측 7.8만 → 2.0만).
  return { ...env, PATH: path, CMUX_CLAUDE_HOOKS_DISABLED: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' };
}
export function which(cmd, pathString) {
  if (cmd.includes('/')) return cmd;
  for (const dir of pathString.split(':')) {
    try { const f = join(dir, cmd); accessSync(f, constants.X_OK); return f; } catch { /* 다음 후보 */ }
  }
  return cmd;
}

// 읽기만 하는 도구와 stages/ 아래 쓰기만 허용한다. 원본·코드·결정 파일은 에이전트가 쓸 수 없다.
const CLAUDE_TOOLS = 'Read,Grep,Glob,Write,Edit,Bash';
// 카탈로그가 알려 주는 읽기 명령은 `git -C <repo> show ...` 형태라 `git show:*` 로는 매치되지 않는다(dontAsk 에서 조용히 거부된다).
// 와일드카드(`git -C * show *`)는 `git -C x commit -m "show"` 까지 매치하므로, 등록된 저장소 경로를 규칙에 직접 박는다.
export const gitReadRules = (repos = []) => repos.flatMap((r) => ['show', 'ls-tree', 'grep', 'cat-file'].map((c) => `Bash(git -C ${r} ${c}:*)`));
export const claudeAllowed = (extraBash = []) => [
  'Read', 'Grep', 'Glob', 'Write(stages/**)', 'Edit(stages/**)',
  'Bash(git show:*)', 'Bash(git ls-tree:*)', 'Bash(git grep:*)', 'Bash(git cat-file:*)', 'Bash(sed:*)', 'Bash(head:*)', 'Bash(wc:*)', 'Bash(ls:*)',
  ...extraBash,
];

// spec: { runner, model?, effort?, role, prompt, cwd, addDirs?, gitRepos?, schemaFile, session? }  →  { cmd, args, cwd }
// session: 없으면 1회성(세션을 남기지 않는다). { mode:'new', id? } 는 세션을 남기며 시작, { mode:'resume', id } 는 그 세션을 이어간다.
export function buildCommand(spec) {
  const { runner, model, effort, role, prompt, cwd, addDirs = [], gitRepos = [], schemaFile, session } = spec;
  if (runner === 'claude') {
    const sessionArgs = session?.mode === 'resume' ? ['--resume', session.id] : session?.mode === 'new' ? ['--session-id', session.id] : ['--no-session-persistence'];
    // stream-json: 도구 호출이 줄 단위로 로그에 쌓여 진행 상황을 볼 수 있다. 마지막 줄(result)이 json 형식과 같다.
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...sessionArgs,
      '--json-schema', JSON.stringify(STATUS_SCHEMA), '--append-system-prompt', role,
      // 앰비언트 컨텍스트(전역 규칙·훅·스킬·MCP)를 끊는다 — 실측 약 2.8만 → 3천 토큰.
      '--setting-sources', 'project', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--exclude-dynamic-system-prompt-sections', '--permission-mode', 'dontAsk', '--tools', CLAUDE_TOOLS, '--allowedTools', ...claudeAllowed(gitReadRules(gitRepos))];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    for (const d of addDirs) args.push('--add-dir', d);
    return { cmd: process.env.KH_CLAUDE || 'claude', args, cwd };
  }
  if (runner === 'codex') {
    // codex 에는 시스템 프롬프트 추가 플래그가 없어 역할을 프롬프트 앞에 붙인다. 읽기는 전체, 쓰기는 작업 디렉터리뿐(workspace-write).
    const resume = session?.mode === 'resume';
    const common = ['--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--disable', 'hooks', '--disable', 'apps', '--disable', 'image_generation', '--disable', 'multi_agent',
      '-c', 'web_search=disabled', '-c', 'sandbox_mode="workspace-write"', '--output-schema', schemaFile];
    const args = resume ? ['exec', 'resume', ...common] : ['exec', ...(session ? [] : ['--ephemeral']), ...common, '-s', 'workspace-write', '-C', cwd, '--color', 'never'];
    if (model) args.push('-m', model);
    if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
    if (resume) args.push(session.id);
    args.push(`${role}\n\n---\n\n${prompt}`);
    return { cmd: process.env.KH_CODEX || 'codex', args, cwd };
  }
  throw new Error(`알 수 없는 runner — ${runner} (claude|codex)`);
}

function parseClaude(stdout) {
  const d = JSON.parse(stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop());
  const u = d.usage ?? {};
  const tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
  return { ok: !d.is_error && d.structured_output && typeof d.structured_output === 'object', status: d.structured_output ?? null, error: d.is_error ? String(d.result ?? '') : null, tokens, costUsd: d.total_cost_usd ?? null, sessionId: d.session_id ?? null };
}

function parseCodex(stdout, lastFile) {
  let status = null;
  try { status = JSON.parse(readFileSync(lastFile, 'utf8')); } catch { /* 아래에서 실패로 처리 */ }
  const tokens = Number((stdout.match(/tokens used\s*\n\s*([\d,]+)/) ?? [])[1]?.replace(/,/g, '')) || null;
  const sessionId = (stdout.match(/session id:\s*([0-9a-f-]{36})/i) ?? [])[1] ?? null;
  return { ok: Boolean(status && typeof status === 'object'), status, error: status ? null : '구조화 응답을 받지 못했다', tokens, costUsd: null, sessionId };
}

// 실제 실행. 테스트는 이 함수 대신 가짜 runAgent 를 주입한다.
// 에이전트는 자식 프로세스로 띄우고 출력은 로그 파일에 쌓는다. 부모는 그동안 깨어나(spec.onTick) 진행 상황을 그린다.
// 같은 프로세스 그룹이라 Ctrl-C 가 에이전트에도 간다. 종료 여부는 ps 로 확인한다(이벤트 루프를 쓰지 않아 동기 API 를 유지한다).
const alive = (pid) => {
  if (!pid) return false;
  try { const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); return stat !== '' && !stat.startsWith('Z'); } catch { return false; } // 종료했지만 아직 회수 전(Z)이면 끝난 것이다
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function runAgent(spec) {
  const work = join(spec.cwd, 'stages');
  mkdirSync(work, { recursive: true });
  const schemaFile = join(work, '.status.schema.json');
  const lastFile = join(work, '.last-message.json');
  const logFile = join(work, `.agent-${spec.logName ?? spec.runner}.log`);
  writeFileSync(schemaFile, JSON.stringify(STATUS_SCHEMA));
  const { cmd, args, cwd } = buildCommand({ ...spec, schemaFile });
  const finalArgs = spec.runner === 'codex' ? [...args.slice(0, -1), '-o', lastFile, args.at(-1)] : args;
  rmSync(lastFile, { force: true });
  const started = Date.now();
  const env = cleanEnv();
  const fd = openSync(logFile, 'w');
  let child;
  try { child = spawn(which(cmd, env.PATH), finalArgs, { cwd, env, stdio: ['ignore', fd, fd] }); } finally { closeSync(fd); }
  child.on('error', () => {}); // 실행 파일이 없으면 pid 가 없다 — 아래에서 판정한다
  const deadline = started + (spec.timeoutSec ?? 1800) * 1000;
  let timedOut = false;
  while (alive(child.pid)) {
    if (Date.now() > deadline) { try { child.kill('SIGKILL'); } catch { /* 이미 종료 */ } timedOut = true; break; }
    spec.onTick?.({ elapsedSec: (Date.now() - started) / 1000, logFile, runner: spec.runner });
    sleep(spec.tickMs ?? 1000);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  const out = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  if (!child.pid) return { ok: false, status: null, error: `${cmd} 실행 실패 — 실행 파일을 찾을 수 없다`, tokens: null, costUsd: null, seconds };
  if (timedOut) return { ok: false, status: null, error: `${cmd} 시간 초과(${spec.timeoutSec ?? 1800}초)`, tokens: null, costUsd: null, seconds };
  try {
    const parsed = spec.runner === 'claude' ? parseClaude(out) : parseCodex(out, lastFile);
    if (!parsed.ok && spec.runner === 'codex') return { ...parsed, error: `${cmd} 구조화 응답 없음: ${out.slice(-400)}`, seconds };
    return { ...parsed, seconds };
  } catch (e) {
    return { ok: false, status: null, error: `응답을 해석하지 못했다 — ${e.message}: ${out.slice(-300)}`, tokens: null, costUsd: null, seconds };
  }
}

export const hasFile = existsSync;
