#!/usr/bin/env node
// S2b lineage — 후속 사례의 계보 정보를 결정적으로 뽑아 lineage.json 으로 쓴다. 해석은 하지 않는다.
//   · 현재 상태의 정본은 이 사례가 S1 에서 커밋으로 고정한 실제 코드다.
//   · 결정 근거의 정본은 이전 사례의 기록이다 — 결정(decisions)·열린 확인 요청(questions)·추론 항목(basis:inferred).
//   · 이전 원본과 새 원본을 대조해 바뀐 영역만 범위 후보로 좁힌다.
// usage: node scripts/lineage.mjs <case-dir>
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { canonical, sha256, previousDir } from './register.mjs';
import { indexItems } from './decide.mjs';

const REGION_TYPES = new Set(['title', 'h1', 'h2', 'h3', 'screen-key', 'data-screen', 'data-panel', 'comment-marker', 'heading1', 'heading2', 'heading3']);
const MAX = 200;
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const brief = (a) => ({ type: a.type, value: a.value ?? (a.rows ? JSON.stringify(a.rows).slice(0, 160) : ''), ...(a.section ? { section: a.section } : {}), ...(a.line ? { line: a.line } : {}) });
const key = (a) => `${a.type}|${a.section ?? ''}|${a.value ?? JSON.stringify(a.rows ?? '')}`;

// diff -U0 의 hunk 에서 새 쪽·옛 쪽의 바뀐 줄 번호를 모은다. 순수 삭제는 삭제 지점 한 줄로 센다.
function changedLines(oldText, newText) {
  const tmp = mkdtempSync(join(tmpdir(), 'kh-diff-'));
  try {
    writeFileSync(join(tmp, 'old'), oldText); writeFileSync(join(tmp, 'new'), newText);
    const r = spawnSync('diff', ['-U0', join(tmp, 'old'), join(tmp, 'new')], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    if (r.status > 1) throw new Error(`diff 실패 — ${r.stderr}`);
    const lines = { new: [], old: [] };
    for (const m of r.stdout.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
      const [oa, ob, na, nb] = [Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
      for (let i = 0; i < Math.max(nb, 1); i += 1) lines.new.push(na + i);
      for (let i = 0; i < Math.max(ob, 1); i += 1) lines.old.push(oa + i);
    }
    return lines;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// 줄이 있는 앵커: 바뀐 줄을 직전 영역 앵커(화면·절 제목)에 대응시킨다.
function regionsOf(anchors, lines) {
  const regions = anchors.filter((a) => a.line && REGION_TYPES.has(a.type)).sort((a, b) => a.line - b.line);
  const counts = new Map();
  for (const ln of lines) {
    let lo = 0; let hi = regions.length - 1; let hit = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (regions[mid].line <= ln) { hit = mid; lo = mid + 1; } else hi = mid - 1; }
    const k = hit === -1 ? -1 : hit;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([k, n]) => ({ ...(k === -1 ? { type: 'preamble', value: '(첫 영역 앞)' } : brief(regions[k])), changedLines: n }));
}

export function buildLineage(caseDir) {
  const registry = readJson(join(caseDir, 'sources.json'));
  const link = registry.lineage;
  if (!link) throw new Error('이 사례에는 previous 링크가 없다');
  const prevDir = previousDir(caseDir, link.case);
  const prevRegistry = readJson(join(prevDir, 'sources.json'));
  const prevPlan = readJson(join(prevDir, 'workplan.json'));
  const prevDecisions = existsSync(join(prevDir, 'decisions.json')) ? readJson(join(prevDir, 'decisions.json')).decisions ?? [] : [];

  const sources = registry.sources.map((source) => {
    const prevId = link.supersedes?.[source.id] ?? source.id;
    const prev = prevRegistry.sources.find((s) => s.id === prevId);
    if (!prev) return { sourceId: source.id, prevSourceId: null, status: 'new' };
    if (source.kind === 'code' && source.role !== 'contract') return { sourceId: source.id, prevSourceId: prevId, status: 'code', note: '코드는 이 사례의 S1 커밋이 정본이다 — 대조하지 않는다' };
    if (prev.sha256 === source.sha256) return { sourceId: source.id, prevSourceId: prevId, status: 'unchanged' };

    const oldAnchors = readJson(join(prevDir, 'extract', `${prevId}.json`)).anchors;
    const newAnchors = readJson(join(caseDir, 'extract', `${source.id}.json`)).anchors;
    const entry = { sourceId: source.id, prevSourceId: prevId, status: 'changed' };
    const oldKeys = new Set(oldAnchors.map(key)); const newKeys = new Set(newAnchors.map(key));
    entry.added = newAnchors.filter((a) => !oldKeys.has(key(a))).map(brief).slice(0, MAX);
    entry.removed = oldAnchors.filter((a) => !newKeys.has(key(a))).map(brief).slice(0, MAX);
    // 줄이 있는 원본(HTML·JS·Markdown)은 바뀐 줄을 영역에 대응시킨다. 이전 원본은 이전 사례가 등록한 파일 그대로여야 한다.
    if (newAnchors.some((a) => a.line) && prev.path && source.path) {
      if (!existsSync(prev.path)) throw new Error(`이전 원본을 찾을 수 없다 — ${prevId} (${prev.path}). 이전 사례의 sources/ 를 보존해야 한다`);
      const oldText = readFileSync(prev.path); const newText = readFileSync(source.path);
      if (sha256(oldText) !== prev.sha256) throw new Error(`이전 원본이 등록 당시와 다르다 — ${prevId}`);
      const lines = changedLines(oldText.toString('utf8'), newText.toString('utf8'));
      entry.changedRegions = regionsOf(newAnchors, lines.new).slice(0, MAX);
      entry.totalChangedLines = lines.new.length;
    }
    return entry;
  });

  const items = indexItems(prevPlan);
  const subject = (it) => it?.title ?? it?.statement ?? it?.name ?? it?.question ?? it?.message ?? (it?.current ? `${it.current} → ${it.target}` : null);
  const decided = new Set(prevDecisions.map((d) => d.id));
  const lineage = {
    schemaVersion: 1, kind: 'Lineage', caseId: registry.caseId,
    previous: { caseId: link.caseId, case: link.case, sourcesDigest: link.sourcesDigest, workplanDigest: link.workplanDigest },
    sources,
    decisions: prevDecisions.map((d) => ({ id: d.id, stance: d.stance, note: d.note, subject: subject(items.get(d.id)) })).sort((a, b) => a.id.localeCompare(b.id)),
    openQuestions: (prevPlan.questions ?? []).filter((q) => !decided.has(q.id)).map((q) => ({ id: q.id, to: q.to, question: q.question, options: q.options ?? [], assumption: q.assumption, impact: q.impact ?? [] })).sort((a, b) => a.id.localeCompare(b.id)),
    inferred: ['requirements', 'states'].flatMap((k) => (prevPlan[k] ?? []).filter((x) => x.basis === 'inferred').map((x) => ({ id: x.id, section: k, question: x.question, subject: subject(x) }))).sort((a, b) => a.id.localeCompare(b.id)),
  };
  lineage.digest = sha256(canonical(lineage));
  writeFileSync(join(caseDir, 'lineage.json'), `${JSON.stringify(lineage, null, 2)}\n`);
  return lineage;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) { process.stderr.write('usage: node scripts/lineage.mjs <case-dir>\n'); process.exit(2); }
  try {
    const l = buildLineage(resolve(dir));
    for (const s of l.sources) process.stdout.write(`${s.sourceId}\t${s.status}\t${s.changedRegions?.length ?? s.added?.length ?? ''}\n`);
    process.stdout.write(`결정 ${l.decisions.length} · 열린 확인 요청 ${l.openQuestions.length} · 추론 ${l.inferred.length}\n`);
  } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
}
