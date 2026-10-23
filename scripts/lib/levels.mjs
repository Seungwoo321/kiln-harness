// 검토 수준(0~10, 기본 5) — 근거 자료로 구현을 어디까지 끼워 맞추고 어디서부터 질문할지를 정한다.
//   0~3 fit      느슨: 끼워 맞춰 구현한다. 질문은 어떤 해석으로도 구현할 수 없는 것(blocking)만. 0 은 끼워 맞춤 3가지를 시도해 모두 막힌 경우만.
//   4~6 standard 표준(5): 원본이 답한 것은 결정, 원본끼리 다르거나 정의가 없으면 질문. 4 는 약간 느슨, 6 은 약간 엄격.
//   7~10 strict  체계 검증: 7 요구·상태 모두 task 연결 · 8 화면별 원본 대조 기록(coverage) · 9 수용기준 2개 이상 · 10 위 전부 + 가장 보수적인 판정.
// 결정적 검사는 validate.mjs·pipeline.mjs 가, 아래 문구는 에이전트에게 주는 지시다. 답이 바뀌면 숫자를 이진 탐색하듯 좁혀 간다(질문이 많으면 낮추고, 끼워 맞춤이 의심스러우면 높인다).
export const DEFAULT_LEVEL = 5;
export const tierOf = (n) => (n <= 3 ? 'fit' : n >= 7 ? 'strict' : 'standard');

export function parseLevel(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n) || n < 0 || n > 10) throw new Error(`level 은 0~10 정수 (${v})`);
  return n;
}

export function levelBlock(stage, n) {
  const tier = tierOf(n);
  if (stage === 'scope') return '';
  const head = `\n\n[검토 수준 ${n}/10 — ${{ fit: '느슨(끼워 맞춤)', standard: '표준', strict: '체계 검증' }[tier]}]`;
  if (tier === 'fit') {
    return stage === 'interpret'
      ? `${head}\n- 근거 자료(기획·디자인·계약·기존 코드 패턴)로 구현할 수 있는 한 어떻게든 끼워 맞춰 구현한다. 원본이 비었거나 어긋나도 가장 가까운 해석을 골라 계획에 넣는다.\n- 끼워 맞춘 것은 질문이 아니라 \`decisions\` 에 \`kind:"fitted"\` 로 기록한다: statement·rationale(어떤 근거로 어떻게 맞췄나)·sourceRefs·\`alternatives:[{option, whyNot}]\`(검토한 다른 해석, 1개 이상). 그 결정에 기대는 요구사항·상태는 \`basis:"fitted"\` + \`decision:"<결정 id>"\` 로 쓴다(\`basis:"inferred"\` 는 blocking notice 에만 쓴다).\n- \`questions\` 는 **어떤 해석으로도 구현할 수 없는 것**만 남긴다. 질문마다 \`blocking:true\`, \`blockedReason\`(왜 구현할 수 없나), \`triedFits:[{option, whyNot}]\`(시도한 끼워 맞춤 ${n === 0 ? '3개' : '2개'} 이상)를 쓴다. 취향·선호·세부 모호함은 질문이 아니라 fitted 결정이다.`
      : `${head}\n- 질문은 \`blocking:true\` 인 것만 \`keep\` 한다. 나머지는 \`demote\` 하고 \`decision\`(kind:"fitted", statement·rationale·sourceRefs·alternatives[{option, whyNot}])을 단다. 가장 가까운 해석으로 구현할 수 있다면 blocking 이 아니다.\n- 끼워 맞춤이 원본과 모순되거나 근거(sourceRefs)가 약한 fitted 결정은 findings 로 지적한다.`;
  }
  if (tier === 'strict') {
    const i = `${head}\n- 모든 요구사항·상태·컴포넌트·API 는 원본 위치(sourceRefs)로 뒷받침하고, 모든 요구사항·상태가 어느 task 의 covers 에 들어가야 한다.\n- 한쪽 원본에만 있는 것은 반대편 원본(기획↔디자인↔계약↔코드)을 실제로 찾아본 뒤에 \`single-source\` 로 기록한다. 추론은 모두 notice 로 알린다.${n >= 9 ? '\n- 요구사항마다 acceptance 를 2개 이상, 검증 가능한 문장으로 쓴다.' : ''}`;
    const c = `${head}\n- 근거 없이 '없다/다르다'고 주장하는 질문은 demote·drop 하고, 대조가 부족한 곳은 findings 로 지적한다.${n >= 8 ? '\n- 화면마다 기획·디자인·계약 원본을 모두 실제로 대조하고 결과를 \`coverage:[{surface, sourcesCompared:[sourceId…], result:"consistent|issues", note}]\` 로 적는다. 대조하지 않은 원본이 있으면 통과시키지 않는다.' : ''}${n === 10 ? '\n- 가장 보수적으로 판정한다: 의심스러우면 keep, 근거가 약한 결정은 findings.' : ''}`;
    return stage === 'interpret' ? i : c;
  }
  if (n === 4) return `${head}\n- 애매하면 질문보다 원본을 따라 결정(decisions)으로 내리는 쪽을 택한다.`;
  if (n === 6) return `${head}\n- 애매하면 원본을 따랐다고 단정하지 말고 질문으로 올리는 쪽을 택한다.`;
  return '';
}
