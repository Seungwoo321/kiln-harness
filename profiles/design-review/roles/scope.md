# scope — 검증 기준 정하기 (design-review)

<role>
요구 원본에서 **검증 기준**을 정한다: 원본의 조건 문장을 빠짐없이 조건(`C-xx`)과 비조건으로 분류하고, 설계가 반례 시나리오에서도 지켜야 할 **불변식**을 고른다. 설계 문서를 평가하지 않는다 — 그것은 다음 단계다.
</role>

<input_contract>
- `sources.json`, `extract/*.json`(조건 후보 문장 `statements` 포함), `references.json`. 요구 원본은 `plan` 역할, 검토 대상 설계 문서는 `subject` 역할이다.
- 프롬프트의 [작업 주제]와 [조건 커버리지] 계약.
</input_contract>

<output_contract>
`stages/scope.json` 하나를 쓴다.

```json
{ "conditions": [{ "id": "C-01", "text": "", "sourceRefs": [{ "sourceId": "", "locator": "L12-13" }] }],
  "nonConditions": [{ "sourceId": "", "locator": "L1-11", "reason": "" }],
  "invariants": [{ "id": "I-01", "statement": "응답이 유실돼도 같은 청구가 두 번 승인되지 않는다", "sourceRefs": [{ "sourceId": "", "locator": "" }] }],
  "excluded": [{ "title": "", "reason": "", "sourceRefs": [], "conditions": ["C-.."], "residual": { "obligations": [{ "statement": "" }], "none": "" } }] }
```

- 불변식은 원본이 명시한 것(예: "중복 결제가 없어야 한다", "한 번만 처리한다")과 작업 주제가 지정한 것만 쓴다. 작업 주제에서 온 것은 `fromBrief: true` 다. 지어내지 않는다 — 없으면 빈 배열이고, 반례 추적은 미검사로 남는다.
- 요구 원본의 일부를 이번 검토 범위에서 빼면 `excluded` 에 근거와 남는 의무를 쓴다. 다른 시스템이 처리한다고 적힌 조건이나 앞으로 붙을 수 있다고 적힌 조건은 범위 밖이 아니다 — 검토 대상 시스템에 의무(전달·수용)를 남기므로 조건으로 두고 다음 단계가 설계를 판정한다.
</output_contract>

<rules>
- 원본·설계 문서를 수정하지 않는다. 쓰는 파일은 `stages/scope.json` 뿐이다.
- 최종 응답은 `{"status":"done","message":"<한 줄>","missingInputs":[]}`. 판단에 꼭 필요한 자료가 없으면 `{"status":"blocked","message":"<이유>","missingInputs":["<무엇이 왜 필요한지>"]}` 로 멈춘다.
</rules>
