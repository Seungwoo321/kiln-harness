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
| S2d design-spec | 스크립트 | 디자인 HTML → `design-spec/<sourceId>.json`·`component-baseline.json`·`existing-patterns.json`. 실행 순서는 extract → design-spec → catalog다 |
| S3 scope | 에이전트 `roles/scope.md` | 앵커 → `scope.json` (이번 작업 화면 / 제외 화면과 근거). 게이트: 모든 plan·design 입력이 범위 판단에 쓰였다 |
| S4 interpret | 에이전트 `roles/interpret.md` | 범위·원본·계약·코드·결정 → 작업계획 초안. 스크립트가 envelope 를 채워 `workplan.json` 으로 조립한다 |
| S5 validate | 스크립트 | 후보 계획서 → 위반 목록 (아래 게이트). 위반은 S4 의 다음 시도에 주입된다 |
| S6 critic | 에이전트 `roles/critic.md` (S4 와 다른 세션·모델) | 계획서·원본 → `findings` (심각도·근거·권고). 게이트: 근거 필수, 대상 id 실재 |
| S7 render | 스크립트 | `WORKPLAN.md` · `WORKPLAN.html`(전체 문서) · `review.html`(변경 유형·지적·결정 화면) |
| S8 verify | 스크립트 + 에이전트 `roles/conformance.md` | 구현 URL·코드 → `conformance-facts.json` → LLM 판정 → `conformance.json`·`conformance-brief.md`·review.html의 시안 적합성 절 |

## 출처별 수용 정책

| 출처·분류 | 적용 |
|---|---|
| plan / adopt | 정책·규칙·데이터 의미만 원본 근거로 채택한다 |
| plan / existing-pattern | implementation 커밋의 같은 UI 사용례를 근거로 기존 패턴을 따른다 |
| plan / omission-suspect | 기존 패턴의 누락 의심을 기획 질문으로 남긴다 |
| plan / prototype-artifact | 임의 구현·미구현·데모 동작을 제외하고 이유를 기록한다 |
| design | 구조·동작·문구를 엄격히 따른다. px보다 컴포넌트 규칙이 우선한다 |

기획 UI의 분류는 에이전트가 판단한다. 스크립트는 근거 경로·증거 id·동작 충돌을 검사한다. 컴포넌트 적용 순서는 size/variant/prop → 기존 조합 → 반복 UI의 신규 컴포넌트 판단이다. 임의 px 덮어쓰기는 새 갭이다.

S2d는 로컬 Chrome과 Node 내장 WebSocket을 사용한다. 파일은 상대 자산 루트의 정적 서버로 렌더한다. Chrome 부재는 references.json과 run-status.json의 `design-spec:skipped`에 이유를 남긴다. 렌더 실패는 실패다. 데이터·캐시·프로토콜 계약은 [설계](design-conformance.md)를 따른다.

S8은 계획서 생성 후 독립적으로 실행한다. 스크립트는 `--code`의 JSX에서 임의 크기 클래스 존재와 CSS 토큰 선언 여부를 수집한다. 기존 className 토큰 사용례를 후보로 제공한다. 수치 차이와 오차 안팎은 사실이다. 의미 대응과 acceptable·gap 등 판정은 별도 LLM 세션이 맡는다. `run.mjs --conformance`는 수집된 사실에 대한 판정만 재실행한다. gap·ds-override·token-missing·behavior-mismatch 판정은 종료 코드 1이다. needs-component는 경고다. 판단을 완료하지 못하면 3이다.

범위·해석·비평·적합성 역할은 [문서와 명세 작성 지침](writing.md)을 공통 입력으로 받는다. 스크립트는 문장 품질을 자동 판정하지 않는다.

## 실행 구조

`node scripts/run.mjs <case>` 를 터미널에서 직접 돌린다. 에이전트는 단계마다 새 세션(`claude -p` 또는 `codex exec`)이고, 러너·모델·effort 는 `kh.config.json`(사례 폴더의 같은 이름 파일과 환경변수 `KH_<STAGE>_RUNNER|MODEL|EFFORT` 가 덮는다)에서 단계별로 고른다. 이름은 코드에 고정하지 않는다.

- **단계 루프:** 에이전트 실행 → 원본 무수정 확인 → 게이트 → 위반을 다음 시도 프롬프트에 주입. 단계당 최대 3회(`--attempts`).
- **전체 루프:** 한 단계라도 소진되면 파생 산출물(`stages/`·`scope.json`·`workplan.json`·렌더물)을 지우고 S3 부터 다시. 최대 3회(`--loops`). 지난 시도의 위반은 교훈으로 넘어간다. 실패 시도는 `failed/loop-N/` 에 남는다.
- **검토 수준:** `--level 0~10`(기본 5)이 해석·비평 프롬프트와 결정적 게이트의 엄격도를 정한다(README "검토 수준"). 수준이 바뀌면 범위만 이어받고 계획서는 새로 해석한다.
- **실시간 표시:** 에이전트는 자식 프로세스로 띄워 출력을 `stages/.agent-*.log` 에 쌓고(같은 프로세스 그룹 — Ctrl-C 가 함께 간다), 부모는 1초마다 깨어 로그를 이어 읽어 터미널 진행 블록을 다시 그린다(`lib/live.mjs`).
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
  design-spec/       # S2d 요소·동작·클래스·토큰 증거
  component-baseline.json · existing-patterns.json · design-spec-status.json
  workplan.json      # S4~S6 (schemaVersion 3)
  WORKPLAN.md · WORKPLAN.html · review.html   # S7
  run-status.json    # 단계별 시도·토큰·결과·위반
  conformance-facts.json · conformance.json · conformance-brief.md   # S8
  failed/            # 실패한 전체 시도의 스냅샷
```
