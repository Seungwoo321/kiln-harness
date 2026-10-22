#!/usr/bin/env node
// 사용자 결정 기록 — 검토 화면의 항목 id 에 대해 "이렇게 하겠다"를 decisions.json 에 남긴다.
// 결정은 항목 digest 에 묶인다: 항목이 다시 해석돼 내용이 바뀌면 stale 로 드러난다. 시각은 적지 않는다(결정성).
// usage: node scripts/decide.mjs <case-dir> <id> <stance> "<결정 내용>"
//        node scripts/decide.mjs <case-dir> --list
//        node scripts/decide.mjs <case-dir> --remove <id>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonical, sha256 } from './register.mjs';

export const STANCES = ['follow-existing', 're-review', 'ask-plan', 'ask-design', 'ask-backend', 'decided'];
const SECTIONS = ['surfaces', 'requirements', 'states', 'components', 'apiBindings', 'gaps', 'questions', 'decisions', 'tasks', 'findings'];

export const indexItems = (plan) => {
  const items = new Map();
  for (const key of SECTIONS) for (const item of plan[key] ?? []) if (item.id) items.set(item.id, item);
  return items;
};

export const itemDigest = (item) => sha256(canonical(item)).slice(0, 12);

export const readDecisions = (caseDir) => {
  const path = join(caseDir, 'decisions.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).decisions ?? [] : [];
};

const write = (caseDir, caseId, decisions) => {
  const sorted = [...decisions].sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(join(caseDir, 'decisions.json'), `${JSON.stringify({ schemaVersion: 1, kind: 'Decisions', caseId, decisions: sorted }, null, 2)}\n`);
};

export function decide(caseDir, id, stance, note) {
  const plan = JSON.parse(readFileSync(join(caseDir, 'workplan.json'), 'utf8'));
  const item = indexItems(plan).get(id);
  if (!item) throw new Error(`계획서에 없는 id — ${id}`);
  if (!STANCES.includes(stance)) throw new Error(`stance 는 ${STANCES.join('|')} 중 하나 (${stance})`);
  if (!note?.trim()) throw new Error('결정 내용(note)이 필요함');
  const rest = readDecisions(caseDir).filter((d) => d.id !== id);
  write(caseDir, plan.caseId, [...rest, { id, stance, note: note.trim(), itemDigest: itemDigest(item) }]);
}

export function remove(caseDir, id) {
  const plan = JSON.parse(readFileSync(join(caseDir, 'workplan.json'), 'utf8'));
  write(caseDir, plan.caseId, readDecisions(caseDir).filter((d) => d.id !== id));
}

// 결정 시점과 항목 내용이 달라진 결정 — 재해석으로 항목이 바뀌었으니 다시 확인해야 한다.
export function staleDecisions(caseDir, plan) {
  const items = indexItems(plan);
  return readDecisions(caseDir).filter((d) => items.has(d.id) && d.itemDigest !== itemDigest(items.get(d.id)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, a, b, ...rest] = process.argv.slice(2);
  const usage = () => { process.stderr.write('usage: decide.mjs <case-dir> <id> <stance> "<결정>" | --list | --remove <id>\n'); process.exit(2); };
  if (!dir || !a) usage();
  const caseDir = resolve(dir);
  try {
    if (a === '--list') {
      const plan = JSON.parse(readFileSync(join(caseDir, 'workplan.json'), 'utf8'));
      const stale = new Set(staleDecisions(caseDir, plan).map((d) => d.id));
      for (const d of readDecisions(caseDir)) process.stdout.write(`${d.id}\t${d.stance}\t${stale.has(d.id) ? '[stale] ' : ''}${d.note}\n`);
    } else if (a === '--remove') {
      if (!b) usage();
      remove(caseDir, b);
    } else {
      if (!b || rest.length === 0) usage();
      decide(caseDir, a, b, rest.join(' '));
      process.stdout.write(`기록: ${a} → ${b}\n`);
    }
  } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
}
