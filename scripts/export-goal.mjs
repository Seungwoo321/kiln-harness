#!/usr/bin/env node
// export-goal — 승인된 분석(workplan.json·decisions.json)을 실행 쪽이 목표(goal)로 바로 만들 수 있는 JSON 으로 낸다.
// 사람이 옮겨 적다 생기는 어긋남(수용 기준을 자유 문장으로 바꿈, 단위가 늘어도 목표가 그대로)을 없애려고 계획서에서 결정적으로 렌더한다.
// 특정 실행 도구에 묶이지 않는다. 형식은 docs/goal-export.md.
// usage: node scripts/export-goal.mjs <case-dir> [--out <file>]   (기본: 표준출력)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonical, sha256 } from './register.mjs';
import { readDecisions } from './decide.mjs';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

// 단위(task)를 dependsOn 순서로 늘어놓는다. 의존이 없는 것끼리는 계획서의 순서를 지킨다.
function orderTasks(tasks) {
  const done = new Set();
  const out = [];
  while (out.length < tasks.length) {
    const next = tasks.find((t) => !done.has(t.id) && (t.dependsOn ?? []).every((d) => done.has(d)));
    if (!next) throw new Error(`task 의존이 순환함 — ${tasks.filter((t) => !done.has(t.id)).map((t) => t.id).join(', ')}`);
    done.add(next.id); out.push(next);
  }
  return out;
}

export function exportGoal(caseDir) {
  const status = existsSync(join(caseDir, 'run-status.json')) ? readJson(join(caseDir, 'run-status.json')) : null;
  if (!existsSync(join(caseDir, 'workplan.json'))) throw new Error('workplan.json 이 없다 — 분석이 끝까지 통과한 사례만 내보낼 수 있다');
  const plan = readJson(join(caseDir, 'workplan.json'));
  const workplanDigest = sha256(canonical(plan));
  if (status?.result !== 'passed' || status.workplanDigest !== workplanDigest) throw new Error('승인된 분석이 아니다 — run-status.json 이 passed 가 아니거나 workplan.json 이 통과한 실행 뒤에 바뀌었다. 파이프라인을 다시 통과시킨다');

  const requirements = plan.requirements ?? [];
  const tasks = orderTasks(plan.tasks ?? []);
  const unitsOf = (reqId) => tasks.filter((t) => (t.covers ?? []).includes(reqId)).map((t) => t.id);
  const decisions = readDecisions(caseDir);
  const doc = {
    schemaVersion: 1, kind: 'WorkGoalExport', caseId: plan.caseId,
    objective: plan.title ?? plan.caseId,
    ...(plan.summary ? { summary: plan.summary } : {}),
    // 수용 기준은 계획서의 acceptance 문장 그대로다. 문장을 다듬거나 합치지 않는다.
    criteria: requirements.flatMap((r) => (r.acceptance ?? []).map((text) => ({ requirement: r.id, surface: r.surface, text, units: unitsOf(r.id) }))),
    units: tasks.map((t, i) => ({
      order: i + 1, id: t.id, title: t.title, changeKind: t.changeKind, ...(t.ticket ? { ticket: t.ticket } : {}),
      dependsOn: t.dependsOn ?? [], files: t.files ?? [],
      acceptance: requirements.filter((r) => (t.covers ?? []).includes(r.id)).flatMap((r) => (r.acceptance ?? []).map((text) => ({ requirement: r.id, text }))),
    })),
    references: {
      workplan: { file: 'workplan.json', digest: workplanDigest },
      decisions: { file: 'decisions.json', count: decisions.length, digest: sha256(canonical(decisions)) },
      inputDigests: plan.inputDigests,
    },
    openQuestions: (plan.questions ?? []).map((q) => q.id),
  };
  doc.digest = sha256(canonical(doc));
  return doc;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
  const dir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
  if (!dir || (args.includes('--out') && !out)) { process.stderr.write('usage: node scripts/export-goal.mjs <case-dir> [--out <file>]\n'); process.exit(2); }
  try {
    const text = `${JSON.stringify(exportGoal(resolve(dir)), null, 2)}\n`;
    if (out) writeFileSync(resolve(out), text); else process.stdout.write(text);
  } catch (e) { process.stderr.write(`export-goal: ${e.message}\n`); process.exit(1); }
}
