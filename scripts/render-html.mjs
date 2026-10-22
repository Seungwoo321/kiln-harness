// S6 render (HTML) — workplan.json 을 단일 HTML 로 렌더한다. 외부 리소스 없이 열린다.
import { canonical, sha256 } from './register.mjs';

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const code = (v) => `<code>${esc(v)}</code>`;
const json = (v) => (typeof v === 'string' ? esc(v) : `<pre>${esc(JSON.stringify(v, null, 2))}</pre>`);
const refs = (rs = []) => rs.map((r) => `<span class="ref">${code(r.sourceId)} ${esc(r.locator)}</span>`).join('');
const pill = (text, tone) => `<span class="pill ${tone}">${esc(text)}</span>`;
const basis = (x) => (x.basis === 'inferred' ? pill(`추론 → ${x.question}`, 'warn') : pill('원본', 'ok'));
const table = (head, rows) => rows.length === 0 ? '<p class="empty">없음</p>'
  : `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const list = (items) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
const MATCH = { exact: 'ok', adapt: 'info', custom: 'warn' };

export function renderHtml(p) {
  const bySurface = (items) => p.surfaces.map((s) => [s, items.filter((x) => x.surface === s.id)]);
  const tree = (s) => {
    const nodes = p.components.filter((c) => c.surface === s.id);
    const walk = (parent) => {
      const kids = nodes.filter((c) => (c.parent ?? null) === parent);
      if (kids.length === 0) return '';
      return `<ul class="tree">${kids.map((c) => `<li><div class="node"><b>${esc(c.name)}</b> ${pill(c.fileStatus, c.fileStatus === 'new' ? 'info' : 'mute')} ${pill(c.ds.match, MATCH[c.ds.match])}<div class="file">${code(c.file)}</div><div class="ds">DS: ${esc(c.ds.component ?? '—')}</div><div class="why">${esc(c.ds.reason)}</div></div>${walk(c.id)}</li>`).join('')}</ul>`;
    };
    return walk(null) || '<p class="empty">없음</p>';
  };
  const sections = [
    ['scope', '범위', `${table(['화면', '진입', '구분', '출처'], p.surfaces.map((s) => [`<b>${esc(s.title)}</b><br>${code(s.id)}`, esc(s.entry), pill(s.change, s.change === 'new' ? 'info' : 'mute'), refs(s.sourceRefs)]))}
      <h3>제외</h3>${table(['대상', '이유', '출처'], (p.excluded ?? []).map((x) => [esc(x.title), esc(x.reason), refs(x.sourceRefs)]))}`],
    ['requirements', '요구사항', bySurface(p.requirements).map(([s, rs]) => `<h3>${esc(s.title)}</h3>${table(['id', '요구사항', '수용기준', '근거', '출처'], rs.map((r) => [code(r.id), esc(r.statement), list(r.acceptance), basis(r), refs(r.sourceRefs)]))}`).join('')],
    ['states', '상태', bySurface(p.states).map(([s, ss]) => `<h3>${esc(s.title)}</h3>${table(['구역', '상태', '조건', '표시', '동작', '근거'], ss.map((x) => [esc(x.region), `<b>${esc(x.state)}</b>`, esc(x.condition), esc(x.display), esc(x.behavior ?? ''), basis(x)]))}`).join('')],
    ['components', '컴포넌트 배치', p.surfaces.map((s) => `<h3>${esc(s.title)}</h3>${tree(s)}`).join('')],
    ['api', 'API 연결', table(['operationId', '화면 · 컴포넌트', '시점', '요청', '응답 → 화면', '오류 → 화면'], p.apiBindings.map((b) => [code(b.operationId), `${code(b.surface)}<br>${code(b.component)}`, pill(b.trigger, 'mute'), json(b.request), json(b.response), json(b.errors)]))],
    ['i18n', 'i18n', `<details><summary>${(p.i18n ?? []).length}개 키</summary>${table(['키', '구분', '문구'], (p.i18n ?? []).map((k) => [code(k.key), pill(k.status, k.status === 'new' ? 'info' : 'mute'), esc(k.text ?? '')]))}</details>`],
    ['gaps', '현재 구현과의 차이', table(['id', '화면', '현재', '목표', '파일'], p.gaps.map((g) => [code(g.id), code(g.surface), esc(g.current), esc(g.target), g.file ? code(g.file) : '']))],
    ['tasks', '작업 순서', table(['id', '작업', '파일', '선행', '티켓', '다루는 항목'], p.tasks.map((t) => [code(t.id), `<b>${esc(t.title)}</b>`, t.files.map(code).join('<br>'), esc((t.dependsOn ?? []).join(', ')), esc(t.ticket ?? ''), `<span class="small">${esc((t.covers ?? []).join(', '))}</span>`]))
      + ((p.newFiles ?? []).length ? `<h3>새 파일</h3>${table(['파일', '이유'], p.newFiles.map((f) => [code(f.file), esc(f.reason)]))}` : '')],
    ['questions', '확인 필요', table(['id', '대상', '질문', '선택지', '기본 가정', '영향'], p.questions.map((q) => [code(q.id), pill(q.to, 'warn'), esc(q.question), list(q.options ?? []), esc(q.assumption), `<span class="small">${esc((q.impact ?? []).join(', '))}</span>`]))],
  ];
  const counts = [['화면', p.surfaces.length], ['요구사항', p.requirements.length], ['상태', p.states.length], ['컴포넌트', p.components.length], ['API', p.apiBindings.length], ['작업', p.tasks.length], ['확인 필요', p.questions.length]];

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.title ?? p.caseId)}</title>
<style>
:root{--bg:#fff;--fg:#1d2430;--mute:#5b6675;--line:#e3e7ee;--card:#f7f8fb;--ok:#1f7a4d;--okb:#e5f4ec;--info:#1f5fbf;--infob:#e6eefb;--warn:#9a5b00;--warnb:#fdf1dc;--codeb:#eef1f6}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--fg:#e4e8ef;--mute:#9aa5b5;--line:#2a313c;--card:#1a1f27;--ok:#6fd39f;--okb:#183427;--info:#8db6ff;--infob:#1a2a45;--warn:#f0bd6a;--warnb:#3a2c12;--codeb:#232a35}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard",sans-serif}
header{padding:28px 32px 16px;border-bottom:1px solid var(--line)}h1{margin:0 0 8px;font-size:22px}.meta{color:var(--mute);font-size:12px}
.summary{margin:12px 0 0;white-space:pre-line}.counts{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.count{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 12px}.count b{font-size:16px;margin-left:6px}
nav{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:8px 32px;display:flex;gap:14px;flex-wrap:wrap;z-index:2}nav a{color:var(--info);text-decoration:none;font-size:13px}
main{padding:8px 32px 64px;width:100%}section{margin-top:28px}h2{font-size:18px;border-left:4px solid var(--info);padding-left:10px}h3{font-size:15px;margin:20px 0 8px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid var(--line);padding:6px 8px;vertical-align:top;text-align:left}th{background:var(--card);white-space:nowrap}
td ul{margin:0;padding-left:18px}code{background:var(--codeb);padding:1px 5px;border-radius:4px;font-size:12px;word-break:break-all}pre{margin:0;background:var(--codeb);padding:6px;border-radius:6px;font-size:11.5px;white-space:pre-wrap}
.ref{display:block;font-size:12px;color:var(--mute)}.pill{display:inline-block;border-radius:999px;padding:0 8px;font-size:11.5px;font-weight:600;white-space:nowrap}
.ok{background:var(--okb);color:var(--ok)}.info{background:var(--infob);color:var(--info)}.warn{background:var(--warnb);color:var(--warn)}.mute{background:var(--codeb);color:var(--mute)}
.tree{list-style:none;padding-left:18px;border-left:1px dashed var(--line);margin:6px 0}.tree>li{margin:8px 0}main>section .tree:first-of-type{padding-left:0;border-left:0}
.node{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px}.file{margin-top:4px}.ds{font-size:12.5px;margin-top:2px}.why{color:var(--mute);font-size:12.5px}
.small{font-size:12px;color:var(--mute)}.empty{color:var(--mute)}details summary{cursor:pointer;color:var(--info)}
@media (max-width:720px){header,main,nav{padding-left:16px;padding-right:16px}}
</style></head><body>
<header><h1>${esc(p.title ?? p.caseId)}</h1><div class="meta">digest ${esc(sha256(canonical(p)).slice(0, 12))} · 원본 ${p.inputDigests.length}건 · workplan.json 에서 렌더</div>
${p.summary ? `<p class="summary">${esc(p.summary)}</p>` : ''}<div class="counts">${counts.map(([k, v]) => `<span class="count">${esc(k)}<b>${v}</b></span>`).join('')}</div></header>
<nav>${sections.map(([id, t], i) => `<a href="#${id}">${i + 1}. ${esc(t)}</a>`).join('')}</nav>
<main>${sections.map(([id, t, body], i) => `<section id="${id}"><h2>${i + 1}. ${esc(t)}</h2>${body}</section>`).join('')}</main>
</body></html>
`;
}
