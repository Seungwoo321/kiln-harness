import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const esc = (v) => String(typeof v === 'object' && v !== null ? JSON.stringify(v) : v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function conformanceSection(report) {
  const groups = [...new Set(report.rows.map(r => r.verdict))];
  return `<!-- conformance:start --><section id="sec-conformance"><h2>시안 적합성</h2><p>${esc(report.status)} ${esc(report.reason ?? '')} · 사실 ${esc(report.factsDigest)} · 판정 ${esc(report.digest)}</p>${groups.map(verdict => `<h3>${esc(verdict)} (${report.rows.filter(r => r.verdict === verdict).length})</h3><div class="scroll"><table><thead><tr><th>id · 근거</th><th>사실 id</th><th>시안</th><th>구현</th><th>이유 · 컴포넌트</th></tr></thead><tbody>${report.rows.filter(r => r.verdict === verdict).map(r => `<tr id="${esc(r.id)}"><td>${esc(r.id)}<br>${esc(r.evidence)}</td><td>${esc(r.factIds)}</td><td>${esc(r.expected)}</td><td>${esc(r.actual)}</td><td>${esc(r.reason)}<br>${esc(r.componentHint)}${r.question ? `<br>${esc(r.question)}` : ''}</td></tr>`).join('')}</tbody></table></div>`).join('')}</section><!-- conformance:end -->`;
}

export function appendConformanceReview(dir, report) {
  const path = join(dir, 'review.html');
  let html = existsSync(path) ? readFileSync(path, 'utf8') : '<!doctype html><html lang="ko"><meta charset="utf-8"><title>시안 적합성</title><style>body{font:14px system-ui;padding:24px}table{border-collapse:collapse}td,th{padding:8px;border:1px solid #888;vertical-align:top}td{overflow-wrap:anywhere}.scroll{overflow:auto}</style><body><main></main></body></html>';
  const section = conformanceSection(report);
  if (/<!-- conformance:start -->[\s\S]*?<!-- conformance:end -->/.test(html)) html = html.replace(/<!-- conformance:start -->[\s\S]*?<!-- conformance:end -->/, () => section);
  else if (html.includes('</main>')) html = html.replace('</main>', () => `${section}</main>`);
  else html = html.replace('</body>', () => `${section}</body>`);
  writeFileSync(path, html);
  return html;
}
