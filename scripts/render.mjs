#!/usr/bin/env node
// S6 render — 검증을 통과한 workplan.json 을 WORKPLAN.md · WORKPLAN.html 로 렌더한다. 같은 JSON 이면 같은 문서가 나온다.
// usage: node scripts/render.mjs <case-dir>
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validate } from './validate.mjs';
import { canonical, sha256 } from './register.mjs';
import { renderHtml } from './render-html.mjs';

const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
const refs = (rs = []) => rs.map((r) => `\`${r.sourceId}\` ${r.locator}`).join('<br>');
const table = (head, rows) => rows.length === 0 ? '_없음_\n'
  : `| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|\n${rows.map((r) => `| ${r.map(cell).join(' | ')} |`).join('\n')}\n`;
const basis = (x) => (x.resolution === 'pending' ? '확인 필요' : x.basis === 'inferred' ? `추론 → ${x.question ?? x.decision}` : '원본');
const json = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

export function render(caseDir) {
  const errors = validate(caseDir);
  if (errors.length) throw new Error(`validate 실패 ${errors.length}건 — 먼저 고친다`);
  const p = JSON.parse(readFileSync(join(caseDir, 'workplan.json'), 'utf8'));
  const bySurface = (items) => p.surfaces.map((s) => [s, items.filter((x) => x.surface === s.id)]);
  const tree = (s) => {
    const nodes = p.components.filter((c) => c.surface === s.id);
    const walk = (parent, depth) => nodes.filter((c) => (c.parent ?? null) === parent)
      .flatMap((c) => [`${'  '.repeat(depth)}- **${c.name}** — \`${c.file}\` (${c.fileStatus}) · DS: ${c.ds.component ?? '—'} [${c.ds.match}] ${c.ds.reason}`, ...walk(c.id, depth + 1)]);
    return walk(null, 0).join('\n') || '_없음_';
  };

  const out = [];
  out.push(`# 작업계획 — ${p.title ?? p.caseId}\n`);
  out.push(`> 이 문서는 \`workplan.json\` 에서 렌더한다. 고칠 때는 JSON 을 고치고 다시 렌더한다.\n> digest \`${sha256(canonical(p)).slice(0, 12)}\` · 원본 ${p.inputDigests.length}건\n`);
  if (p.summary) out.push(`${p.summary}\n`);

  out.push('## 1. 범위\n');
  out.push(table(['화면', '진입', '구분', '출처'], p.surfaces.map((s) => [`${s.title} (\`${s.id}\`)`, s.entry, s.change, refs(s.sourceRefs)])));
  out.push('\n**제외**\n');
  out.push(table(['대상', '이유', '출처'], (p.excluded ?? []).map((x) => [x.title, x.reason, refs(x.sourceRefs)])));

  out.push('\n## 2. 요구사항\n');
  for (const [s, rs] of bySurface(p.requirements)) {
    out.push(`### ${s.title}\n`);
    out.push(table(['id', '요구사항', '수용기준', '근거', '출처'], rs.map((r) => [r.id, r.statement, r.acceptance.map((a) => `- ${a}`).join('\n'), basis(r), refs(r.sourceRefs)])));
  }

  out.push('\n## 3. 상태\n');
  for (const [s, ss] of bySurface(p.states)) {
    out.push(`### ${s.title}\n`);
    out.push(table(['구역', '상태', '조건', '표시', '동작', '근거'], ss.map((x) => [x.region, x.state, x.condition, x.display, x.behavior ?? '', basis(x)])));
  }

  out.push('\n## 4. 컴포넌트 배치\n');
  for (const s of p.surfaces) out.push(`### ${s.title}\n\n${tree(s)}\n`);

  out.push('\n## 5. API 연결\n');
  out.push(table(['operationId', '화면 · 컴포넌트', '시점', '요청', '응답 → 화면', '오류 → 화면'],
    p.apiBindings.map((b) => [`\`${b.operationId}\``, `${b.surface} · ${b.component}`, b.trigger, json(b.request), json(b.response), json(b.errors)])));

  out.push('\n## 6. i18n\n');
  out.push(table(['키', '구분', '문구'], (p.i18n ?? []).map((k) => [`\`${k.key}\``, k.status, k.text ?? ''])));

  out.push('\n## 7. 현재 구현과의 차이\n');
  out.push(table(['id', '화면', '현재', '목표', '파일'], p.gaps.map((g) => [g.id, g.surface, g.current, g.target, g.file ?? ''])));

  out.push('\n## 8. 작업 순서\n');
  out.push(table(['id', '작업', '파일', '선행', '티켓', '다루는 항목'], p.tasks.map((t) => [t.id, t.title, t.files.map((f) => `\`${f}\``).join('<br>'), (t.dependsOn ?? []).join(', '), t.ticket ?? '', (t.covers ?? []).join(', ')])));

  out.push('\n## 9. 확인 필요\n');
  out.push(table(['id', '대상', '질문', '선택지', '기본 가정', '영향'], p.questions.map((q) => [q.id, q.to, q.question, (q.options ?? []).join(' / '), q.assumption, (q.impact ?? []).join(', ')])));
  if (p.designSpecs?.length) {
    out.push('\n## 시안 규격\n\n측정 px는 증거다. 컴포넌트 규칙을 우선한다.\n');
    out.push(table(['출처 · 증거', '요구사항', '판정', '컴포넌트', '근거', '측정 증거'], p.designSpecs.map(d => [`${d.sourceId}:${d.element}`, d.requirement ?? '', d.verdict, json(d.componentHint ?? d.component ?? ''), d.reason, json(d.observation ?? {})])));
  }

  const md = `${out.join('\n')}`.replace(/\n{3,}/g, '\n\n');
  writeFileSync(join(caseDir, 'WORKPLAN.md'), md.endsWith('\n') ? md : `${md}\n`);
  writeFileSync(join(caseDir, 'WORKPLAN.html'), renderHtml(p));
  return md;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) { process.stderr.write('usage: node scripts/render.mjs <case-dir>\n'); process.exit(2); }
  try { render(resolve(dir)); process.stdout.write(`${join(dir, 'WORKPLAN.md')}\n`); }
  catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
}
