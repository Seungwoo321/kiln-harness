#!/usr/bin/env node
// requirements 검토 화면 — 요구사항·수용기준·미결·범위 밖·변경 내역을 review.html 로 렌더한다. 같은 JSON 이면 같은 HTML 이다.
// usage: node profiles/requirements/render.mjs <case-dir>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validate } from './validate.mjs';
import { readDecisions } from '../../scripts/decide.mjs';

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (v) => esc(typeof v === 'string' ? v : JSON.stringify(v)).replace(/\n/g, '<br>');
const refs = (rs = []) => rs.map((r) => `<code>${esc(r.sourceId)}</code> ${esc(r.locator)}`).join('<br>');

export function render(caseDir) {
  const errors = validate(caseDir);
  if (errors.length) throw new Error(`validate 실패 ${errors.length}건 — 먼저 고친다`);
  const p = JSON.parse(readFileSync(join(caseDir, 'workplan.json'), 'utf8'));
  const decided = new Map(readDecisions(caseDir).map((d) => [d.id, d]));
  const id = (x) => `<code class="id" id="${esc(x)}">${esc(x)}</code>${decided.has(x) ? `<div class="decision">${text(decided.get(x).note)}</div>` : ''}`;
  const link = (x) => `<a href="#${esc(x)}">${esc(x)}</a>`;
  const table = (head, rows) => (rows.length ? `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<p class="none">없음</p>');
  const section = (key, title, body, hint = '') => `<section id="sec-${key}"><h2>${esc(title)}</h2>${hint ? `<p class="hint">${hint}</p>` : ''}${body}</section>`;
  const cards = [['조건', (p.conditions ?? []).length], ['요구사항', (p.requirements ?? []).length], ['미결', (p.open ?? []).length], ['범위 밖', (p.excluded ?? []).length], ['변경', (p.changes ?? []).length]].map(([k, v]) => `<div class="card"><b>${v}</b><span>${esc(k)}</span></div>`).join('');
  const parts = [
    section('requirements', '요구사항과 수용기준', table(['id', '요구사항', '수용기준', '조건', '출처'], (p.requirements ?? []).map((r) => `<tr><td>${id(r.id)}</td><td>${text(r.statement)}</td><td><ol>${(r.acceptance ?? []).map((a) => `<li>${text(a.when)} → ${text(a.then)}</li>`).join('')}</ol></td><td>${(r.conditions ?? []).map(link).join(', ')}</td><td>${refs(r.sourceRefs)}</td></tr>`))),
    section('open', '미결 — 기본값으로 진행', table(['id', '미결', '기본값', '영향'], (p.open ?? []).map((u) => `<tr><td>${id(u.id)}</td><td>${text(u.question)}</td><td>${text(u.default)}</td><td>${(u.impact ?? []).map(link).join(', ')}</td></tr>`))),
    section('excluded', '범위 밖', table(['대상', '이유', '남는 의무'], (p.excluded ?? []).map((x) => `<tr><td>${text(x.title)}</td><td>${text(x.reason)}</td><td>${(x.residual?.obligations ?? []).length ? x.residual.obligations.map((o) => `${text(o.statement)} → ${(o.handledBy ?? []).map(link).join(', ')}`).join('<br>') : `없음: ${text(x.residual?.none ?? '')}`}</td></tr>`))),
    section('changes', '변경 내역', table(['id', '변경', '사유', '출처'], (p.changes ?? []).map((c) => `<tr><td>${id(c.id)}</td><td>${text(c.change)}</td><td>${text(c.reason)}</td><td>${refs(c.sourceRefs)}</td></tr>`))),
    section('conditions', '조건 — 원본 문장', table(['id', '조건', '출처'], (p.conditions ?? []).map((c) => `<tr><td><code class="id" id="${esc(c.id)}">${esc(c.id)}</code>${c.inherited ? `<div class="ev">앞 단계 ${esc(c.inherited)}</div>` : ''}</td><td>${text(c.text)}</td><td>${refs(c.sourceRefs)}</td></tr>`))),
    section('questions', '확인 질문', table(['id', '질문'], (p.questions ?? []).map((q) => `<tr><td>${id(q.id)}</td><td>${text(q.question)}</td></tr>`))),
    section('decisions', '결정 기록', table(['id', '결정', '근거'], (p.decisions ?? []).map((d) => `<tr><td>${id(d.id)}</td><td>${text(d.statement)}</td><td>${text(d.rationale)}</td></tr>`))),
    ...((p.findings ?? []).length ? [section('findings', '지적', table(['id', '대상', '지적', '권고'], p.findings.map((f) => `<tr><td>${id(f.id)}</td><td>${link(f.target)}</td><td>${text(f.message)}</td><td>${text(f.recommendation)}</td></tr>`)))] : []),
  ];
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.title ?? p.caseId)}</title><style>
:root{--fg:#1d1d1f;--muted:#6e6e73;--line:#e5e5ea;--soft:#f5f5f7;--bg:#fff;--ok:#1a7f37;--okbg:#dafbe1}
@media (prefers-color-scheme:dark){:root{--fg:#f5f5f7;--muted:#a1a1a6;--line:#3a3a3c;--soft:#1c1c1e;--bg:#000;--okbg:#0f2e1a}}
body{margin:0;font:14px/1.55 -apple-system,BlinkMacSystemFont,sans-serif;color:var(--fg);background:var(--bg)}header{padding:20px 24px 4px}h1{font-size:20px;margin:0}main{padding:8px 24px 64px}section{margin-top:28px}h2{font-size:16px}
.cards{display:flex;gap:8px;flex-wrap:wrap;padding:14px 24px 0}.card{min-width:92px;padding:8px 12px;border:1px solid var(--line);border-radius:10px;background:var(--soft)}.card b{display:block;font-size:20px}.card span{color:var(--muted);font-size:12px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:720px}th,td{padding:7px 10px;border:1px solid var(--line);vertical-align:top;text-align:left}th{background:var(--soft)}code{font:12px ui-monospace,Menlo,monospace}code.id{font-weight:600}
.hint,.none,.ev{color:var(--muted);font-size:12px}.decision{margin-top:6px;padding:4px 8px;border-radius:8px;background:var(--okbg);color:var(--ok);font-size:12px}ol{margin:0;padding-left:18px}
</style></head><body><header><h1>${esc(p.title ?? p.caseId)}</h1><p>${esc(p.summary ?? '')}</p></header><div class="cards">${cards}</div><main>${parts.join('')}</main></body></html>
`;
  writeFileSync(join(caseDir, 'review.html'), html);
  return html;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir || !existsSync(join(dir, 'workplan.json'))) { process.stderr.write('usage: node scripts/render.mjs <case-dir>\n'); process.exit(2); }
  try { render(resolve(dir)); process.stdout.write(`${join(dir, 'review.html')}\n`); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
}
