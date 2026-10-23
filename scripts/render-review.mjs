#!/usr/bin/env node
// S6 render (검토 화면) — 검증을 통과한 workplan.json 을 사람이 판단하는 review.html 로 렌더한다.
// WORKPLAN.html(render-html.mjs)이 계획서 전체를 보여 주는 문서라면, 이 화면은 "무엇을 바꾸나·무엇이 불완전한가·무엇을 결정해야 하나"에 초점을 둔다.
// 읽기 전용 정적 HTML 이다(빌드·서버 불필요). 모든 항목에 id 가 있고, 터미널에서 그 id 로 결정(decide.mjs)을 남긴다.
// 같은 JSON·decisions 면 같은 HTML 이 나온다.
// usage: node scripts/render-review.mjs <case-dir>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validate } from './validate.mjs';
import { canonical, sha256 } from './register.mjs';
import { readDecisions, staleDecisions } from './decide.mjs';
import { conformanceSection } from './lib/conformance-view.mjs';

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (v) => esc(typeof v === 'string' ? v : JSON.stringify(v)).replace(/\n/g, '<br>');
const list = (xs = []) => (xs.length ? `<ul>${xs.map((x) => `<li>${text(x)}</li>`).join('')}</ul>` : '');

const KIND_LABEL = {
  'new-page': '새 페이지', 'new-menu': '새 메뉴', 'ds-component-new': '디자인 시스템 컴포넌트 신규', 'ds-component-edit': '디자인 시스템 컴포넌트 수정',
  'feature-change': '기존 피처 수정(배치·컴포넌트)', 'feature-copy': '문구 수정', i18n: '다국어', 'api-wiring': 'API 연결',
};
const STANCE_LABEL = {
  'follow-existing': '기존 패턴 따름', 're-review': '다시 검토', 'ask-plan': '기획 확인', 'ask-design': '디자인 확인', 'ask-backend': '백엔드 확인', decided: '결정함',
};
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

export function renderReview(caseDir) {
  const errors = validate(caseDir);
  if (errors.length) throw new Error(`validate 실패 ${errors.length}건 — 먼저 고친다`);
  const p = JSON.parse(readFileSync(join(caseDir, 'workplan.json'), 'utf8'));
  const decisions = new Map(readDecisions(caseDir).map((d) => [d.id, d]));
  const stale = new Set(staleDecisions(caseDir, p).map((d) => d.id));
  const v2 = p.schemaVersion >= 2;

  const decisionBadge = (id) => {
    const d = decisions.get(id);
    return d ? `<div class="decision${stale.has(id) ? ' stale' : ''}"><b>${esc(STANCE_LABEL[d.stance])}</b>${stale.has(id) ? ' · 항목이 바뀜, 재확인' : ''}<br>${text(d.note)}</div>` : '';
  };
  const idCell = (id) => `<td class="idc"><code class="id" id="${esc(id)}">${esc(id)}</code>${decisionBadge(id)}</td>`;
  const refs = (rs = []) => rs.map((r) => `<code>${esc(r.sourceId)}</code> ${esc(r.locator)}`).join('<br>');
  const basis = (x) => (x.resolution === 'pending' ? '<span class="tag warn">확인 필요</span>' : x.basis === 'inferred' ? `<span class="tag warn">추론</span> ${esc(x.question ?? x.decision)}` : '<span class="tag">원본</span>');
  const table = (head, rows) => (rows.length === 0 ? '<p class="none">없음</p>'
    : `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`);
  const row = (id, cells) => `<tr>${idCell(id)}${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  const section = (key, title, body, hint = '') => `<section id="sec-${key}"><h2>${esc(title)}</h2>${hint ? `<p class="hint">${hint}</p>` : ''}${body}</section>`;
  const surfaceTitle = (id) => esc(p.surfaces.find((s) => s.id === id)?.title ?? id);

  const findings = [...(p.findings ?? [])].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id));
  const kindCount = Object.entries(p.tasks.reduce((m, t) => ({ ...m, [t.changeKind ?? '-']: (m[t.changeKind ?? '-'] ?? 0) + 1 }), {})).sort();
  const open = [...(p.questions ?? []), ...findings].filter((x) => !decisions.has(x.id)).length;

  const cards = [
    ['화면', p.surfaces.length], ['요구사항', p.requirements.length], ['작업', p.tasks.length],
    ['지적', findings.length], ['확인 질문', (p.questions ?? []).length], ['결정 대기', open], ['결정함', decisions.size],
  ].map(([k, v]) => `<div class="card"><b>${v}</b><span>${k}</span></div>`).join('');

  const taskRows = [...p.tasks].sort((a, b) => (a.changeKind ?? '').localeCompare(b.changeKind ?? '') || a.id.localeCompare(b.id)).map((t) => row(t.id, [
    `<span class="tag kind">${esc(KIND_LABEL[t.changeKind] ?? t.changeKind ?? '—')}</span>`, text(t.title),
    t.files.map((f) => `<code>${esc(f)}</code>`).join('<br>'), esc((t.dependsOn ?? []).join(', ')), esc(t.ticket ?? '')]));

  const parts = [];
  parts.push(section('kinds', '무엇을 바꾸나 — 변경 유형별 작업',
    `<div class="chips">${kindCount.map(([k, n]) => `<span class="chip">${esc(KIND_LABEL[k] ?? k)} <b>${n}</b></span>`).join('')}</div>${table(['id', '유형', '작업', '파일', '선행', '티켓'], taskRows)}`,
    '디자인 시스템 수정·새 페이지·메뉴·기존 피처 수정·문구·다국어 중 어디에 해당하는지.'));
  if (v2) {
    parts.push(section('findings', '지적 — 산출물의 불완전한 부분', table(['id', '심각도', '위치', '지적', '권고'],
      findings.map((f) => row(f.id, [`<span class="tag sev-${esc(f.severity)}">${esc(f.severity)}</span>`, `<code>${esc(f.target)}</code> · ${esc(f.origin)}`,
        text(f.message) + (f.evidence ? `<div class="ev">${text(f.evidence)}</div>` : ''),
        `<span class="tag">${esc(STANCE_LABEL[f.stance])}</span><br>${text(f.recommendation)}`]))), '권고는 제안이다. 결정은 터미널에서 이 id 로 남긴다.'));
  }
  const linPath = join(caseDir, 'lineage.json');
  if (p.lineage && existsSync(linPath)) {
    const lin = JSON.parse(readFileSync(linPath, 'utf8'));
    const prevDecision = new Map(lin.decisions.map((d) => [d.id, d]));
    const prevQuestion = new Map(lin.openQuestions.map((q) => [q.id, q]));
    const sourceRows = lin.sources.map((s) => `<tr><td><code>${esc(s.sourceId)}</code></td><td><span class="tag ${s.status === 'unchanged' ? '' : 'warn'}">${esc(s.status)}</span></td><td>${s.changedRegions ? `바뀐 영역 ${s.changedRegions.length}개 · ${s.totalChangedLines}줄` : ''}${s.added ? ` 추가 앵커 ${s.added.length} · 제거 ${s.removed.length}` : ''}</td></tr>`);
    parts.push(section('lineage', `계보 — 이전 사례 ${lin.previous.caseId} 와의 관계`,
      `<h3>원본 대조</h3>${table(['원본', '상태', '변화'], sourceRows)}`
      + `<h3>이어받은 결정</h3>${table(['이전 결정', '처리', '내용', '새 계획서'], (p.lineage.inherited ?? []).map((x) => `<tr><td><code>${esc(x.ref)}</code> ${text(prevDecision.get(x.ref)?.note ?? '')}</td><td><span class="tag ${x.status === 'conflict' ? 'warn' : 'kind'}">${esc(x.status)}</span></td><td>${text(x.note)}</td><td>${x.target ? `<a href="#${esc(x.target)}">${esc(x.target)}</a> ` : ''}${x.question ? `<a href="#${esc(x.question)}">${esc(x.question)}</a>` : ''}</td></tr>`))}`
      + `<h3>이전 열린 확인 요청</h3>${table(['이전 질문', '결과', '근거·메모', '새 질문'], (p.lineage.resolved ?? []).map((x) => `<tr><td><code>${esc(x.ref)}</code> ${text(prevQuestion.get(x.ref)?.question ?? '')}</td><td><span class="tag ${x.status === 'resolved' ? 'kind' : 'warn'}">${esc(x.status)}</span></td><td>${text(x.note)}${x.evidence ? `<div class="ev">${refs(x.evidence)}</div>` : ''}</td><td>${x.question ? `<a href="#${esc(x.question)}">${esc(x.question)}</a>` : ''}</td></tr>`))}`,
      '결정 근거의 정본은 이전 사례 기록, 현재 상태의 정본은 이 사례가 고정한 코드다.'));
  }
  const KIND = { confirm: ['확인 요청', 'warn'], notice: ['알림 — 이렇게 정했다', 'kind'] };
  const CLAIM = { mismatch: '원본끼리 다름', wrong: '한쪽이 잘못됨', pattern: '우리 패턴 위반 — 제안' };
  const TO = { plan: '기획', design: '디자인', backend: '백엔드' };
  const byTo = Object.entries((p.questions ?? []).reduce((m, q) => ({ ...m, [q.to]: (m[q.to] ?? 0) + 1 }), {}));
  parts.push(section('questions', '담당자에게 전달 — 확인 요청 · 알림', `${byTo.length ? `<div class="chips">${byTo.map(([to, n]) => `<span class="chip">${esc(TO[to] ?? to)} <b>${n}</b></span>`).join('')}</div>` : ''}${table(['id', '종류', '대상', '내용', '근거 위치', '선택지', '기본 가정 · 이렇게 정했다', '영향'],
    (p.questions ?? []).map((q) => row(q.id, [
      q.kind ? `<span class="tag ${KIND[q.kind]?.[1] ?? ''}">${esc(KIND[q.kind]?.[0] ?? q.kind)}</span>${q.claimType ? `<br><span class="tag">${esc(CLAIM[q.claimType] ?? q.claimType)}</span>` : ''}` : '',
      esc(TO[q.to] ?? q.to), text(q.question) + (q.evidence ? `<div class="ev">근거: ${text(q.evidence)}</div>` : ''),
      `${refs(q.sourceRefs)}${q.searched ? `<div class="ev">찾아본 범위: ${q.searched.map((s) => `<code>${esc(s.sourceId)}</code> ${esc(s.scope)}`).join(' · ')}</div>` : ''}`,
      list(q.options), text(q.assumption), (q.impact ?? []).map((i) => `<a href="#${esc(i)}">${esc(i)}</a>`).join(', ')])))}`,
    '확인 요청(confirm): 원본끼리 다름·한쪽 잘못·패턴 위반 제안. 알림(notice): 원본에 정의가 없어 추론·개발 결정한 것.'));
  if (v2 && (p.decisions ?? []).length) {
    const DK = { 'answered-by-source': '원본이 명시함', 'sources-agree': '원본끼리 같음', 'single-source': '한쪽에만 있어 따름', fitted: '끼워 맞춤' };
    parts.push(section('decisions', '원본이 이미 답한 것 — 결정 기록', table(['id', '종류', '결정', '근거', '출처'],
      p.decisions.map((d) => row(d.id, [`<span class="tag">${esc(DK[d.kind] ?? d.kind)}</span>`, text(d.statement), text(d.rationale), refs(d.sourceRefs)]))), '질문이 아니다 — 담당자에게 전달하지 않는다.'));
  }
  parts.push(section('scope', '범위', table(['id', '화면', '진입', '구분', '출처'], p.surfaces.map((s) => row(s.id, [text(s.title), text(s.entry), esc(s.change), refs(s.sourceRefs)])))
    + `<h3>제외</h3>${table(['대상', '이유', '출처'], (p.excluded ?? []).map((x) => `<tr><td>${text(x.title)}</td><td>${text(x.reason)}</td><td>${refs(x.sourceRefs)}</td></tr>`))}`));
  parts.push(section('requirements', '요구사항', table(['id', '화면', '요구사항', '수용기준', '근거', '출처'],
    p.requirements.map((r) => row(r.id, [surfaceTitle(r.surface), text(r.statement), list(r.acceptance), basis(r), refs(r.sourceRefs)])))));
  parts.push(section('states', '상태', table(['id', '화면', '구역', '상태', '조건', '표시', '동작', '근거'],
    p.states.map((s) => row(s.id, [surfaceTitle(s.surface), text(s.region), text(s.state), text(s.condition), text(s.display), text(s.behavior ?? ''), basis(s)])))));

  const tree = (s) => {
    const nodes = p.components.filter((c) => c.surface === s.id);
    const walk = (parent) => nodes.filter((c) => (c.parent ?? null) === parent).map((c) => {
      const kids = walk(c.id);
      return `<li><code class="id" id="${esc(c.id)}">${esc(c.id)}</code> <b>${esc(c.name)}</b> <code>${esc(c.file)}</code> <span class="tag ${c.fileStatus === 'new' ? 'warn' : ''}">${esc(c.fileStatus)}</span> <span class="tag">DS ${esc(c.ds.match)}</span> ${esc(c.ds.component ?? '')}<div class="ev">${text(c.ds.reason)}</div>${decisionBadge(c.id)}${kids.length ? `<ul>${kids.join('')}</ul>` : ''}</li>`;
    });
    return `<ul class="tree">${walk(null).join('')}</ul>`;
  };
  parts.push(section('components', '컴포넌트 배치와 디자인 시스템 매칭', p.surfaces.map((s) => `<h3>${esc(s.title)}</h3>${tree(s)}`).join('')));
  parts.push(section('api', 'API 연결', table(['id', 'operationId', '화면 · 컴포넌트', '시점', '요청', '응답 → 화면', '오류 → 화면'],
    p.apiBindings.map((b) => row(b.id, [`<code>${esc(b.operationId)}</code>`, `${surfaceTitle(b.surface)} · <a href="#${esc(b.component)}">${esc(b.component)}</a>`, esc(b.trigger), text(b.request), text(b.response), text(b.errors)])))));
  parts.push(section('i18n', '다국어 문구', table(['키', '구분', '문구'], (p.i18n ?? []).map((k) => `<tr><td><code>${esc(k.key)}</code></td><td>${esc(k.status)}</td><td>${text(k.text ?? '')}</td></tr>`))));
  parts.push(section('gaps', '현재 구현과의 차이', table(['id', '화면', '현재', '목표', '파일'], p.gaps.map((g) => row(g.id, [surfaceTitle(g.surface), text(g.current), text(g.target), g.file ? `<code>${esc(g.file)}</code>` : ''])))));
  if (p.designSpecs?.length) parts.push(section('design-specs', '시안 규격', table(['출처 · 증거', '요구사항', '판정', '컴포넌트', '근거', '측정 증거'], p.designSpecs.map(d => `<tr><td>${esc(d.sourceId)}:${esc(d.element)}</td><td>${esc(d.requirement)}</td><td>${esc(d.verdict)}</td><td>${text(d.componentHint ?? d.component ?? '')}</td><td>${text(d.reason)}</td><td><details><summary>요소·규격·동작</summary>${text(d.observation ?? {})}</details></td></tr>`)), '측정 px는 증거다. 컴포넌트 규칙을 우선한다.'));
  const conformancePath = join(caseDir, 'conformance.json');
  if (existsSync(conformancePath)) {
    const report = JSON.parse(readFileSync(conformancePath, 'utf8'));
    if (!p.designSpecDigests || canonical(report.inputDigests) === canonical(p.designSpecDigests)) parts.push(conformanceSection(report));
  }

  const nav = [['kinds', '변경 유형'], ...(v2 ? [['findings', '지적']] : []), ...(p.lineage ? [['lineage', '계보']] : []), ['questions', '전달'], ...(v2 ? [['decisions', '결정 기록']] : []), ['scope', '범위'], ['requirements', '요구사항'], ['states', '상태'], ['components', '컴포넌트'], ['api', 'API'], ['i18n', '다국어'], ['gaps', '차이']]
    .map(([k, l]) => `<a href="#sec-${k}">${l}</a>`).join('');
  const digest = sha256(canonical(p)).slice(0, 12);

  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>작업계획 검토 — ${esc(p.title ?? p.caseId)}</title>
<style>
:root{--bg:#fff;--fg:#1b2430;--muted:#5d6b7a;--line:#dfe5ec;--soft:#f4f7fa;--accent:#2763ea;--warn:#a15c00;--warnbg:#fff3df;--high:#b42318;--highbg:#fde8e6;--ok:#14663a;--okbg:#e4f6ec}
@media(prefers-color-scheme:dark){:root{--bg:#10151c;--fg:#e4e9ef;--muted:#93a1b1;--line:#27313d;--soft:#18202a;--accent:#7ea6ff;--warn:#f0b35a;--warnbg:#3a2a10;--high:#ff8f84;--highbg:#3d1a17;--ok:#6fd49b;--okbg:#14301f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,"Pretendard",system-ui,sans-serif}
header{padding:20px 24px 12px;border-bottom:1px solid var(--line)}h1{margin:0 0 4px;font-size:20px}header p{margin:0;color:var(--muted)}
nav{position:sticky;top:0;z-index:2;display:flex;gap:4px;flex-wrap:wrap;padding:8px 24px;background:var(--bg);border-bottom:1px solid var(--line)}
nav a{padding:3px 10px;border-radius:999px;color:var(--fg);text-decoration:none;background:var(--soft)}nav a:hover{color:var(--accent)}
main{padding:8px 24px 64px}section{margin-top:28px}h2{font-size:16px;margin:0 0 8px}h3{font-size:14px;margin:18px 0 6px}
.cards{display:flex;gap:8px;flex-wrap:wrap;padding:14px 24px 0}.card{min-width:92px;padding:8px 12px;border:1px solid var(--line);border-radius:10px;background:var(--soft)}.card b{display:block;font-size:20px}.card span{color:var(--muted);font-size:12px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:760px}th,td{padding:7px 10px;border:1px solid var(--line);vertical-align:top;text-align:left}th{background:var(--soft);white-space:nowrap}
.idc{white-space:nowrap}code{font:12px ui-monospace,Menlo,monospace}code.id{padding:1px 6px;border-radius:6px;background:var(--soft);border:1px solid var(--line);font-weight:600}
:target{outline:2px solid var(--accent);outline-offset:2px}
.tag{display:inline-block;padding:0 7px;border-radius:999px;background:var(--soft);border:1px solid var(--line);font-size:12px}.tag.warn{background:var(--warnbg);color:var(--warn);border-color:transparent}
.tag.kind{background:var(--okbg);color:var(--ok);border-color:transparent}.tag.sev-high{background:var(--highbg);color:var(--high);border-color:transparent}.tag.sev-medium{background:var(--warnbg);color:var(--warn);border-color:transparent}
.decision{margin-top:6px;padding:6px 8px;border-radius:8px;background:var(--okbg);color:var(--ok);white-space:normal;font-size:12px}.decision.stale{background:var(--warnbg);color:var(--warn)}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 10px}.chip{padding:3px 10px;border-radius:999px;background:var(--soft);border:1px solid var(--line)}
.hint,.none,.ev{color:var(--muted);font-size:12px}.ev{margin-top:3px}ul{margin:4px 0;padding-left:18px}.tree{list-style:none;padding-left:0}.tree ul{list-style:none;padding-left:20px;border-left:1px dashed var(--line)}.tree li{margin:6px 0}
</style></head><body>
<header><h1>${esc(p.title ?? p.caseId)}</h1><p>${esc(p.summary ?? '')}</p><p>digest <code>${digest}</code> · 원본 ${p.inputDigests.length}건 · 읽기 전용 — 결정은 터미널에서 <code>node scripts/decide.mjs &lt;case&gt; &lt;id&gt; &lt;stance&gt; "&lt;결정&gt;"</code></p></header>
<div class="cards">${cards}</div><nav>${nav}</nav><main>${parts.join('')}</main></body></html>
`;
  writeFileSync(join(caseDir, 'review.html'), html);
  return html;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir || !existsSync(join(dir, 'workplan.json'))) { process.stderr.write('usage: node scripts/render-review.mjs <case-dir>\n'); process.exit(2); }
  try { renderReview(resolve(dir)); process.stdout.write(`${join(dir, 'review.html')}\n`); }
  catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
}
