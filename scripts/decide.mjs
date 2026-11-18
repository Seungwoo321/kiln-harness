#!/usr/bin/env node
// 사용자 결정 기록 — 검토 화면의 항목 id 에 대해 "이렇게 하겠다"를 decisions.json 에 남긴다.
// 결정은 항목 digest 에 묶인다: 항목이 다시 해석돼 내용이 바뀌면 stale 로 드러난다. 시각은 적지 않는다(결정성).
// 결정에는 출처가 남는다: 사용자가 새로 정했는지, 검토 화면의 권장안(질문의 assumption·지적의 recommendation)을 그대로 채택·수정·기각했는지,
// 그때 본 선택지와 고른 것, 사용자가 말한 이유(말하지 않았으면 비워 둔다 — 지어내지 않는다). 순서는 시각 대신 seq 로 남긴다.
// usage: node scripts/decide.mjs <case-dir> <id> <stance> "<결정 내용>" [--origin <출처>] [--chosen <선택지 id>] [--reason "<사용자 원문>"]
//        node scripts/decide.mjs <case-dir> --list
//        node scripts/decide.mjs <case-dir> --remove <id>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonical, sha256 } from './register.mjs';
import { decidableSections, profileForPlan } from './lib/profile.mjs';
import { readOpinions, opinionKey } from './lib/second-opinion.mjs';
import { loadConfig } from './lib/pipeline.mjs';

export const STANCES = ['follow-existing', 're-review', 'ask-plan', 'ask-design', 'ask-backend', 'decided'];
export const ORIGINS = ['user', 'recommendation-accepted', 'recommendation-modified', 'recommendation-rejected'];
export const RECOMMENDED = 'recommended';

// 그 시점 항목이 보여 준 선택지. 질문은 options 와 assumption(권장안), 지적은 recommendation(권장안)이다.
export function optionsOf(item) {
  const label = (o) => (typeof o === 'string' ? o : o?.label ?? o?.option ?? o?.text ?? JSON.stringify(o));
  const shown = (item.options ?? []).map((o, i) => ({ id: `option-${i + 1}`, text: label(o) }));
  const rec = item.assumption ?? item.recommendation;
  return rec ? [...shown, { id: RECOMMENDED, text: rec, recommended: true }] : shown;
}

// 이유 없이 권장안을 채택한 결정이 순서대로 threshold 건 이상 이어진 구간 — 사후에 "판단 없이 위임"으로 읽히기 쉽다.
export function bulkAccepted(decisions, threshold) {
  const runs = []; let run = [];
  for (const d of [...decisions].filter((x) => Number.isInteger(x.seq)).sort((a, b) => a.seq - b.seq)) {
    if (d.origin === 'recommendation-accepted' && !d.reason) run.push(d.id); else { if (run.length >= threshold) runs.push(run); run = []; }
  }
  if (run.length >= threshold) runs.push(run);
  return runs;
}
export const indexItems = (plan) => {
  const items = new Map();
  for (const key of decidableSections(profileForPlan(plan))) for (const item of plan[key] ?? []) if (item.id) items.set(item.id, item);
  return items;
};

export const itemDigest = (item) => sha256(canonical(item)).slice(0, 12);
const sectionOf = (plan, id) => decidableSections(profileForPlan(plan)).find((key) => (plan[key] ?? []).some((item) => item.id === id));

export const readDecisions = (caseDir) => {
  const path = join(caseDir, 'decisions.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).decisions ?? [] : [];
};

const write = (caseDir, caseId, decisions) => {
  const sorted = [...decisions].sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(join(caseDir, 'decisions.json'), `${JSON.stringify({ schemaVersion: 1, kind: 'Decisions', caseId, decisions: sorted }, null, 2)}\n`);
};

export function decide(caseDir, id, stance, note, { origin, chosen, reason } = {}) {
  const plan = JSON.parse(readFileSync(join(caseDir, 'workplan.json'), 'utf8'));
  const item = indexItems(plan).get(id);
  if (!item) throw new Error(`계획서에 없는 id — ${id}`);
  if (!STANCES.includes(stance)) throw new Error(`stance 는 ${STANCES.join('|')} 중 하나 (${stance})`);
  if (!note?.trim()) throw new Error('결정 내용(note)이 필요함');
  const optionsShown = optionsOf(item);
  const hasRecommendation = optionsShown.some((o) => o.recommended);
  if (hasRecommendation && !origin) throw new Error(`${id} 에는 권장안이 있다 — 출처(--origin ${ORIGINS.join('|')})가 필요함`);
  const from = origin ?? 'user';
  if (!ORIGINS.includes(from)) throw new Error(`origin 은 ${ORIGINS.join('|')} 중 하나 (${from})`);
  if (from !== 'user' && !hasRecommendation) throw new Error(`${id} 에는 권장안이 없다 — origin 은 user 다`);
  const pick = chosen ?? (['recommendation-accepted', 'recommendation-modified'].includes(from) ? RECOMMENDED : undefined);
  if (from === 'recommendation-accepted' && pick !== RECOMMENDED) throw new Error('권장안 채택(recommendation-accepted)의 chosen 은 recommended 다');
  if (from === 'recommendation-rejected' && pick === RECOMMENDED) throw new Error('권장안 기각(recommendation-rejected)은 권장안을 고를 수 없다');
  if (pick !== undefined && !optionsShown.some((o) => o.id === pick)) throw new Error(`chosen 은 보여 준 선택지 id 중 하나 (${optionsShown.map((o) => o.id).join('|') || '없음'})`);
  const existing = readDecisions(caseDir);
  const seq = Math.max(0, ...existing.map((d) => (Number.isInteger(d.seq) ? d.seq : 0))) + 1;
  const rest = existing.filter((d) => d.id !== id);
  write(caseDir, plan.caseId, [...rest, { id, stance, note: note.trim(), section: sectionOf(plan, id), itemDigest: itemDigest(item), origin: from, optionsShown, ...(pick !== undefined ? { chosen: pick } : {}), ...(reason?.trim() ? { reason: reason.trim() } : {}), seq }]);
}

export function remove(caseDir, id) {
  const plan = JSON.parse(readFileSync(join(caseDir, 'workplan.json'), 'utf8'));
  write(caseDir, plan.caseId, readDecisions(caseDir).filter((d) => d.id !== id));
}

// 결정 시점과 항목 내용이 달라진 결정 — 재해석으로 항목이 바뀌었으니 다시 확인해야 한다.
// 지적·질문·작업에 대한 결정은 재실행 때 같은 id 의 결정 기록(decisions)으로 이어받을 수 있다 — 그 기록이 결정 자체이므로 stale 이 아니다.
// section 이 없는 이전 기록은 D- 가 아닌 id 를 결정 기록 밖의 항목에 대한 결정으로 본다(결정 기록의 id 는 D- 다).
export function staleDecisions(caseDir, plan) {
  const items = indexItems(plan);
  // shortcut: 이어받은 결정 기록이 그 뒤 다시 바뀌어도 stale 로 드러나지 않는다(이어받은 시점의 digest 가 없다 — decisions.json 은 사용자 입력이라 스크립트가 다시 쓰지 않는다). 이어받을 때 digest 를 남길 저장소가 생기면 그것과 비교한다.
  const carried = (d) => (d.section ?? (d.id.startsWith('D-') ? 'decisions' : null)) !== 'decisions' && sectionOf(plan, d.id) === 'decisions';
  return readDecisions(caseDir).filter((d) => items.has(d.id) && !carried(d) && d.itemDigest !== itemDigest(items.get(d.id)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flags = {};
  for (const k of ['origin', 'chosen', 'reason']) { const i = argv.indexOf(`--${k}`); if (i >= 0) { flags[k] = argv[i + 1]; argv.splice(i, 2); } }
  const [dir, a, b, ...rest] = argv;
  const usage = () => { process.stderr.write('usage: decide.mjs <case-dir> <id> <stance> "<결정>" [--origin <출처>] [--chosen <선택지 id>] [--reason "<사용자 원문>"] | --list | --remove <id>\n'); process.exit(2); };
  if (!dir || !a) usage();
  const caseDir = resolve(dir);
  try {
    if (a === '--list') {
      const plan = JSON.parse(readFileSync(join(caseDir, 'workplan.json'), 'utf8'));
      const stale = new Set(staleDecisions(caseDir, plan).map((d) => d.id));
      const opinions = new Map(readOpinions(caseDir).map((o) => [o.id, o]));
      const decisions = readDecisions(caseDir);
      for (const d of decisions) {
        const o = opinions.get(d.id); const op = o && o.key === opinionKey(d) ? ` [재검토 ${o.verdict}${o.verdict === 'disagree' ? ' — 반영 안 됨' : ''}]` : '';
        process.stdout.write(`${d.id}\t${d.stance}\t${d.origin ?? '출처 기록 없음'}\t${d.reason ? `이유: ${d.reason}` : '이유 없음'}${op}\t${stale.has(d.id) ? '[stale] ' : ''}${d.note}\n`);
      }
      for (const run of bulkAccepted(decisions, loadConfig(caseDir).review.bulkAcceptThreshold)) process.stdout.write(`! 이유 없이 권장안을 연속 ${run.length}건 채택: ${run.join(', ')} — 독립 재검토(review.secondOpinion)를 권한다\n`);
    } else if (a === '--remove') {
      if (!b) usage();
      remove(caseDir, b);
    } else {
      if (!b || rest.length === 0) usage();
      decide(caseDir, a, b, rest.join(' '), flags);
      process.stdout.write(`기록: ${a} → ${b}\n`);
    }
  } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
}
