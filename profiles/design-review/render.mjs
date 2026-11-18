#!/usr/bin/env node
// design-review 검토 화면 — 요구 조건 커버리지·불변식 반례 추적·보완안을 사람이 판단하는 review.html 로 렌더한다. 같은 JSON 이면 같은 HTML 이다.
// usage: node profiles/design-review/render.mjs <case-dir>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validate, SCENARIOS } from './validate.mjs';
import { readDecisions } from '../../scripts/decide.mjs';

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (v) => esc(typeof v === 'string' ? v : JSON.stringify(v)).replace(/\n/g, '<br>');
const refs = (rs = []) => rs.map((r) => `<code>${esc(r.sourceId)}</code> ${esc(r.locator)}`).join('<br>');
const STATUS = { covered: ['처리됨', 'ok'], 'mention-only': ['언급만', 'warn'], missing: ['누락', 'bad'], excluded: ['범위 밖', ''] };
const VERDICT = { holds: ['유지', 'ok'], breaks: ['깨짐', 'bad'], undocumented: ['문서로 정할 수 없음', 'warn'], 'n/a': ['해당 없음', ''] };
const SCENARIO = { 'response-loss': '응답 유실', concurrency: '동시 실행', retry: '재전송', 'late-arrival': '지연 도착', 'partial-failure': '부분 실패' };

export function render(caseDir) {
  const errors = validate(caseDir);
  if (errors.length) throw new Error(`validate 실패 ${errors.length}건 — 먼저 고친다`);
  const p = JSON.parse(readFileSync(join(caseDir, 'workplan.json'), 'utf8'));
  const decided = new Map(readDecisions(caseDir).map((d) => [d.id, d]));
  const cond = new Map((p.conditions ?? []).map((c) => [c.id, c]));
  const id = (x) => `<code class="id" id="${esc(x)}">${esc(x)}</code>${decided.has(x) ? `<div class="decision">${text(decided.get(x).note)}</div>` : ''}`;
  const tag = ([label, cls]) => `<span class="tag ${cls}">${esc(label)}</span>`;
  const table = (head, rows) => (rows.length ? `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<p class="none">없음</p>');
  const section = (key, title, body, hint = '') => `<section id="sec-${key}"><h2>${esc(title)}</h2>${hint ? `<p class="hint">${hint}</p>` : ''}${body}</section>`;
  const coverage = p.coverage ?? []; const traces = p.traces ?? [];
  const count = (xs, k, v) => xs.filter((x) => x[k] === v).length;
  const cards = [['조건', coverage.length], ['누락', count(coverage, 'status', 'missing')], ['언급만', count(coverage, 'status', 'mention-only')], ['불변식', (p.invariants ?? []).length], ['반례', count(traces, 'verdict', 'breaks')], ['문서로 정할 수 없음', count(traces, 'verdict', 'undocumented')], ['보완안', (p.remedies ?? []).length]]
    .map(([k, v]) => `<div class="card"><b>${v}</b><span>${esc(k)}</span></div>`).join('');
  const parts = [];
  parts.push(section('coverage', '요구 조건 → 설계 위치', table(['id', '조건', '판정', '설계 위치', '메모'], coverage.map((x) => `<tr><td>${id(x.id)}</td><td><code>${esc(x.condition)}</code> ${text(cond.get(x.condition)?.text)}<div class="ev">${refs(cond.get(x.condition)?.sourceRefs)}</div></td><td>${tag(STATUS[x.status] ?? [x.status, ''])}</td><td>${refs(x.locations)}</td><td>${text(x.note ?? '')}</td></tr>`)),
    '요구 원본의 조건 문장마다 설계 문서가 그것을 처리하는지 본다. 언급만 있고 처리가 없으면 언급만이다.'));
  const inv = p.invariants ?? [];
  parts.push(section('traces', '불변식 반례 추적', inv.length ? inv.map((v) => `<h3>${id(v.id)} ${text(v.statement)}</h3>${table(['id', '시나리오', '판정', '단계 (문서 근거 → 상태)', '반례·빈 곳'],
    SCENARIOS.map((sc) => traces.find((t) => t.invariant === v.id && t.scenario === sc)).filter(Boolean).map((t) => `<tr><td>${id(t.id)}</td><td>${esc(SCENARIO[t.scenario])}</td><td>${tag(VERDICT[t.verdict] ?? [t.verdict, ''])}</td><td><ol>${(t.steps ?? []).map((s) => `<li>${refs([s.ref])} → ${text(s.state)}</li>`).join('')}</ol></td><td>${text(t.counterexample ?? t.gap ?? t.reason ?? '')}</td></tr>`))}`).join('')
    : '<p class="warn-box">반례 추적 미검사 — 원본과 작업 주제에 검증할 불변식이 지정되지 않았다. 통과가 아니다.</p>'));
  parts.push(section('remedies', '보완안', table(['id', '해소 대상', '제안', '대상 문서'], (p.remedies ?? []).map((x) => `<tr><td>${id(x.id)}</td><td>${(x.addresses ?? []).map((a) => `<a href="#${esc(a)}">${esc(a)}</a>`).join(', ')}</td><td>${text(x.proposal)}</td><td>${text((x.targets ?? []).map((t) => (typeof t === 'string' ? t : `${t.sourceId ?? ''} ${t.section ?? t.locator ?? ''}`.trim())).join(', '))}</td></tr>`))));
  if ((p.findings ?? []).length) parts.push(section('findings', '지적', table(['id', '심각도', '대상', '지적', '권고'], p.findings.map((f) => `<tr><td>${id(f.id)}</td><td>${esc(f.severity)}</td><td><a href="#${esc(f.target)}">${esc(f.target)}</a></td><td>${text(f.message)}${f.evidence ? `<div class="ev">${text(f.evidence)}</div>` : ''}</td><td>${text(f.recommendation)}</td></tr>`))));
  parts.push(section('questions', '확인 질문', table(['id', '질문', '근거'], (p.questions ?? []).map((q) => `<tr><td>${id(q.id)}</td><td>${text(q.question)}</td><td>${refs(q.sourceRefs)}</td></tr>`))));
  parts.push(section('decisions', '결정 기록', table(['id', '결정', '근거'], (p.decisions ?? []).map((d) => `<tr><td>${id(d.id)}</td><td>${text(d.statement)}</td><td>${text(d.rationale)}<div class="ev">${refs(d.sourceRefs)}</div></td></tr>`))));
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.title ?? p.caseId)}</title><style>
:root{--fg:#1d1d1f;--muted:#6e6e73;--line:#e5e5ea;--soft:#f5f5f7;--bg:#fff;--ok:#1a7f37;--okbg:#dafbe1;--warn:#9a6700;--warnbg:#fff8c5;--bad:#cf222e;--badbg:#ffebe9}
@media (prefers-color-scheme:dark){:root{--fg:#f5f5f7;--muted:#a1a1a6;--line:#3a3a3c;--soft:#1c1c1e;--bg:#000;--okbg:#0f2e1a;--warnbg:#2e2a10;--badbg:#3a1416}}
body{margin:0;font:14px/1.55 -apple-system,BlinkMacSystemFont,sans-serif;color:var(--fg);background:var(--bg)}header{padding:20px 24px 4px}h1{font-size:20px;margin:0}main{padding:8px 24px 64px}section{margin-top:28px}h2{font-size:16px}h3{font-size:14px}
.cards{display:flex;gap:8px;flex-wrap:wrap;padding:14px 24px 0}.card{min-width:92px;padding:8px 12px;border:1px solid var(--line);border-radius:10px;background:var(--soft)}.card b{display:block;font-size:20px}.card span{color:var(--muted);font-size:12px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:720px}th,td{padding:7px 10px;border:1px solid var(--line);vertical-align:top;text-align:left}th{background:var(--soft)}code{font:12px ui-monospace,Menlo,monospace}code.id{font-weight:600}
.tag{display:inline-block;padding:0 7px;border-radius:999px;background:var(--soft);font-size:12px}.tag.ok{background:var(--okbg);color:var(--ok)}.tag.warn{background:var(--warnbg);color:var(--warn)}.tag.bad{background:var(--badbg);color:var(--bad)}
.hint,.none,.ev{color:var(--muted);font-size:12px}.warn-box{padding:10px 12px;border-radius:8px;background:var(--warnbg);color:var(--warn)}.decision{margin-top:6px;padding:4px 8px;border-radius:8px;background:var(--okbg);color:var(--ok);font-size:12px}ol{margin:0;padding-left:18px}
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
