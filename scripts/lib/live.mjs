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

export function createLive(stream = process.stdout) {
  const tty = Boolean(stream.isTTY);
  let drawn = 0;
  const clear = () => { if (tty && drawn) { stream.write(`\x1b[${drawn}A\x1b[0J`); drawn = 0; } };
  return {
    tty,
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
      const mark = { passed: '✓', reused: '✓', running: '▶', failed: '✗', 'needs-input': '!', pending: '·' };
      const flow = o.stages.map(([n, r]) => `${n}${n === t.stage ? '▶' : mark[r] ?? '·'}`).join('  ');
      const recent = st.tools.length ? st.tools : [st.text || '시작하는 중…'];
      live.draw([
        fit(`━ 검토 수준 ${o.level}/10 · 전체 ${mmss((Date.now() - o.startedAt) / 1000)} 경과 · ${flow}`, cols),
        fit(`▶ ${head} · ${mmss(t.elapsedSec)} 경과 · 도구 ${st.toolCount}회${st.outTokens ? ` · 출력 ${kfmt(st.outTokens)} 토큰` : ''}`, cols),
        ...recent.map((x, i) => fit(`   ${i === 0 ? '최근' : '    '} ${x}`, cols)),
        fit(`   누적 호출 ${o.totals.calls} · 토큰 ${kfmt(o.totals.tokens)} · $${o.totals.costUsd.toFixed(2)}`, cols),
      ]);
    },
    end() { live.clear(); },
  };
}
