#!/usr/bin/env node
// 에이전트 기록 보기 — stages/.agent-*.log(claude stream-json·codex exec 출력)를 Claude Code 화면처럼 읽기 좋게 그린다.
//
// usage: node scripts/agent-log.mjs <case-dir> [--stage scope|interpret|critic] [--follow] [--full]
//   기본은 가장 최근 단계 로그. --follow 는 실행 중 로그를 따라가고, 다음 단계 로그가 생기면 그쪽으로 넘어간다.
//   --full 은 도구 결과를 줄이지 않고 다 보인다.
import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';

const tty = process.stdout.isTTY;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint('2'); const bold = paint('1'); const red = paint('31'); const green = paint('32'); const cyan = paint('36');

let cwd = ''; // init 줄의 작업 폴더 — 경로를 그 기준 상대 경로로 줄여 보인다
const rel = (s) => (cwd ? String(s).split(`${cwd}/`).join('') : String(s));
const one = (s, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// 도구 호출의 핵심 인자 하나를 고른다(Claude Code 의 «Bash(…)» 표기와 같은 모양).
export function toolLabel(name, input = {}) {
  const arg = input.description ?? input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url ?? '';
  return `${name}(${one(rel(arg), 120)})`;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return JSON.stringify(content ?? '');
}

// claude stream-json 한 줄 → 보일 줄들. 보일 것이 없으면 빈 배열(생각 토큰·rate limit 등).
export function renderClaudeLine(line, { full = false } = {}) {
  let o;
  try { o = JSON.parse(line); } catch { return line.trim() ? [line] : []; }
  if (o.type === 'system' && o.subtype === 'init') cwd = o.cwd ?? '';
  if (o.type === 'system' && o.subtype === 'init') return [dim(`세션 ${o.session_id} · 모델 ${o.model ?? '-'} · cwd ${o.cwd}`)];
  if (o.type === 'system' && o.subtype === 'permission_denied') return [red(`  ⛔ 거부: ${o.tool_name} — ${one(o.message, 120)}`)];
  if (o.type === 'result') {
    const u = o.usage ?? {};
    const tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const mark = o.is_error ? red('✗ 실패') : green('✓ 끝');
    return ['', `${mark} ${dim(`${Math.round((o.duration_ms ?? 0) / 1000)}초 · 토큰 ${tokens.toLocaleString()} · $${(o.total_cost_usd ?? 0).toFixed(2)}`)}`];
  }
  const blocks = Array.isArray(o.message?.content) ? o.message.content : [];
  const out = [];
  for (const b of blocks) {
    if (o.type === 'assistant' && b.type === 'text' && b.text.trim()) out.push('', `${bold('⏺')} ${b.text.trim()}`);
    else if (o.type === 'assistant' && b.type === 'tool_use') {
      if (b.name === 'StructuredOutput') out.push('', `${bold('⏺')} ${cyan('결과 제출')}`);
      else out.push('', `${bold('⏺')} ${cyan(toolLabel(b.name, b.input))}`);
    } else if (o.type === 'user' && b.type === 'tool_result') {
      const text = resultText(b.content).replace(/\s+$/, '');
      const lines = text ? text.split('\n') : [];
      const shown = full ? lines : lines.slice(0, 3);
      const head = b.is_error ? red('  ⎿ ✗ ') : dim('  ⎿ ');
      if (!lines.length) out.push(`${head}${dim('(출력 없음)')}`);
      shown.forEach((l, i) => out.push(`${i === 0 ? head : '    '}${dim(full ? rel(l) : one(rel(l), 150))}`));
      if (lines.length > shown.length) out.push(dim(`    … +${lines.length - shown.length}줄`));
    }
  }
  return out;
}

export const isClaudeLog = (text) => text.trimStart().startsWith('{');

export function render(text, opts = {}) {
  if (!isClaudeLog(text)) return text.split('\n'); // codex exec 출력은 이미 사람이 읽는 형식이다
  return text.split('\n').flatMap((l) => renderClaudeLine(l, opts));
}

export function agentLogs(caseDir) {
  const dir = join(caseDir, 'stages');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^\.agent-.*\.log$/.test(f)).map((f) => join(dir, f))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const title = (file) => `\n${bold(`━━ ${basename(file).replace(/^\.agent-|\.log$/g, '')} ━━`)}`;

function follow(caseDir, start, opts) {
  let file = start; let offset = 0; let rest = ''; let claude = null;
  console.log(title(file));
  for (;;) {
    const size = existsSync(file) ? statSync(file).size : 0;
    if (size > offset) {
      const fd = openSync(file, 'r'); const buf = Buffer.alloc(size - offset); readSync(fd, buf, 0, buf.length, offset); closeSync(fd);
      offset = size;
      const chunk = rest + buf.toString('utf8'); const parts = chunk.split('\n'); rest = parts.pop();
      claude ??= isClaudeLog(chunk);
      for (const l of parts) for (const out of claude ? renderClaudeLine(l, opts) : [l]) console.log(out);
    }
    const newest = agentLogs(caseDir).at(-1);
    if (newest && newest !== file && statSync(newest).mtimeMs > statSync(file).mtimeMs) { file = newest; offset = 0; rest = ''; claude = null; console.log(title(file)); }
    sleep(1000);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const caseDir = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--stage');
  if (!caseDir) { process.stderr.write('usage: node scripts/agent-log.mjs <case-dir> [--stage scope|interpret|critic] [--follow] [--full]\n'); process.exit(2); }
  const stage = argv.includes('--stage') ? argv[argv.indexOf('--stage') + 1] : null;
  const opts = { full: argv.includes('--full') };
  const logs = agentLogs(caseDir).filter((f) => !stage || basename(f).startsWith(`.agent-${stage}`));
  if (!logs.length) { process.stderr.write(`에이전트 로그가 없다 — ${join(caseDir, 'stages')}\n`); process.exit(1); }
  const file = logs.at(-1);
  if (argv.includes('--follow')) follow(caseDir, file, opts);
  else { console.log(title(file)); for (const l of render(readFileSync(file, 'utf8'), opts)) console.log(l); }
}
