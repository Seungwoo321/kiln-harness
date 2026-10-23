# 작업계획(WorkPlan) 형식

개발자가 기획 HTML·문서·실제 앱을 오가지 않고 이것 하나로 구현을 시작할 수 있게 하는 산출물이다.
JSON(`workplan.json`)이 정본이고 Markdown(`WORKPLAN.md`)은 렌더 결과다. 검사 규칙의 정본은 `scripts/validate.mjs` 다.

## envelope

| 필드 | 뜻 |
|---|---|
| `schemaVersion` | `1` |
| `kind` | `WorkPlan` |
| `caseId` | `sources.json` 의 caseId |
| `inputDigests` | `sources.json` 각 원본의 sha256 전부. 원본이 바뀌면 검증에서 막힌다 |
| `title` · `summary` | 문서 제목과 3줄 이내 요약 |

## 절과 필드

모든 항목의 `id` 는 문서 안에서 유일하다. `sourceRefs` 는 `[{ sourceId, locator }]` 다.
`basis` 가 `inferred` 인 항목은 `question` 에 `questions` 의 id 를 단다.

| 절 | 필드 |
|---|---|
| `surfaces` | `id` `title` `entry`(라우트·모달 탭·진입 버튼) `change`(`new`·`changed`) `sourceRefs` |
| `excluded` | `title` `reason` `sourceRefs` — 원본에 있지만 이번 작업이 아닌 화면 |
| `requirements` | `id` `surface` `statement` `acceptance[]` `basis` `question?` `sourceRefs` |
| `states` | `id` `surface` `region` `state` `condition` `display` `behavior?` `basis` `question?` `sourceRefs` — 화면마다 1개 이상 |
| `components` | `id` `surface` `parent?` `name` `file` `fileStatus`(`existing`·`new`) `ds{component, match(exact·adapt·custom), reason}` `sourceRefs` |
| `apiBindings` | `id` `operationId` `surface` `component` `trigger`(`load`·`submit`·`toggle`·`action`·`refresh`) `request` `response` `errors` `sourceRefs` |
| `i18n` | `key` `status`(`new`·`existing`) `text?` |
| `gaps` | `id` `surface` `current` `target` `file?` |
| `tasks` | `id` `title` `files[]` `dependsOn[]` `ticket?` `covers[]` — 모든 component·apiBinding 이 어느 task 에 들어간다. covers 는 비울 수 없다 |
| `newFiles` | `file` `reason` — component 가 아닌 새 파일(훅·mock·테스트 등). tasks·gaps 의 파일은 현재 코드에 있거나 new 로 선언돼 있어야 한다 |
| `questions` | `id` `to`(`plan`·`design`·`backend`) `question` `options[]` `assumption` `impact[]` |

## locator

| 원본 | 형식 |
|---|---|
| HTML·JS | `L<시작>-<끝>` 행 범위, 또는 `#id` · `[data-panel=…]` · `SCREENS['key']` · 주석 마커 문구 |
| docx·Markdown | 절 경로 (`UI 정의 > 3.1 테스트 상태 별 메시지`) |
| 코드 | `path:line` |
| API 계약 | `operationId` 또는 스키마 이름 |

## 판정 규칙

- 원본끼리 어긋나면 우선순위는 **디자인 시안 > 기획 HTML > 기획 문서** 다. 단 정책·규칙(수신 조건, 마스킹, 저장 규칙)은 기획 문서가 정본이다. 어긋남은 `questions` 에 남긴다.
- 확정된 구현 결정(context 원본)은 원본보다 앞선다.
- 디자인 시스템에 같은 역할의 컴포넌트가 있으면 `exact`, 속성·조합으로 맞추면 `adapt`, 없으면 `custom` 이다. `custom` 은 이유를 적는다.

## v2 — 변경 유형 · 지적 · 사용자 결정

`schemaVersion: 2` 일 때만 적용된다(v1 은 그대로 검증된다).

| 절 | 필드 |
|---|---|
| `tasks[].changeKind` | `new-page`·`new-menu`·`ds-component-new`·`ds-component-edit`·`feature-change`(기존 피처의 배치·컴포넌트 수정)·`feature-copy`(문구)·`i18n`·`api-wiring` — 모든 task 가 하나를 가진다 |
| `findings` | `id` `severity`(high·medium·low) `origin`(plan·design·code·contract·workplan) `target`(계획서의 id) `message` `evidence?` `recommendation` `stance` — 입력 산출물이나 계획서의 불완전한 부분 |

`stance` 는 권고다: `follow-existing`(기존 패턴을 따른다) · `re-review`(다시 검토한다) · `ask-plan`·`ask-design`·`ask-backend`(담당자에게 확인한다).

changeKind 와 covers 의 정합(결정적 검사)
- `new-page`·`new-menu` → `change:new` 인 화면을 covers 에 포함
- `api-wiring` → apiBinding 을 포함
- `ds-component-new` → `fileStatus:new` 인 component, `ds-component-edit` → `fileStatus:existing` 인 component 를 포함

### decisions.json

검토 화면의 항목 id 에 대한 사용자 결정이다. `scripts/decide.mjs` 로만 쓴다.

| 필드 | 뜻 |
|---|---|
| `id` | 계획서의 항목 id (surfaces·requirements·states·components·apiBindings·gaps·questions·tasks·findings) |
| `stance` | 위 권고 값 또는 `decided`(결정 확정) |
| `note` | 결정 내용 |
| `itemDigest` | 결정 시점 항목의 digest. 항목이 다시 해석돼 달라지면 화면에 `stale` 로 드러난다 |

계획서에 없는 id 를 가리키는 결정은 검증에서 막힌다. 시각은 적지 않는다.

### questions · decisions — 질문의 두 종류와 결정 기록 (v2)

`questions` 는 **담당자(기획·디자인·백엔드)에게 전달되는 것**만이다. 두 종류이고, 둘 다 원본 위치로 뒷받침돼야 한다.

| `kind` | 언제 | 필수 |
|---|---|---|
| `confirm` | 원본끼리 실제로 다르다 · 한쪽이 잘못됐다 · 우리 패턴(현재 코드)에 안 맞아 제안할 것이 있다 | `claimType`: `mismatch`(서로 다른 **두 원본**의 위치, `sourceRefs` 2개 이상·원본 2개 이상) · `wrong`·`pattern`(`evidence`: 무엇이 왜 잘못·패턴 위반인지) |
| `notice` | 원본 어디에도 정의가 없어 추론·개발 결정한 것 — "이렇게 정했다"(`assumption`)를 알린다 | `searched: [{sourceId, scope}]` — 찾아본 범위. 계약(contract)·확정 결정(context) 원본을 모두 포함해야 한다 |

공통: `to`(plan·design·backend) `question` `assumption` `options` `impact` `sourceRefs`(1개 이상, 각 locator 는 그 원본에 실재해야 한다 — 행 범위가 줄 수 안, 앵커 값과 일치, 또는 본문에 그 문자열이 있음).

`basis:"inferred"` 항목은 반드시 `kind:"notice"` 질문을 `question` 으로 가리킨다.

**질문에서 빠지는 것은 원본이 이미 답한 것뿐이다 — `decisions` 로만 기록한다.** `decisions[]` = `{id, kind, statement, rationale, sourceRefs, surface?}`

| `kind` | 뜻 |
|---|---|
| `answered-by-source` | 원본이 명시함 |
| `sources-agree` | 기획 HTML 과 디자인 등 서로 다른 두 원본이 같음 (원본 2개 이상의 위치) |
| `single-source` | 한쪽에만 있어 그쪽을 따름 |
| `fitted` | (검토 수준 0~3 전용) 원본이 비었거나 어긋나 근거 자료에 **끼워 맞춘** 해석. `alternatives: [{option, whyNot}]`(검토한 다른 해석, 1개 이상) 필수. 이 결정에 기대는 항목은 `basis:"fitted"` + `decision:"<결정 id>"` |

**검토 수준(`level`, 0~10, 기본 5)** 은 계획서 최상위에 기록된다. 0~3 이면 모든 질문에 `blocking:true` · `blockedReason` · `triedFits:[{option, whyNot}]`(0 은 3개 이상, 1~3 은 2개 이상)가 필요하다. 7 이상이면 모든 요구사항·상태가 task 의 `covers` 에 들어가야 하고, 8 이상이면 비평 결과에 화면별 `coverage:[{surface, sourcesCompared[], result, note?}]`(기획·디자인·계약 원본을 모두 대조)가 있어야 하며, 9 이상이면 요구사항마다 `acceptance` 가 2개 이상이다.

비평 단계는 모든 질문을 원본에 대조해 `questionVerdicts` 를 낸다: `keep`(기준에 맞음) · `demote`(원본이 이미 답함 — `decision` 을 달아 결정으로 내림, 그 질문에 기대던 추론 항목은 같은 근거를 단 원본 근거 항목이 된다) · `drop`(중복·내용 없음, `reason`). 추론 항목이 가리키는 notice 는 drop 할 수 없고, 이전 결정과의 충돌 질문은 내리거나 제거할 수 없다.

## 후속 사례 (계보)

`inputs.json` 에 `"previous": { "case": "<이전 사례 이름 또는 절대경로>", "supersedes": { "<새 원본 id>": "<이전 원본 id>" } }` 를 적는다. `supersedes` 가 없으면 같은 id 의 원본끼리 짝이다. 이전 사례는 끝까지 통과해 있어야 한다.

- 현재 상태의 정본은 이 사례가 S1 에서 커밋으로 고정한 코드, 결정 근거의 정본은 이전 사례 기록(결정·열린 확인 요청·추론 항목)이다.
- `lineage.json`(S2b, 결정적): 원본별 상태 `new`·`unchanged`·`changed`·`code`, 바뀐 영역·추가/제거 앵커, 이전 결정, 이전 열린 확인 요청, 이전 추론 항목.
- 범위 게이트: 변경 없는 원본만 근거인 화면은 범위가 될 수 없다.
- 계획서 `lineage` = `{ previous, inherited[], resolved[] }`
  - `inherited[]` — 이전 결정마다 정확히 하나: `{ref, status: kept|conflict|obsolete, note, target?, question?}`. 새 기획이 결정과 어긋날 때만 `conflict` 이고, 반드시 `questions` 로 올린다(누락으로 되돌리지 않는다).
  - `resolved[]` — 이전 열린 확인 요청마다 정확히 하나: `{ref, status: resolved|still-open|obsolete, note, evidence?, question?}`. `resolved` 는 새 원본·코드의 근거가 필요하고, `still-open` 은 새 질문 id 가 필요하다.
