// 터미널 실시간 표시 — 에이전트가 도는 동안 단계·시도·경과 시간·지금 하는 일(읽고 쓰는 파일, 도구)을 같은 자리에서 갱신한다.
// 영구 로그([단계] 메시지)는 표시 블록을 지우고 찍는다. TTY 가 아니면 블록 대신 1분마다 한 줄 신호만 낸다.
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const wide = (ch) => { const c = ch.codePointAt(0); return c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xff60)); };
export function fit(s, cols) {
  let w = 0; let out = '';
  for (const ch of String(s).replace(/\s+/g, ' ')) { const n = wide(ch) ? 2 : 1; if (w + n > cols - 1) return `${out}…`; w += n; out += ch; }
  return out;
}
export const mmss = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const kfmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

// ANSI 색상 — TTY 이고 NO_COLOR 가 없을 때만 켠다(FORCE_COLOR 가 있으면 TTY 가 아니어도 켠다). 꺼지면 글자만 낸다.
const CODES = { bold: '1', dim: '2', red: '31', green: '32', yellow: '33', blue: '34', magenta: '35', cyan: '36' };
export const colorOn = (stream, env = process.env) => (env.NO_COLOR ? false : Boolean(env.FORCE_COLOR) || Boolean(stream.isTTY));
export const paintText = (on, style, text) => (on && style ? `${style.split(' ').map((k) => `\x1b[${CODES[k]}m`).join('')}${text}\x1b[0m` : text);
// [[글자, 스타일], …] 을 보이는 폭 cols 안에서 자르고 색을 입힌다. 폭 계산은 색 코드를 빼고 한다.
export function paintLine(on, segs, cols) {
  let left = cols - 1; let out = '';
  for (const [text, style] of segs) {
    if (left <= 0) break;
    const t = fit(text, left + 1); const w = [...t].reduce((n, ch) => n + (wide(ch) ? 2 : 1), 0);
    out += paintText(on, style, t); left -= w;
    if (t.endsWith('…') && t !== String(text).replace(/\s+/g, ' ')) break;
  }
  return out;
}
// 경과 시간 색: 5분 미만 초록, 15분 미만 노랑, 그 이상 빨강 — 오래 걸리는 시도를 눈에 띄게 한다.
export const elapsedStyle = (sec) => (sec < 300 ? 'green' : sec < 900 ? 'yellow' : 'red');
const TOOL_STYLE = { Read: 'blue', Grep: 'blue', Glob: 'blue', Bash: 'yellow', Write: 'green', Edit: 'green' };
// 영구 로그 한 줄: [태그] 를 굵게 입히고, 결과를 뜻하는 말은 색을 달리한다.
export function logLine(on, tag, msg) {
  const style = /실패|위반|멈춤|수정 감지|통과하지 못/.test(msg) ? 'red' : /^통과|reused|완료/.test(msg) ? 'green' : /보강 필요|바뀌어/.test(msg) ? 'yellow' : null;
  return `${paintText(on, 'bold cyan', `[${tag}]`)} ${paintText(on, style, msg)}`;
}

export function createLive(stream = process.stdout, env = process.env) {
  const tty = Boolean(stream.isTTY);
  const color = colorOn(stream, env);
  let drawn = 0;
  const clear = () => { if (tty && drawn) { stream.write(`\x1b[${drawn}A\x1b[0J`); drawn = 0; } };
  return {
    tty,
    color,
    cols: () => stream.columns || 100,
    print(msg) { clear(); stream.write(`${msg}\n`); },
    draw(lines) { if (!tty) return; clear(); stream.write(`${lines.join('\n')}\n`); drawn = lines.length; },
    clear,
  };
}

// 로그 파일을 이어 읽으며 에이전트 활동을 요약한다. claude 는 stream-json 줄, codex 는 일반 텍스트 줄이다.
const describe = (name, input = {}, root) => {
  const rel = (p) => String(p ?? '').replace(root ? `${root}/` : '', '');
  if (name === 'Read') return `Read ${rel(input.file_path)}`;
  if (name === 'Write' || name === 'Edit') return `${name} ${rel(input.file_path)}`;
  if (name === 'Grep') return `Grep ${input.pattern ?? ''}`;
  if (name === 'Glob') return `Glob ${input.pattern ?? ''}`;
  if (name === 'Bash') return `Bash ${rel(input.command)}`;
  if (name === 'StructuredOutput') return '결과 보고';
  return name;
};

export function createActivity(root) {
  const states = new Map();
  return (logFile) => {
    let st = states.get(logFile);
    if (!st) { st = { offset: 0, partial: '', tools: [], toolCount: 0, outTokens: 0, text: '' }; states.set(logFile, st); }
    let size = 0;
    try { size = statSync(logFile).size; } catch { return st; }
    if (size > st.offset) {
      const fd = openSync(logFile, 'r');
      try {
        const buf = Buffer.alloc(size - st.offset);
        readSync(fd, buf, 0, buf.length, st.offset);
        st.offset = size;
        const text = st.partial + buf.toString('utf8');
        const lines = text.split('\n');
        st.partial = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let d = null;
          if (line.startsWith('{')) { try { d = JSON.parse(line); } catch { d = null; } }
          if (!d) { st.text = line.trim(); continue; }
          if (d.type === 'assistant') {
            st.outTokens += d.message?.usage?.output_tokens ?? 0;
            for (const c of d.message?.content ?? []) {
              if (c.type === 'tool_use') { st.toolCount += 1; st.tools.push(describe(c.name, c.input, root)); if (st.tools.length > 3) st.tools.shift(); }
              if (c.type === 'text' && c.text?.trim()) st.text = c.text.trim();
            }
          }
        }
      } finally { closeSync(fd); }
    }
    return st;
  };
}

// deps.tick 으로 쓰인다. overview() = { level, startedAt, stages:[[name,result,attempts]], totals:{calls,tokens,costUsd} }
export function createTicker({ live, root, overview }) {
  const activity = createActivity(root);
  let lastBeat = 0;
  return {
    tick(t) {
      const st = activity(t.logFile);
      const o = overview();
      const head = `${t.stage} 시도 ${t.attempt}/${t.max} · ${t.cfg.runner}/${t.cfg.model ?? '기본'}${t.cfg.effort ? `/${t.cfg.effort}` : ''}`;
      if (!live.tty) {
        if (t.elapsedSec - lastBeat >= 60) { lastBeat = t.elapsedSec; live.print(`[${t.stage}] 진행 중 · ${mmss(t.elapsedSec)} 경과 · 도구 ${st.toolCount}회`); }
        return;
      }
      const cols = live.cols();
      const on = live.color;
      const mark = { passed: ['✓', 'green'], reused: ['✓', 'green'], running: ['▶', 'cyan bold'], failed: ['✗', 'red bold'], 'needs-input': ['!', 'yellow bold'], pending: ['·', 'dim'] };
      const flow = o.stages.flatMap(([n, r], i) => {
        const [m, st] = n === t.stage ? ['▶', 'cyan bold'] : mark[r] ?? ['·', 'dim'];
        return [...(i ? [['  ', null]] : []), [n, n === t.stage ? 'bold' : null], [m, st]];
      });
      const recent = st.tools.length ? st.tools : [st.text || '시작하는 중…'];
      const toolSegs = (x) => { const [name, ...rest] = x.split(' '); return TOOL_STYLE[name] ? [[name, TOOL_STYLE[name]], [` ${rest.join(' ')}`, null]] : [[x, null]]; };
      live.draw([
        paintLine(on, [['━ ', 'dim'], [`검토 수준 ${o.level}/10`, 'bold'], [' · 전체 ', 'dim'], [mmss((Date.now() - o.startedAt) / 1000), 'bold'], [' 경과 · ', 'dim'], ...flow], cols),
        paintLine(on, [['▶ ', 'cyan bold'], [t.stage, 'cyan bold'], [` 시도 ${t.attempt}/${t.max}`, 'bold'], [` · ${t.cfg.runner}/${t.cfg.model ?? '기본'}${t.cfg.effort ? `/${t.cfg.effort}` : ''}`, 'magenta'], [' · ', 'dim'], [mmss(t.elapsedSec), `${elapsedStyle(t.elapsedSec)} bold`], [' 경과', 'dim'], [` · 도구 ${st.toolCount}회`, null], ...(st.outTokens ? [[` · 출력 ${kfmt(st.outTokens)} 토큰`, 'dim']] : [])], cols),
        ...recent.map((x, i) => paintLine(on, [[`   ${i === 0 ? '최근' : '    '} `, 'dim'], ...toolSegs(x)], cols)),
        paintLine(on, [['   누적 호출 ', 'dim'], [String(o.totals.calls), 'bold'], [' · 토큰 ', 'dim'], [kfmt(o.totals.tokens), 'bold'], [' · ', 'dim'], [`$${o.totals.costUsd.toFixed(2)}`, 'yellow bold']], cols),
      ]);
    },
    end() { live.clear(); },
  };
}
