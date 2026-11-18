// 권장안 채택의 독립 재검토 — 엔진 공통 계약(review.secondOpinion).
// 권장안을 만든 세션의 맹점이 그대로 확정되지 않도록, 그 권장안을 만들지 않은 새 세션이 원본 위치와 선택지만 보고 반례를 찾는다.
// 스킬이 부르는 decide.mjs 안에서 돌리면 세션이 중첩되므로 run.mjs 의 단계로 돈다. 결과는 second-opinions.json(스크립트 산출물)에 남고,
// 반대(disagree) 판정을 받은 결정은 계획서에 반영하지 않는다.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, sha256 } from '../register.mjs';

export const VERDICTS = ['agree', 'disagree', 'needs-info'];
const FILE = 'second-opinions.json';

export const readOpinions = (dir) => (existsSync(join(dir, FILE)) ? JSON.parse(readFileSync(join(dir, FILE), 'utf8')).opinions ?? [] : []);
export function writeOpinions(dir, caseId, opinions) {
  writeFileSync(join(dir, FILE), `${JSON.stringify({ schemaVersion: 1, kind: 'SecondOpinions', caseId, opinions: [...opinions].sort((a, b) => a.id.localeCompare(b.id)) }, null, 2)}\n`);
}

// 같은 결정(내용·고른 선택지·그 시점 항목)에 대한 재검토는 다시 하지 않는다.
export const opinionKey = (d) => sha256(canonical({ stance: d.stance, note: d.note, chosen: d.chosen ?? null, itemDigest: d.itemDigest })).slice(0, 16);
const current = (d, opinions) => opinions.find((o) => o.id === d.id && o.key === opinionKey(d));

export const pendingOpinions = (decisions, opinions) => decisions.filter((d) => d.origin === 'recommendation-accepted' && !current(d, opinions));
export const disagreed = (decisions, opinions) => decisions.filter((d) => current(d, opinions)?.verdict === 'disagree');
export const effectiveDecisions = (decisions, opinions) => { const no = new Set(disagreed(decisions, opinions).map((d) => d.id)); return decisions.filter((d) => !no.has(d.id)); };
export const opinionOf = (d, opinions) => current(d, opinions) ?? null;

export function opinionViolations(out) {
  if (!out || typeof out !== 'object') return ['stages/second-opinion.json 이 없거나 JSON 이 아님'];
  const v = [];
  if (!VERDICTS.includes(out.verdict)) v.push(`verdict 는 ${VERDICTS.join('|')}`);
  if (!Array.isArray(out.counterexamples)) v.push('counterexamples 배열이 없음');
  else {
    if (!out.counterexamples.length && !String(out.none ?? '').trim()) v.push('반례가 없으면 none 에 왜 없는지(무엇을 확인했는지) 적는다');
    out.counterexamples.forEach((c, i) => { if (!String(c?.statement ?? '').trim() || !Array.isArray(c?.sourceRefs) || !c.sourceRefs.length) v.push(`counterexamples[${i}]: statement 와 sourceRefs 가 필요함`); });
  }
  if (out.verdict === 'disagree' && !(out.counterexamples ?? []).length) v.push('disagree 는 반례가 1개 이상 필요함');
  return v;
}

// 재검토 세션에 주는 것은 결정 대상과 원본 위치, 보여 준 선택지와 고른 것뿐이다 — 권장 이유와 대화는 주지 않는다.
export function opinionPrompt({ decision, item }) {
  const subject = item.question ?? item.message ?? item.statement ?? item.title ?? item.id;
  const options = (decision.optionsShown ?? []).map((o) => `  - ${o.id}${o.id === decision.chosen ? ' (채택하려는 안)' : ''}: ${o.text}`).join('\n');
  const refs = (item.sourceRefs ?? []).map((r) => `  - ${r.sourceId} ${r.locator}`).join('\n') || '  - (항목에 원본 위치가 없다 — sources.json 과 extract 에서 직접 찾는다)';
  return `사례 폴더(작업 디렉터리)에서 작업한다. Bash 에서 'cd' 로 작업 디렉터리를 바꾸지 않는다. 역할 파일의 입출력 계약을 따른다.\n\n[재검토할 결정] ${decision.id}\n대상: ${subject}\n원본 위치:\n${refs}\n선택지:\n${options}\n채택하려는 안: ${decision.chosen}\n\n결과: stages/second-opinion.json`;
}
