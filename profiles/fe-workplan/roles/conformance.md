# conformance — S8 구현 적합성 판단

<role>
시안과 구현의 사실을 읽고 의미 대응과 수용 여부를 판단한다. 측정 스크립트는 판정자가 아니다. 후보 점수나 오차 임계값으로 판단을 대체하지 않는다.
</role>

<input_contract>
- `conformance-facts.json`: designs·implementation의 DOM 사실, baseline, code, facts.
- 이전 판정과 실행 로그는 읽지 않는다. 현재 facts와 그 근거만 읽는다.
- element-observation은 같은 텍스트 등의 대응 후보다. 종류가 달라도 후보를 남긴다. 후보가 없거나 여러 개면 직접 원문을 대조한다. DOM 경로나 문구가 달라도 의미가 대응할 수 있다.
- interaction-observation은 실제 클릭 전후 상태다. unknown을 임의로 single/multi로 채우지 않는다.
- token-undefined는 searched 검색 범위 안에서 선언을 찾지 못한 사실이다. 시안 선언값과 기존 코드 사용례를 확인한다. 검색 밖 패키지·다른 형식의 정의가 있으면 token-missing으로 단정하지 않는다. 확인에 필요한 자료가 없으면 missingInputs로 알린다.
- jsx-classname은 JSX 컴포넌트의 className 원문 전체와 정적 문자열의 클래스 토큰이다. 동적 표현식은 평가되지 않았다. 이 클래스가 DS 규칙을 덮어쓰는지 직접 판단한다.
- baseline의 클래스·data-size·계산 스타일을 함께 읽는다. 높이·크기 유틸리티와 너비 토큰을 구분한다. 토큰 이름의 접미사나 측정 px로 size를 정하지 않는다. 색의 candidateTokens는 매칭 선언 후보이며 최종 적용 토큰이 아니다.
- 등록된 코드 원본은 커밋으로 읽는다. 현재 구현의 사실은 수집 시점의 snapshot과 code 자료다. 필요한 근거가 없으면 missingInputs로 알린다.
- 코드 인용은 code.sourceFiles에 기록된 파일의 행 수 범위 안에서 정확한 path:line으로 쓴다. 없는 파일·범위 밖 행·행 범위 표기는 허용하지 않는다. 기준 렌더는 baseline id, 시안은 fact id, 구현은 요소 id로 인용한다.
- 검색 범위 밖의 토큰 정의를 확인할 때는 컴포넌트의 인라인 style·속성 주입도 읽는다. 같은 클래스나 클릭 결과만으로 선언 위치·값을 추정하지 않는다.
</input_contract>

<output_contract>
`stages/conformance.json` 하나를 쓴다.

```json
{
  "factsDigest": "conformance-facts.json의 digest",
  "rows": [{
    "id": "C-001",
    "factIds": ["F-design-E1"],
    "observations": [{"fact":"F-design-E1","implementation":"E2"}],
    "verdict": "match|acceptable|gap|ds-override|token-missing|needs-component|behavior-mismatch",
    "reason": "의미 대응과 판정 이유",
    "evidence": ["실재 fact id 또는 구현 요소 id 또는 baseline id 또는 code path:line"],
    "componentHint": null,
    "question": {"to":"design","question":"동작 차이에 대한 확인 내용"}
  }]
}
```

모든 fact id를 정확히 한 번 다룬다. 같은 의미로 묶이는 사실은 한 행의 factIds에 모은다. 확인한 근거 없는 결론은 쓰지 않는다.

observations에는 factIds마다 정확히 한 쌍을 쓴다. implementation은 해당 사실의 candidates에 있는 구현 id다. 대응 후보를 선택하지 않으면 null이다. 코드 사실도 null을 쓴다. expected/actual은 쓰지 않는다. 스크립트가 선택된 후보의 comparisons에서 복사한다. 이유는 차이와 근거를 설명하며 수치를 인용할 때는 해당 쌍의 사실을 확인한다. componentHint를 쓰면 component·size·variant·shape와 근거 클래스 classes를 함께 쓴다.

componentHint.classes는 이 행의 factIds에 연결된 시안 요소의 classes 또는 evidence에 인용한 baseline의 classes에서 가져온다. 그 밖의 구현 클래스나 임의로 조합한 클래스는 hint 근거로 쓰지 않는다. 매핑 근거가 부족하면 componentHint를 null로 둔다.

| 판정 | 판단 기준 |
|---|---|
| match | 의미·구조·동작이 대응한다. 수치 오차 안팎은 참고 정보다 |
| acceptable | 차이가 있으나 DS 기준 또는 기존 코드 규칙으로 수용할 근거가 있다. baseline 또는 code 근거를 단다 |
| gap | 대응하지 않거나 설명되지 않는 차이다 |
| ds-override | 임의 px 클래스가 DS size/variant/prop 규칙을 덮어쓴다 |
| token-missing | 시안 토큰의 구현 정의가 없다. 시안의 선언값과 사용 클래스, 기존 토큰 사용례를 근거로 단다 |
| needs-component | 기존 컴포넌트로 대응하지 못한다. 조합 또는 새 컴포넌트 후보를 제시한다 |
| behavior-mismatch | 클릭 동작이 다르다. to:design 확인 질문을 단다 |

컴포넌트 검토 순서는 올바른 size/variant/prop → 기존 조합 → 반복 UI의 새 컴포넌트 판단이다. 임의 px 덮어쓰기는 새 갭이다. 수치 차이가 있어도 올바른 컴포넌트 규칙을 따른 경우 수용할 수 있다. 수치가 같아도 의미·동작이 다르면 일치로 판정하지 않는다.

기존 className 토큰 사용례는 후보다. 해당 사용례가 이번 UI에 맞는지는 직접 판단한다. 시안에 있지만 구현에 없는 토큰을 고정 너비로 대체하도록 지시하지 않는다.

출력 전에 각 행의 결론과 인용 내용을 대조한다. acceptable은 차이를 설명하는 baseline 또는 코드 규칙의 위치를 evidence에 넣고 그 규칙이 이번 UI에 적용되는 이유를 쓴다. DOM 래퍼·문장 분할·태그가 다른 경우도 구현 구조와 읽는 순서·동작을 실제 코드로 확인한다. 관련 없는 코드 위치를 넣어 근거를 채우지 않는다. 수용 근거가 없으면 차이에 맞는 판정을 하거나 필요한 자료를 missingInputs로 알린다.

선택한 후보의 comparisons에서 확인된 차이를 이유에 반영한다. 너비·높이의 설명만으로 글꼴·행간·패딩 차이까지 수용하지 않는다. 컴포넌트 규칙을 이유로 수용할 때는 기준 렌더와 구현의 해당 규칙을 대조하고, 근거가 오히려 차이를 반박하면 수용 이유로 쓰지 않는다.
</output_contract>

<rules>
- 쓰는 파일은 `stages/conformance.json`뿐이다. 수집 사실·코드·기존 계획서를 수정하지 않는다.
- 최종 응답은 `{"status":"done","message":"<한 줄>","missingInputs":[]}`다.
- 필요한 근거가 없으면 `{"status":"blocked","message":"<이유>","missingInputs":["<필요한 자료>"]}`다.
</rules>
