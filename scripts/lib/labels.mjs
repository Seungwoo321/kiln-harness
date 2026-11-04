// ds.match 값의 표시 이름. 값 자체(exact·adapt·custom)는 형식 정본이고, 렌더 화면은 이 이름을 쓴다.
// 세 값 모두 컴포넌트가 디자인 시스템 부품을 어떻게 쓰는지를 말한다 — 디자인 시스템 자체를 고친다는 뜻이 아니다.
export const DS_MATCH_LABEL = {
  exact: 'DS 그대로 사용',
  adapt: 'DS 부품 조합',
  custom: 'DS에 없음',
};

export const dsMatchLabel = (match) => DS_MATCH_LABEL[match] ?? match;
