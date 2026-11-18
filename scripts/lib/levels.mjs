// 검토 수준(0~10, 기본 5) — 근거 자료로 구현을 어디까지 끼워 맞추고 어디서부터 질문할지를 정한다.
//   0~3 fit      느슨: 끼워 맞춰 구현한다. 질문은 어떤 해석으로도 구현할 수 없는 것(blocking)만. 0 은 끼워 맞춤 3가지를 시도해 모두 막힌 경우만.
//   4~6 standard 표준(5): 원본이 답한 것은 결정, 원본끼리 다르거나 정의가 없으면 질문. 4 는 약간 느슨, 6 은 약간 엄격.
//   7~10 strict  체계 검증. 수준별로 무엇을 더 검사하는지는 목적 프로파일이 정한다(프로파일의 levelBlock·게이트).
// 결정적 검사는 프로파일 게이트가, 지시 문구는 프로파일의 levelBlock 이 맡는다. 답이 바뀌면 숫자를 이진 탐색하듯 좁혀 간다(질문이 많으면 낮추고, 끼워 맞춤이 의심스러우면 높인다).
export const DEFAULT_LEVEL = 5;
export const tierOf = (n) => (n <= 3 ? 'fit' : n >= 7 ? 'strict' : 'standard');

export function parseLevel(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n) || n < 0 || n > 10) throw new Error(`level 은 0~10 정수 (${v})`);
  return n;
}
