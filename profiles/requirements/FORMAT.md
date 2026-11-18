# requirements 결과 형식

`stages/workplan.draft.json` 하나를 쓴다. envelope·`conditions`·`findings` 는 스크립트가 채운다. 검사 규칙의 정본은 `validate.mjs` 다.

| 필드 | 형식 |
|---|---|
| `title` · `summary` | 요구 정의의 대상과 요지 3줄 이내 |
| `requirements` | `{id:"R-01", statement, conditions:["C-.."], sourceRefs, acceptance:[{when, then}]}` — 조건에서 나온 요구사항 |
| `open` | `{id:"U-01", question, default, impact:["R-.."]}` — 원본으로 정할 수 없는 미결과, 정해지기 전까지 따르는 기본값 |
| `excluded` | 범위의 제외 항목 그대로, `residual.obligations[].handledBy` 를 더한다 — 범위 밖 목록 |
| `changes` | `{id:"CH-01", change, reason, sourceRefs?}` — 원본·회의 기록이 밝힌 요구 변경과 그 사유 |
| `questions` · `decisions` | `{id:"Q-01", question, conditions?}` · `{id:"D-01", statement, rationale, sourceRefs, conditions?}` |

- 모든 조건은 요구사항·미결·결정·제외 중 어딘가에서 `conditions` 로 처리된다(엔진 공통 계약).
- 수용기준은 검증할 수 있어야 한다: `when`(상황·조작)과 `then`(관찰할 수 있는 결과)을 쓴다. "잘 동작한다", "빠르다" 같은 판정 불가 문장은 쓰지 않는다.
- 미결은 예산(`kh.config.json` 의 `profiles.requirements.openBudget`, 기본 10건) 안에서만 둔다. 원본·결정으로 정할 수 있는 것은 미결이 아니다.
