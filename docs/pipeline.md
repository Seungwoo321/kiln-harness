# 변환 파이프라인

여러 채널로 받은 기획·디자인 산출물과 현재 구현·API 계약을 입력으로, 개발자가 바로 쓰는
**작업계획(WorkPlan)** 한 벌을 만든다. 같은 입력이면 항상 같은 결과가 나온다.

## 원칙

| 원칙 | 적용 |
|---|---|
| 탐색은 코드, 판단은 LLM | 파싱·추출·대조·검증·렌더는 스크립트. LLM 은 범위·해석·매칭 예외만 판단한다 |
| 판단은 기록하고 재사용한다 | 판단은 입력 조각의 digest 에 묶어 `decisions/` 에 저장한다. 같은 digest 면 다시 판단하지 않는다 |
| 고정 스키마 | 단계 산출물은 JSON 이며 `schema/` 로 검증한다. 사람이 읽는 문서는 JSON 에서 렌더한다 |
| 생산자 ≠ 검증자 | LLM 단계의 산출물은 결정적 게이트(S5)가 검증한다. 생산 단계가 스스로 통과시키지 않는다 |
| 원본은 옮기지 않는다 | 입력은 경로·sha256·크기로 등록한다. 사례 폴더는 레포에 올리지 않는다 |

## 단계

| 단계 | 주체 | 입력 → 출력 |
|---|---|---|
| S1 register | 스크립트 | 입력 경로 목록 → `sources.json` (id·kind·role·path·sha256·bytes) |
| S2 extract | 스크립트 | 원본 → `extract/<sourceId>.json` (화면 앵커·주석 마커·라우트 키·문서 절·operation 목록·코드 인벤토리) |
| S2c catalog | 스크립트 | `sources.json` → `references.json` (자료별 접근 방법·위치·줄 수, 역할별 부재 경고). 모든 단계 프롬프트에 들어간다 |
| S3 scope | 에이전트 `roles/scope.md` | 앵커 → `scope.json` (이번 작업 화면 / 제외 화면과 근거). 게이트: 모든 plan·design 입력이 범위 판단에 쓰였다 |
| S4 interpret | 에이전트 `roles/interpret.md` | 범위·원본·계약·코드·결정 → 작업계획 초안. 스크립트가 envelope 를 채워 `workplan.json` 으로 조립한다 |
| S5 validate | 스크립트 | 후보 계획서 → 위반 목록 (아래 게이트). 위반은 S4 의 다음 시도에 주입된다 |
| S6 critic | 에이전트 `roles/critic.md` (S4 와 다른 세션·모델) | 계획서·원본 → `findings` (심각도·근거·권고). 게이트: 근거 필수, 대상 id 실재 |
| S7 render | 스크립트 | `WORKPLAN.md` · `WORKPLAN.html`(전체 문서) · `review.html`(변경 유형·지적·결정 화면) |

## 실행 구조

`node scripts/run.mjs <case>` 를 터미널에서 직접 돌린다. 에이전트는 단계마다 새 세션(`claude -p` 또는 `codex exec`)이고, 러너·모델·effort 는 `kh.config.json`(사례 폴더의 같은 이름 파일과 환경변수 `KH_<STAGE>_RUNNER|MODEL|EFFORT` 가 덮는다)에서 단계별로 고른다. 이름은 코드에 고정하지 않는다.

- **단계 루프:** 에이전트 실행 → 원본 무수정 확인 → 게이트 → 위반을 다음 시도 프롬프트에 주입. 단계당 최대 3회(`--attempts`).
- **전체 루프:** 한 단계라도 소진되면 파생 산출물(`stages/`·`scope.json`·`workplan.json`·렌더물)을 지우고 S3 부터 다시. 최대 3회(`--loops`). 지난 시도의 위반은 교훈으로 넘어간다. 실패 시도는 `failed/loop-N/` 에 남는다.
- **최종 실패:** 파생 산출물을 모두 삭제한다. 원본·`decisions.json` 은 보존하고 위반은 `run-status.json` 에 남는다.
- **건너뛰기·재개:** 원본과 결정이 그대로이고 현재 계획서가 검증을 통과하면 에이전트를 부르지 않는다. 결정만 바뀌면 `scope.json` 을 이어받고 기존 계획서 위에서 해당 항목만 다시 해석한다(`run-status.json` 의 `changedIds`).
- **권한:** 에이전트는 읽기와 `stages/` 아래 쓰기만 한다. 원본 해시가 바뀌면 그 시도는 실패다.
- **앰비언트 토큰:** Claude 는 전역 규칙·훅·스킬·MCP 를 끊어 새 세션 비용이 약 3천 토큰이다(끄지 않으면 약 2.8만). Codex 는 훅을 꺼도 기본 약 4.1만이다.

## 입력 구성 — 작업마다 근거가 다르다

근거로 쓸 자료는 작업마다 다르다: 사례 폴더 안의 산출물, 경로만 아는 코드 레포, 있을 수도 없을 수도 있는 API 스펙, 참조해야 하는 백엔드 레포. 그래서 **세션이 시작될 때 쓸 수 있는 자료가 `inputs.json` 에 모두 등록돼 있어야 한다.**

- 파일 원본(`plan-html`·`plan-doc`·`design-html`·`design-asset`·`context-doc`)은 경로로, 코드 레포(`code`)는 `repo`·`ref`·`paths` 로 등록한다(커밋으로 고정). 역할은 `plan`·`design`·`contract`·`implementation`·`context`. 백엔드 레포는 `code` + `implementation` 으로 하나 더 등록한다.
- 없는 자료는 등록하지 않는다. `references.json` 이 역할별 부재를 알려 주고, 에이전트는 없는 자료(예: API 계약)에 대해 사실을 단정하지 않는다.
- 에이전트는 카탈로그에 있는 자료만 근거로 고른다(`sourceRefs` 의 `sourceId`). 판단에 꼭 필요한 자료가 없으면 지어내지 않고 `missingInputs` 로 알린다 — 파이프라인은 재시도하지 않고 `run-status.json` 에 `result:"needs-input"` 과 목록을 남기고 종료 코드 3 으로 끝난다. `inputs.json` 에 자료를 더하고 다시 실행한다.
- 코드는 등록한 커밋 기준으로 `git show`·`git grep`·`git ls-tree` 로 읽는다(작업 트리가 아니다).

## 사용자 결정

검토 화면(`review.html`)은 읽기 전용이고 모든 항목에 id 가 있다. 결정은 터미널에서 `node scripts/decide.mjs <case> <id> <stance> "<결정>"` 로 남기고, `node scripts/run.mjs <case>` 를 다시 돌리면 반영된다.

## S5 게이트

- 스키마 적합
- 모든 요구사항·상태·배치에 출처 앵커(`sourceRefs`)가 있다. 추론으로 채운 항목은 `inferred` 와 결정 id 를 가진다
- 모든 `operationId` 가 등록된 API 계약에 있다
- 모든 대상 파일이 현재 코드에 있거나 `new` 로 표시돼 있다
- 범위 안 화면마다 상태 표(로딩·빈·오류·권한·비활성 등)가 채워져 있거나 `n/a` 근거가 있다
- 열린 결정은 `questions` 에 모이고, 본문에서 확정값처럼 쓰이지 않는다

## 사례 폴더

```
cases/<case>/
  inputs.json        # S1 입력 목록(경로·역할)
  sources/           # 받은 원본(plan·design·context·jira) — 업무 자료, 레포에 올리지 않는다
  sources.json       # S1 출력
  extract/           # S2
  kh.config.json     # (선택) 이 사례의 단계별 러너·모델
  decisions.json     # 사용자 결정 (decide.mjs)
  scope.json         # S3
  stages/            # 에이전트 작업물 (scope.json · workplan.draft.json · critic.json)
  workplan.json      # S4~S6 (schemaVersion 2)
  WORKPLAN.md · WORKPLAN.html · review.html   # S7
  run-status.json    # 단계별 시도·토큰·결과·위반
  failed/            # 실패한 전체 시도의 스냅샷
```
