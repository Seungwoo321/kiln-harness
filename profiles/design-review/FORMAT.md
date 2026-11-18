# design-review 결과 형식

`stages/workplan.draft.json` 하나를 쓴다. envelope(`schemaVersion`·`kind`·`caseId`·`inputDigests`)·`conditions`·`findings` 는 스크립트가 채운다. 검사 규칙의 정본은 `validate.mjs` 다.

| 필드 | 형식 |
|---|---|
| `title` · `summary` | 검토 대상과 결론 3줄 이내 |
| `invariants` | `stages/scope.json` 의 불변식 그대로 `[{id:"I-01", statement, sourceRefs \| fromBrief:true}]` |
| `coverage` | 조건(`C-xx`)마다 정확히 한 행 `{id:"V-01", condition:"C-01", conditions:["C-01"], status, locations:[{sourceId, locator}], note}` |
| `traces` | 불변식 × 시나리오마다 정확히 한 행 `{id:"X-01", invariant:"I-01", scenario, verdict, steps:[{ref:{sourceId, locator}, state}], counterexample?, gap?, reason?}` |
| `remedies` | `{id:"M-01", addresses:["V-03","X-02"], proposal, targets:[{sourceId, section}]}` |
| `questions` · `decisions` | `{id:"Q-01", question, sourceRefs, conditions?}` · `{id:"D-01", statement, rationale, sourceRefs, conditions?}` |

- `status`: `covered`(설계가 그 조건을 처리한다) · `mention-only`(언급만 있고 처리 흐름·데이터·상태가 없다) · `missing`(어디에도 없다) · `excluded`(범위 밖 — 범위의 제외 항목이 남는 의무 없음 `residual.none` 으로 선언한 조건에만. note 에 근거). `covered`·`mention-only` 는 검토 대상 문서(`subject`)의 위치가 필요하다.
- `scenario`: `response-loss`(응답 유실) · `concurrency`(동시 실행) · `retry`(재전송) · `late-arrival`(지연 도착) · `partial-failure`(부분 실패).
- `verdict`: `holds`(문서대로라면 불변식이 지켜진다) · `breaks`(깨지는 경로가 있다 — `counterexample`) · `undocumented`(문서만으로 다음 상태를 정할 수 없다 — `gap`) · `n/a`(이 불변식에 해당하지 않는다 — `reason`). `n/a` 가 아니면 `steps` 에 단계마다 문서 위치와 그 단계의 상태를 적는다.
- 불변식이 없으면 `traces` 는 비운다. 검토 화면이 "반례 추적 미검사"로 보인다.
- `missing`·`mention-only` 커버리지와 `breaks`·`undocumented` 추적은 모두 보완안의 `addresses` 에 들어가야 한다.
- 문서 위치 locator 는 Markdown·HTML 행 범위 `L<시작>-<끝>`, docx 문단 범위 `P<시작>-<끝>`, 또는 문서 절 경로다.
