// 조건 커버리지 — 모든 목적 프로파일이 거치는 엔진 공통 계약.
// 원본의 조건 문장을 스크립트가 빠짐없이 나열하고(statements), 범위 단계는 그 문장을 모두 조건(C-xx) 또는 비조건으로 분류하며,
// 해석 단계는 모든 조건을 처리 항목에 잇는다. 범위에서 제외한 것도 그 조건이 이 시스템에 남기는 의무(residual)를 요구사항·질문으로 남긴다.
// 열거를 에이전트에 맡기면 처음부터 나열하지 않은 문장은 어떤 게이트도 잡지 못한다 — 그래서 문장 목록은 결정적으로 만든다.

export const STATEMENT_KINDS = ['plan-html', 'plan-doc', 'context-doc'];
const squash = (s) => s.replace(/\s+/g, ' ').trim();
const ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&', '&nbsp;': ' ' };
const meaningful = (s) => /[\p{L}\p{N}]/u.test(s);
const blank = (m) => m.replace(/[^\n]/g, '');

// HTML: 스크립트·스타일·주석과 제목을 지우고(줄 수는 유지) 남은 글자를 줄 단위 문장으로 본다.
export function htmlStatements(text) {
  const body = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, blank).replace(/<!--[\s\S]*?-->/g, blank).replace(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/gi, blank).replace(/<title>[\s\S]*?<\/title>/gi, blank);
  return body.split('\n').flatMap((line, i) => {
    const t = squash(line.replace(/<[^>]*>/g, ' ').replace(/&(lt|gt|quot|apos|amp|nbsp);/g, (m) => ENTITIES[m]));
    return meaningful(t) ? [{ n: i + 1, locator: `L${i + 1}`, text: t.slice(0, 300) }] : [];
  });
}

// Markdown·텍스트: 제목·코드 블록·표 구분선을 뺀 줄.
export function markdownStatements(text) {
  let fenced = false;
  return text.split('\n').flatMap((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; return []; }
    if (fenced || /^\s*#{1,6}\s/.test(raw) || /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(raw)) return [];
    const t = squash(raw);
    return meaningful(t) ? [{ n: i + 1, locator: `L${i + 1}`, text: t.slice(0, 300) }] : [];
  });
}

// docx: 제목을 뺀 문단과 표(문단 순번 P<n>).
export const docxStatements = (anchors) => anchors
  .filter((a) => a.type === 'paragraph' || a.type === 'table')
  .map((a) => ({ n: a.order, locator: `P${a.order}`, text: (a.value ?? a.rows.map((r) => r.join(' | ')).join(' / ')).slice(0, 300) }));

// L<a>-<b>·P<a>-<b> locator 를 문장 번호 범위로 읽는다. 다른 locator 는 문장을 덮지 않는다.
export function rangeOf(locator, kind) {
  const m = String(locator ?? '').trim().match(kind === 'plan-doc' ? /^P(\d+)(?:-(\d+))?$/ : /^L(\d+)(?:-(\d+))?$/);
  return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null;
}

const conditionSources = (registry, profile, extracts) => registry.sources.filter((s) => profile.conditionRoles.includes(s.role) && STATEMENT_KINDS.includes(s.kind) && extracts[s.id]?.statements);

// 범위 게이트: 조건 원본의 모든 문장이 조건 또는 비조건으로 분류됐는지, 조건·제외 항목의 형식이 맞는지.
export function scopeConditionViolations(scope, registry, profile, extracts) {
  const out = [];
  const conditions = scope.conditions;
  const nonConditions = scope.nonConditions ?? [];
  if (!Array.isArray(conditions)) return ['conditions 가 없음 — 조건 원본의 조건 문장을 C-xx 로 열거한다 (조건이 하나도 없으면 빈 배열과 함께 모든 문장을 nonConditions 로 분류한다)'];
  const ids = new Set();
  conditions.forEach((c, i) => {
    const w = `conditions[${i}]`;
    if (!/^C-\d+$/.test(c?.id ?? '') || ids.has(c.id)) out.push(`${w}: id 는 C-<번호> 이고 유일해야 함 (${c?.id})`);
    ids.add(c?.id);
    if (!String(c?.text ?? '').trim()) out.push(`${w}: text(조건을 한 문장으로)가 없음`);
    if (!Array.isArray(c?.sourceRefs) || !c.sourceRefs.length) out.push(`${w}: sourceRefs 가 없음`);
  });
  nonConditions.forEach((x, i) => { if (!String(x?.reason ?? '').trim()) out.push(`nonConditions[${i}]: reason 이 없음`); });
  for (const s of conditionSources(registry, profile, extracts)) {
    const ranges = [...conditions.flatMap((c) => c?.sourceRefs ?? []), ...nonConditions].filter((r) => r?.sourceId === s.id).map((r) => rangeOf(r.locator, s.kind)).filter(Boolean);
    const open = extracts[s.id].statements.filter((st) => !ranges.some(([a, b]) => st.n >= a && st.n <= b));
    if (open.length) out.push(`분류되지 않은 조건 후보 문장 ${open.length}개 — ${s.id} ${open.slice(0, 12).map((st) => `${st.locator} "${st.text.slice(0, 60)}"`).join(' · ')}${open.length > 12 ? ' …' : ''} (conditions 의 sourceRefs 나 nonConditions 의 ${s.kind === 'plan-doc' ? 'P' : 'L'} 범위로 덮는다)`);
  }
  (scope.excluded ?? []).forEach((x, i) => {
    const w = `excluded[${i}]`;
    for (const id of x?.conditions ?? []) if (!ids.has(id)) out.push(`${w}: 없는 조건을 가리킴 — ${id}`);
    const r = x?.residual;
    if (!r || typeof r !== 'object') { out.push(`${w}: residual 이 없음 — 제외해도 이 시스템에 남는 의무를 obligations 로 적거나, 없으면 none 에 근거를 적는다`); return; }
    const obligations = Array.isArray(r.obligations) ? r.obligations : [];
    if (!obligations.length && !String(r.none ?? '').trim()) out.push(`${w}: residual 은 obligations(남는 의무) 또는 none(없다는 근거) 중 하나가 필요함`);
    obligations.forEach((o, j) => { if (!String(o?.statement ?? '').trim()) out.push(`${w}.residual.obligations[${j}]: statement 가 없음`); });
  });
  return out;
}

const referencing = (plan, sections) => sections.flatMap((k) => plan[k] ?? []).filter((x) => x && typeof x === 'object');

// 해석·비평 게이트: 모든 조건이 처리 항목에 이어졌는지, 제외 항목의 남는 의무가 실재하는 요구사항·질문으로 이어졌는지.
export function planConditionViolations(plan, sections) {
  const out = [];
  const conditions = plan.conditions ?? [];
  const known = new Set(conditions.map((c) => c.id));
  const items = referencing(plan, sections);
  const itemIds = new Set(items.map((x) => x.id).filter(Boolean));
  for (const id of known) if (itemIds.has(id)) out.push(`조건 id 가 계획서 항목 id 와 겹침 — ${id} (항목 id 를 바꾼다)`);
  const handled = new Set();
  for (const x of [...items, ...(plan.excluded ?? [])]) for (const id of x.conditions ?? []) { if (!known.has(id)) out.push(`${x.id ?? x.title}: 없는 조건을 가리킴 — ${id}`); handled.add(id); }
  for (const c of conditions) if (!handled.has(c.id)) out.push(`조건 ${c.id} 를 처리한 항목이 없음 — "${String(c.text).slice(0, 80)}" (요구사항·질문·결정·제외 등 처리 항목의 conditions 에 단다)`);
  (plan.excluded ?? []).forEach((x, i) => {
    (x.residual?.obligations ?? []).forEach((o, j) => {
      const w = `excluded[${i}] ${x.title ?? ''} 의 남는 의무 ${j + 1}`;
      if (!Array.isArray(o.handledBy) || !o.handledBy.length) out.push(`${w}: handledBy(이어진 요구사항·질문 id)가 없음 — "${String(o.statement).slice(0, 80)}"`);
      else for (const id of o.handledBy) if (!itemIds.has(id)) out.push(`${w}: handledBy 가 계획서에 없는 id 를 가리킴 — ${id}`);
    });
  });
  return out;
}

// 비평이 질문을 결정으로 내리거나 지울 때 조건 매핑을 함께 옮긴다.
export function carryConditions(next, plan, demoted, dropped) {
  const questions = new Map((plan.questions ?? []).map((q) => [q.id, q]));
  for (const d of next.decisions ?? []) {
    const qid = d.id?.startsWith('D-') ? d.id.slice(2) : null;
    if (qid && demoted.has(qid) && questions.get(qid)?.conditions && !d.conditions) d.conditions = questions.get(qid).conditions;
  }
  for (const x of next.excluded ?? []) for (const o of x.residual?.obligations ?? []) {
    if (Array.isArray(o.handledBy)) o.handledBy = o.handledBy.filter((id) => !dropped.has(id)).map((id) => (demoted.has(id) ? `D-${id}` : id));
  }
}

// 검토 화면용: 조건마다 무엇이 처리했는가.
export function conditionCoverage(plan, sections) {
  const items = referencing(plan, sections);
  return (plan.conditions ?? []).map((c) => ({
    ...c,
    handledBy: items.filter((x) => (x.conditions ?? []).includes(c.id)).map((x) => x.id),
    excluded: (plan.excluded ?? []).filter((x) => (x.conditions ?? []).includes(c.id)).map((x) => ({ title: x.title, obligations: x.residual?.obligations ?? [], none: x.residual?.none ?? null })),
  }));
}

// 프롬프트에 싣는 공통 지시.
export function conditionBrief(stage, registry, profile, extracts) {
  if (stage === 'scope') {
    const list = conditionSources(registry, profile, extracts).map((s) => `${s.id}(${extracts[s.id].statements.length}개, ${s.kind === 'plan-doc' ? 'P' : 'L'} 번호)`);
    return `\n\n[조건 커버리지 — 공통 계약]\n조건 후보 문장: ${list.length ? list.join(', ') : '(없음)'} — extract/<sourceId>.json 의 statements.\n- 이 문장을 하나도 빠짐없이 분류한다. 이 작업 대상 시스템이 지켜야 하거나 이 시스템에 의무를 남기는 요구·제약·배경 문장은 conditions:[{id:"C-01", text:"조건을 한 문장으로", sourceRefs:[{sourceId, locator:"L12-13"}]}] 로 쓴다(locator 는 문장의 L 줄 또는 P 문단 번호 범위). 조건이 아닌 문장(제목·UI 문구·예시·순수 서술)은 nonConditions:[{sourceId, locator:"L1-11", reason}] 로 범위째 묶는다.\n- 배경으로 적힌 문장도 이 시스템의 데이터 전달·확장 수용 같은 의무를 남기면 조건이다.\n- excluded 항목마다 그 근거 조건(conditions:["C-.."])과 residual 을 쓴다: 대상(화면 등)은 빠져도 이 시스템에 남는 의무는 residual.obligations:[{statement}] 로, 남는 의무가 없으면 residual.none 에 근거를 적는다. "이 시스템은 관여하지 않는다"로 끝내기 전에 그 조건이 성립하려면 이 시스템이 무엇을 해야 하는지 따진다. 조건이 다른 시스템·담당자의 처리에 기대면(예: "그쪽 설정으로 처리한다"), 그쪽이 처리하려면 이 시스템에서 무엇을 받아야 하는지(어떤 사실·데이터를 언제 전달하는지)가 남는 의무다. 앞으로 붙을 수 있다고 적힌 경우는 지금 데이터 모델·흐름이 그것을 막지 않아야 하는 의무다.`;
  }
  if (stage === 'interpret') return '\n\n[조건 매핑 — 공통 계약]\n- stages/scope.json 의 conditions 를 모두 처리한다: 각 조건을 다루는 항목(요구사항·질문·결정 등)의 conditions 에 C id 를 단다. 계획서의 conditions 목록은 쓰지 않는다(스크립트가 범위에서 옮긴다). 항목 id 는 C-<번호> 를 쓰지 않는다.\n- excluded 는 범위와 같게 두되, residual.obligations 마다 handledBy:[그 의무를 다루는 요구사항·질문 id] 를 단다.';
  if (stage === 'critic') return '\n\n[조건 매핑 점검]\n- 조건을 언급만 하고 그 의무를 실제로 다루지 않는 매핑, 근거가 약한 residual.none, 제외 항목이 남기는 의무를 다루지 않는 handledBy, nonConditions 로 묶은 범위에 섞인 조건 문장(extract 의 statements 와 대조)을 findings 로 지적한다. 다른 시스템에 맡긴 조건은 그 시스템이 처리하는 데 필요한 정보를 이 시스템이 전달하는지까지 본다. 질문을 drop 하면 그 질문에만 걸린 조건 매핑이 끊긴다.';
  return '';
}
