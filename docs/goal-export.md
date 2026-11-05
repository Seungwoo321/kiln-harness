# 실행 목표 내보내기

승인된 분석(`workplan.json`·`decisions.json`)을 실행 쪽이 목표(goal)로 바로 만들 수 있는 JSON 으로 낸다. 목표 문구·수용 기준·단위를 사람이 옮겨 적지 않게 하려는 것이며, 특정 실행 도구에 묶이지 않는다.

```bash
node scripts/export-goal.mjs cases/<case> --out goal.json   # --out 이 없으면 표준출력
```

- **승인된 분석만 낸다.** `run-status.json` 이 `passed` 이고 `workplan.json` 의 digest 가 통과한 실행의 `workplanDigest` 와 같아야 한다. 아니면 종료 코드 1 이다.
- **같은 입력이면 같은 출력이다.** 시각·난수를 넣지 않는다.

## 형식 (`kind: WorkGoalExport`, `schemaVersion: 1`)

| 필드 | 내용 |
|---|---|
| `caseId` | 사례 id |
| `objective` · `summary?` | 계획서의 `title` · `summary` 그대로 |
| `criteria[]` | 모든 요구사항의 `acceptance` 문장을 **한 글자도 바꾸지 않고** 요구사항 순서대로 편 목록. `{requirement, surface, text, units[]}` — `units` 는 그 요구사항을 `covers` 하는 단위 id |
| `units[]` | 계획서의 task 를 `dependsOn` 순서(의존이 없으면 계획서 순서)로 늘어놓은 목록. `{order, id, title, changeKind, ticket?, dependsOn[], files[], acceptance[]}` — `acceptance` 는 그 단위가 `covers` 하는 요구사항의 문장 `{requirement, text}`. 요구사항을 덮지 않는 단위는 비어 있다(기준을 지어내지 않는다) |
| `references` | `workplan` `{file, digest}` · `decisions` `{file, count, digest}` · `inputDigests[]` (원본 digest). digest 는 정규형 sha256 |
| `openQuestions[]` | 계획서에 아직 남은 질문 id. 실행 쪽이 착수 전에 확인할 목록이다 |
| `digest` | 위 전체의 정규형 sha256 |

실행 쪽은 `references.workplan.digest` 와 자기 목표의 기록을 비교해 분석이 바뀌었는지 알 수 있다.
