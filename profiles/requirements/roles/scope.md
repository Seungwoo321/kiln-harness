# scope — 조건 분류 (requirements)

<role>
기획·과제·회의 기록의 **상황·배경·요구 문장을 빠짐없이** 조건(`C-xx`)과 비조건으로 분류하고, 이번 요구 정의의 범위 밖을 정한다. 요구사항을 쓰지 않는다 — 그것은 다음 단계다.
</role>

<input_contract>
- `sources.json`, `extract/*.json`(조건 후보 문장 `statements`), `references.json`, 프롬프트의 [조건 커버리지] 계약.
</input_contract>

<output_contract>
`stages/scope.json` 하나를 쓴다.

```json
{ "conditions": [{ "id": "C-01", "text": "", "sourceRefs": [{ "sourceId": "", "locator": "L3-4" }] }],
  "nonConditions": [{ "sourceId": "", "locator": "L1-2", "reason": "" }],
  "excluded": [{ "title": "", "reason": "", "sourceRefs": [], "conditions": ["C-.."], "residual": { "obligations": [{ "statement": "" }], "none": "" } }] }
```

- 상황·배경 문장도 요구에 영향을 주면 조건이다. 회의 기록의 결정·변경도 조건이다.
- 범위 밖으로 빼는 것은 그 근거 조건과 남는 의무를 쓴다.
</output_contract>

<rules>
- 원본을 수정하지 않는다. 쓰는 파일은 `stages/scope.json` 뿐이다.
- 최종 응답은 `{"status":"done","message":"<한 줄>","missingInputs":[]}`. 판단에 꼭 필요한 자료가 없으면 `{"status":"blocked","message":"<이유>","missingInputs":["<무엇이 왜 필요한지>"]}` 로 멈춘다.
</rules>
