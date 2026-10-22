#!/usr/bin/env node
// S5 validate — workplan.json 을 sources.json·extract/ 와 대조해 형식과 게이트를 검사한다.
// 이 파일이 WorkPlan 형식의 정본 검사기다(docs/workplan-format.md 와 같은 계약).
// usage: node scripts/validate.mjs <case-dir>   → 위반이 있으면 exit 1
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeResolver } from './lib/locators.mjs';

const ENUMS = {
  change: ['new', 'changed'],
  basis: ['source', 'inferred'],
  fileStatus: ['existing', 'new'],
  match: ['exact', 'adapt', 'custom'],
  trigger: ['load', 'submit', 'toggle', 'action', 'refresh'],
  i18nStatus: ['new', 'existing'],
  to: ['plan', 'design', 'backend'],
  // v2
  changeKind: ['new-page', 'new-menu', 'ds-component-new', 'ds-component-edit', 'feature-change', 'feature-copy', 'i18n', 'api-wiring'],
  severity: ['high', 'medium', 'low'],
  origin: ['plan', 'design', 'code', 'contract', 'workplan'],
  stance: ['follow-existing', 're-review', 'ask-plan', 'ask-design', 'ask-backend'],
  decision: ['follow-existing', 're-review', 'ask-plan', 'ask-design', 'ask-backend', 'decided'],
  questionKind: ['confirm', 'notice'],
  claimType: ['mismatch', 'wrong', 'pattern'],
  decisionKind: ['answered-by-source', 'sources-agree', 'single-source'],
  inherited: ['kept', 'conflict', 'obsolete'],
  resolved: ['resolved', 'still-open', 'obsolete'],
};

// planOverride: 파일로 쓰기 전의 후보 계획서를 검사할 때 넘긴다(단계 게이트).
export function validate(caseDir, planOverride) {
  const errors = [];
  const err = (where, msg) => errors.push(`${where}: ${msg}`);
  const read = (f) => JSON.parse(readFileSync(join(caseDir, f), 'utf8'));

  const registry = read('sources.json');
  const plan = planOverride ?? read('workplan.json');
  const sourceIds = new Set(registry.sources.map((s) => s.id));
  const extracts = Object.fromEntries(readdirSync(join(caseDir, 'extract'))
    .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(caseDir, 'extract', f), 'utf8'))]));

  const locators = makeResolver(caseDir, registry, extracts);
  const operations = new Set(registry.sources.filter((s) => s.role === 'contract')
    .flatMap((s) => extracts[s.id].anchors.filter((a) => a.type === 'operation').map((a) => a.value)));
  const codeFiles = new Set(registry.sources.filter((s) => s.role === 'implementation')
    .flatMap((s) => extracts[s.id].anchors.filter((a) => a.type === 'file').map((a) => a.value)));

  // envelope
  if (![1, 2].includes(plan.schemaVersion)) err('envelope', 'schemaVersion 은 1 또는 2');
  const v2 = plan.schemaVersion >= 2;
  if (plan.kind !== 'WorkPlan') err('envelope', "kind 는 'WorkPlan'");
  if (plan.caseId !== registry.caseId) err('envelope', `caseId 가 sources.json 과 다름 (${plan.caseId})`);
  const expected = registry.sources.map((s) => s.sha256).sort().join();
  if ([...(plan.inputDigests ?? [])].sort().join() !== expected) err('envelope', 'inputDigests 가 현재 sources.json 과 다름 — 원본이 바뀌었으면 S3·S4 를 다시 돌린다');

  const list = (key) => (Array.isArray(plan[key]) ? plan[key] : (err(key, '배열이어야 함'), []));
  const ids = new Map();
  const claim = (id, where) => {
    if (!id) return err(where, 'id 가 없음');
    if (ids.has(id)) err(where, `id 중복 — ${id}`);
    ids.set(id, where);
  };
  const oneOf = (where, field, value, enumKey) => {
    if (!ENUMS[enumKey].includes(value)) err(where, `${field} 는 ${ENUMS[enumKey].join('|')} 중 하나 (${value})`);
  };
  const refs = (where, item, { required = true } = {}) => {
    const rs = item.sourceRefs ?? [];
    for (const r of rs) {
      if (!sourceIds.has(r.sourceId)) err(where, `sourceRefs 의 sourceId 가 등록돼 있지 않음 — ${r.sourceId}`);
      if (!r.locator) err(where, 'sourceRefs 항목에 locator 가 없음');
    }
    if (required && rs.length === 0 && item.basis !== 'inferred') err(where, 'sourceRefs 가 비었음 — 출처가 없으면 basis:inferred 와 question 을 단다');
  };

  const surfaces = list('surfaces');
  surfaces.forEach((s, i) => { const w = `surfaces[${i}]`; claim(s.id, w); oneOf(w, 'change', s.change, 'change'); refs(w, s); if (!s.entry) err(w, 'entry(진입 경로)가 없음'); });
  const surfaceIds = new Set(surfaces.map((s) => s.id));
  const onSurface = (w, s) => { if (!surfaceIds.has(s)) err(w, `surface 가 surfaces 에 없음 — ${s}`); };
  list('excluded').forEach((x, i) => { const w = `excluded[${i}]`; if (!x.reason) err(w, 'reason 이 없음'); refs(w, x); });

  const inferredNeedsQuestion = [];
  const basisCheck = (w, item) => {
    oneOf(w, 'basis', item.basis, 'basis');
    if (item.basis === 'inferred') inferredNeedsQuestion.push([w, item.question]);
  };

  list('requirements').forEach((r, i) => {
    const w = `requirements[${i}]`; claim(r.id, w); onSurface(w, r.surface); basisCheck(w, r); refs(w, r);
    if (!r.statement) err(w, 'statement 가 없음');
    if (!Array.isArray(r.acceptance) || r.acceptance.length === 0) err(w, 'acceptance 가 비었음');
  });

  const states = list('states');
  states.forEach((s, i) => {
    const w = `states[${i}]`; claim(s.id, w); onSurface(w, s.surface); basisCheck(w, s); refs(w, s);
    for (const f of ['region', 'state', 'condition', 'display']) if (!s[f]) err(w, `${f} 가 없음`);
  });
  for (const s of surfaces) if (!states.some((x) => x.surface === s.id)) err(`surfaces:${s.id}`, '상태 표가 없음');

  const components = list('components');
  const componentIds = new Set(components.map((c) => c.id));
  components.forEach((c, i) => {
    const w = `components[${i}]`; claim(c.id, w); onSurface(w, c.surface); refs(w, c);
    if (c.parent && !componentIds.has(c.parent)) err(w, `parent 가 components 에 없음 — ${c.parent}`);
    oneOf(w, 'fileStatus', c.fileStatus, 'fileStatus');
    if (c.fileStatus === 'existing' && !codeFiles.has(c.file)) err(w, `existing 인데 현재 코드에 없는 파일 — ${c.file}`);
    if (c.fileStatus === 'new' && codeFiles.has(c.file)) err(w, `new 인데 이미 있는 파일 — ${c.file}`);
    oneOf(w, 'ds.match', c.ds?.match, 'match');
    if (!c.ds?.reason) err(w, 'ds.reason(매칭 판단 근거)이 없음');
  });

  list('apiBindings').forEach((b, i) => {
    const w = `apiBindings[${i}]`; claim(b.id, w); onSurface(w, b.surface); refs(w, b);
    if (!operations.has(b.operationId)) err(w, `API 계약에 없는 operationId — ${b.operationId}`);
    if (!componentIds.has(b.component)) err(w, `component 가 components 에 없음 — ${b.component}`);
    oneOf(w, 'trigger', b.trigger, 'trigger');
    for (const f of ['request', 'response', 'errors']) if (b[f] === undefined) err(w, `${f} 가 없음`);
  });

  list('i18n').forEach((k, i) => { const w = `i18n[${i}]`; if (!k.key) err(w, 'key 가 없음'); oneOf(w, 'status', k.status, 'i18nStatus'); });
  // 파일 경로는 현재 코드에 있거나, components 가 new 로 선언한 파일이거나, newFiles 에 이유와 함께 선언돼 있어야 한다.
  const declaredNew = new Set([...components.filter((c) => c.fileStatus === 'new').map((c) => c.file), ...(plan.newFiles ?? []).map((f) => f.file)]);
  (plan.newFiles ?? []).forEach((f, i) => { if (!f.file || !f.reason) err(`newFiles[${i}]`, 'file·reason 이 필요함'); if (codeFiles.has(f.file)) err(`newFiles[${i}]`, `이미 있는 파일 — ${f.file}`); });
  const knownFile = (w, file) => { if (file && !codeFiles.has(file) && !declaredNew.has(file)) err(w, `현재 코드에 없고 new 로 선언되지도 않은 파일 — ${file}`); };
  list('gaps').forEach((g, i) => { const w = `gaps[${i}]`; claim(g.id, w); onSurface(w, g.surface); for (const f of ['current', 'target']) if (!g[f]) err(w, `${f} 가 없음`); knownFile(w, g.file); });

  const questions = list('questions');
  const questionIds = new Set(questions.map((q) => q.id));
  const questionKind = new Map(questions.map((q) => [q.id, q.kind]));
  const checkRefs = (w, rs) => {
    for (const r of rs) {
      if (!sourceIds.has(r?.sourceId)) { err(w, `sourceRefs 의 sourceId 가 등록돼 있지 않음 — ${r?.sourceId}`); continue; }
      const hit = locators.resolve(r.sourceId, r.locator);
      if (!hit.ok) err(w, `sourceRefs locator 가 원본에 실재하지 않음 — ${hit.reason}`);
    }
  };
  const distinctSources = (rs) => new Set(rs.map((r) => r?.sourceId)).size;
  questions.forEach((q, i) => {
    const w = `questions[${i}]`; claim(q.id, w); oneOf(w, 'to', q.to, 'to');
    if (!q.question || !q.assumption) err(w, 'question·assumption 이 필요함');
    for (const t of q.impact ?? []) if (!ids.has(t)) err(w, `impact 가 가리키는 id 가 없음 — ${t}`);
    if (v2) {
      // 질문은 담당자에게 전달되는 두 종류뿐이다 — confirm(원본끼리 다름·한쪽 잘못·패턴 위반 제안) · notice(원본에 정의가 없어 추론·개발 결정한 것의 알림).
      // 원본이 이미 답한 것은 질문이 아니라 decisions 로 기록한다. 두 종류 모두 원본 위치로 뒷받침돼야 한다.
      oneOf(w, 'kind', q.kind, 'questionKind');
      const rs = Array.isArray(q.sourceRefs) ? q.sourceRefs : [];
      if (rs.length === 0) err(w, 'sourceRefs 가 비었음 — 질문을 낳은 원본 위치를 가리켜야 함');
      checkRefs(w, rs);
      if (q.kind === 'confirm') {
        oneOf(w, 'claimType', q.claimType, 'claimType');
        if (q.claimType === 'mismatch' && distinctSources(rs) < 2) err(w, '원본끼리 다르다는 확인 요청은 서로 다른 두 원본의 위치(sourceRefs 2개 이상, 원본 2개 이상)가 필요함');
        if (['wrong', 'pattern'].includes(q.claimType) && !q.evidence) err(w, `${q.claimType} 확인 요청은 근거(evidence — 무엇이 왜 잘못·패턴 위반인지)가 필요함`);
      }
      if (q.kind === 'notice') {
        // '원본에 정의가 없다'는 주장 — 어느 원본을 찾아봤는지 남기고, 답을 줄 수 있는 계약·context 를 반드시 포함한다.
        const searched = Array.isArray(q.searched) ? q.searched : [];
        if (searched.length === 0) err(w, "notice 는 '원본에 정의가 없다'는 주장이므로 어느 원본을 찾아봤는지(searched: [{sourceId, scope}])를 남겨야 함");
        for (const s of searched) { if (!sourceIds.has(s?.sourceId)) err(w, `searched 의 sourceId 가 등록돼 있지 않음 — ${s?.sourceId}`); if (!s?.scope) err(w, 'searched 항목에 scope(찾아본 범위)가 필요함'); }
        for (const s of registry.sources.filter((x) => ['contract', 'context'].includes(x.role))) {
          if (!searched.some((x) => x.sourceId === s.id)) err(w, `notice 는 답을 줄 수 있는 원본 ${s.id}(${s.role})를 찾아본 범위에 포함해야 함`);
        }
      }
    }
  });
  // 원본이 이미 답한 것의 기록 — 질문이 아니라 결정(근거·sourceRefs 필수).
  if (v2) {
    (Array.isArray(plan.decisions) ? plan.decisions : []).forEach((d, i) => {
      const w = `decisions[${i}]`; claim(d.id, w);
      oneOf(w, 'kind', d.kind, 'decisionKind');
      for (const f of ['statement', 'rationale']) if (!d[f]) err(w, `${f} 가 없음`);
      const rs = Array.isArray(d.sourceRefs) ? d.sourceRefs : [];
      if (rs.length === 0) err(w, 'sourceRefs 가 비었음 — 원본이 답한 위치를 가리켜야 함');
      checkRefs(w, rs);
      if (d.kind === 'sources-agree' && distinctSources(rs) < 2) err(w, 'sources-agree 는 서로 다른 두 원본의 위치가 필요함');
      if (d.surface) onSurface(w, d.surface);
    });
  }
  for (const [w, q] of inferredNeedsQuestion) {
    if (!questionIds.has(q)) err(w, `basis:inferred 인데 question 이 없거나 없는 id — ${q}`);
    else if (v2 && questionKind.get(q) !== 'notice') err(w, `basis:inferred 항목은 kind=notice 질문을 가리켜야 함 — ${q}`);
  }

  const tasks = list('tasks');
  const taskIds = new Set(tasks.map((t) => t.id));
  const covered = new Set();
  tasks.forEach((t, i) => {
    const w = `tasks[${i}]`; claim(t.id, w);
    for (const d of t.dependsOn ?? []) if (!taskIds.has(d)) err(w, `dependsOn 이 없는 task — ${d}`);
    for (const c of t.covers ?? []) { if (!ids.has(c)) err(w, `covers 가 없는 id — ${c}`); covered.add(c); }
    if (!Array.isArray(t.files) || t.files.length === 0) err(w, 'files 가 비었음');
    for (const f of t.files ?? []) knownFile(w, f);
    if (!Array.isArray(t.covers) || t.covers.length === 0) err(w, 'covers 가 비었음');
    if (v2) {
      oneOf(w, 'changeKind', t.changeKind, 'changeKind');
      const has = (pred) => (t.covers ?? []).some(pred);
      const surface = (id) => surfaces.find((s) => s.id === id);
      const component = (id) => components.find((c) => c.id === id);
      const kind = t.changeKind;
      if (['new-page', 'new-menu'].includes(kind) && !has((c) => surface(c)?.change === 'new')) err(w, `${kind} 는 change:new 인 화면을 covers 에 포함해야 함`);
      if (kind === 'api-wiring' && !has((c) => (plan.apiBindings ?? []).some((b) => b.id === c))) err(w, 'api-wiring 은 apiBinding 을 covers 에 포함해야 함');
      if (kind === 'ds-component-new' && !has((c) => component(c)?.fileStatus === 'new')) err(w, 'ds-component-new 는 fileStatus:new 인 component 를 covers 에 포함해야 함');
      if (kind === 'ds-component-edit' && !has((c) => component(c)?.fileStatus === 'existing')) err(w, 'ds-component-edit 는 fileStatus:existing 인 component 를 covers 에 포함해야 함');
    }
  });
  for (const c of components) if (!covered.has(c.id)) err(`components:${c.id}`, '어느 task 도 다루지 않음');
  for (const b of plan.apiBindings ?? []) if (!covered.has(b.id)) err(`apiBindings:${b.id}`, '어느 task 도 다루지 않음');

  if (v2) {
    list('findings').forEach((f, i) => {
      const w = `findings[${i}]`; claim(f.id, w);
      oneOf(w, 'severity', f.severity, 'severity'); oneOf(w, 'origin', f.origin, 'origin'); oneOf(w, 'stance', f.stance, 'stance');
      for (const k of ['message', 'recommendation']) if (!f[k]) err(w, `${k} 가 없음`);
    });
    list('findings').forEach((f, i) => { if (!ids.has(f.target)) err(`findings[${i}]`, `target 이 가리키는 id 가 없음 — ${f.target}`); });
  }
  // 후속 사례(lineage.json 이 있으면): 이전 결정은 이어받고, 이전 열린 확인 요청은 해소 여부를 가린다.
  const lineagePath = join(caseDir, 'lineage.json');
  if (existsSync(lineagePath) && v2) {
    const lin = JSON.parse(readFileSync(lineagePath, 'utf8'));
    const L = plan.lineage;
    if (!L || typeof L !== 'object') err('lineage', '후속 사례의 계획서에는 lineage(inherited·resolved)가 필요함');
    else {
      if (L.previous !== lin.previous.caseId) err('lineage', `previous 가 이전 사례와 다름 — ${L.previous}`);
      const cover = (key, want, label) => {
        const got = (Array.isArray(L[key]) ? L[key] : (err(`lineage.${key}`, '배열이어야 함'), [])).map((x) => x.ref);
        for (const id of want) if (!got.includes(id)) err(`lineage.${key}`, `이전 ${label} ${id} 가 처리되지 않음`);
        for (const id of got) if (!want.includes(id)) err(`lineage.${key}`, `이전 사례에 없는 ${label} — ${id}`);
        if (new Set(got).size !== got.length) err(`lineage.${key}`, 'ref 가 중복됨');
      };
      cover('inherited', lin.decisions.map((d) => d.id), '결정');
      cover('resolved', lin.openQuestions.map((q) => q.id), '열린 확인 요청');
      (L.inherited ?? []).forEach((x, i) => {
        const w = `lineage.inherited[${i}]`;
        oneOf(w, 'status', x.status, 'inherited');
        if (!x.note) err(w, 'note(이어받은 방식·충돌 내용)가 필요함');
        if (x.target && !ids.has(x.target)) err(w, `target 이 계획서에 없음 — ${x.target}`);
        if (x.status === 'conflict' && !questionIds.has(x.question)) err(w, `conflict 는 새 기획과 어긋난 지점을 questions 의 id 로 올려야 함 — ${x.question}`);
      });
      (L.resolved ?? []).forEach((x, i) => {
        const w = `lineage.resolved[${i}]`;
        oneOf(w, 'status', x.status, 'resolved');
        if (!x.note) err(w, 'note 가 필요함');
        if (x.status === 'resolved') { if (!Array.isArray(x.evidence) || x.evidence.length === 0) err(w, 'resolved 는 새 원본·코드의 근거(evidence)가 필요함'); else refs(w, { sourceRefs: x.evidence, basis: 'source' }); }
        if (x.status === 'still-open' && !questionIds.has(x.question)) err(w, `still-open 은 새 questions 의 id 가 필요함 — ${x.question}`);
      });
    }
  }
  // 사용자 결정(decisions.json)은 현재 계획서의 id 를 가리켜야 한다 — 재해석으로 사라진 id 는 정리 대상이다.
  const decisionsPath = join(caseDir, 'decisions.json');
  if (existsSync(decisionsPath)) {
    (JSON.parse(readFileSync(decisionsPath, 'utf8')).decisions ?? []).forEach((d, i) => {
      const w = `decisions[${i}]`;
      oneOf(w, 'stance', d.stance, 'decision');
      if (!d.note) err(w, 'note 가 없음');
      if (!ids.has(d.id)) err(w, `계획서에 없는 id — ${d.id}`);
    });
  }
  return errors;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir || !existsSync(join(dir, 'workplan.json'))) { process.stderr.write('usage: node scripts/validate.mjs <case-dir> (workplan.json 필요)\n'); process.exit(2); }
  const errors = validate(resolve(dir));
  for (const e of errors) process.stdout.write(`FAIL ${e}\n`);
  process.stdout.write(errors.length ? `\n${errors.length} 건 위반\n` : 'PASS\n');
  process.exit(errors.length ? 1 : 0);
}
