// 목적 프로파일 등록표. 엔진은 프로파일이 무엇을 분류·해석·검증·렌더하는지 모르고 이 계약만 호출한다.
// 사례는 inputs.json 의 purpose 로, 계획서는 envelope 의 kind 로 프로파일을 찾는다(프로파일마다 kind 가 다르다).
// 등록은 정적 import 다 — 파이프라인이 동기·결정적으로 남는다.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import feWorkplan from '../../profiles/fe-workplan/profile.mjs';
import designReview from '../../profiles/design-review/profile.mjs';
import requirementsProfile from '../../profiles/requirements/profile.mjs';

export const DEFAULT_PURPOSE = 'fe-workplan';
// 등록표는 호출 시점에 만든다 — 프로파일 모듈이 엔진 모듈을 다시 가져오는 순환에서 평가 순서에 기대지 않는다.
const registry = () => [feWorkplan, designReview, requirementsProfile];
export const purposes = () => registry().map((p) => p.id);

export function profileById(id) {
  const p = registry().find((x) => x.id === id);
  if (!p) throw new Error(`알 수 없는 목적 프로파일 — ${id} (가능: ${purposes().join(', ')})`);
  return p;
}

export function purposeOf(dir) {
  const file = join(dir, 'inputs.json');
  return (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).purpose : undefined) ?? DEFAULT_PURPOSE;
}

export const loadProfile = (dir) => profileById(purposeOf(dir));

// kind 가 없는 계획서(프로파일 도입 이전 형식·이전 계획서가 없는 경우)는 기본 프로파일로 읽는다.
export function profileForPlan(plan) {
  if (!plan?.kind) return profileById(DEFAULT_PURPOSE);
  const p = registry().find((x) => x.kind === plan.kind);
  if (!p) throw new Error(`계획서 kind 에 맞는 프로파일이 없음 — ${plan?.kind}`);
  return p;
}

// 엔진 공통 항목(질문·결정·지적)과 프로파일 항목. 결정 기록은 모든 항목을, 증분 판정은 결정·지적을 뺀 항목을 본다.
export const decidableSections = (profile) => [...profile.sections, 'questions', 'decisions', 'findings'];
export const reviewedSections = (profile) => [...profile.sections, 'questions'];
