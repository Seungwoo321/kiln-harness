# 렌더 증거와 구현 적합성

S2d는 시안의 렌더 사실을 수집한다. S4는 출처별 정책으로 사실을 해석한다. S5는 해석의 형식과 근거 연결을 검사한다. S8은 구현 사실을 수집한 뒤 별도 LLM 세션에서 적합성을 판정한다.

## 스크립트와 판단의 경계

| 스크립트가 수집·계산하는 사실 | LLM 또는 사람이 판단하는 사항 |
|---|---|
| DOM·텍스트 순서·상대 좌표·크기·계산 스타일 | 시안 요소와 구현 요소의 의미 대응 |
| 클래스 원문·크기 유틸리티·참조 토큰·선언값 | 클래스 근거에 따른 componentHint의 size·variant·shape |
| DS 페이지의 클래스·마크업·실측 규격 | 기존 컴포넌트의 적합성·조합·신규 컴포넌트 필요성 |
| 클릭 전후 상태·single/multi 관찰값 | 관찰 동작과 자연어 요구사항의 충돌 여부 |
| 검색 범위 안의 토큰 선언 존재 여부·JSX className 원문 전체 | 토큰 누락·클래스 덮어쓰기 여부와 수정 방안 |
| 같은 종류 UI의 git grep 사용례 | existing-pattern의 적합성·프로토타입 관찰 분류 |
| 수치 차이·설정된 오차 안팎 | match·acceptable·gap 등 최종 판정 |
| id 실재·digest·필수 필드·증거 커버리지 | 문장 명확성·정책의 의미·수용 여부 |

후보에는 순위나 자동 선택 결과를 붙이지 않는다. 계산할 수 없는 의미를 정규식·점수표·픽셀 임계값으로 대신 판단하지 않는다.

## S2d: 사실 수집

Node 내장 WebSocket으로 Chrome DevTools Protocol을 호출한다. 의존성은 추가하지 않는다. Chrome은 KH_CHROME, 운영체제 기본 설치 위치, PATH 순으로 찾는다. Chrome 부재는 skipped다. 렌더·자산 로드 실패는 오류다.

파일은 자산 루트의 루프백 정적 서버로 제공한다. 서버는 경로와 심볼릭 링크의 루트 이탈을 막는다. 코드 입력의 자산은 등록 커밋에서 git show로 읽는다. 작업 트리나 저장소 전체 복사본을 만들지 않는다. 화면에 보이는 이미지와 폰트가 준비되면 측정한다. 숨겨진 lazy 이미지의 decode를 기다리지 않는다.

뷰포트 1440×1000, 배율 1, 로케일, 테마, Chrome 버전, 추출기 코드, 로드한 자산 digest가 렌더 입력이다. 포트·시각·임시 경로는 증거에 넣지 않는다. 기준 페이지 캐시는 입력과 자산이 같을 때만 재사용한다. 동적 서버나 외부 자산이 바뀌면 다른 입력이다.

`design-spec/<sourceId>.json`은 schemaVersion:1, kind:DesignSpec, sourceId, inputDigest, render, elements, interactions, digest를 가진다.

- elements는 id·locator·텍스트·순서·종류·기준 요소·상대 rect·텍스트 rect·필드 속성·계산 스타일을 가진다.
- classes는 DOM 클래스 원문이다. utilities는 크기·간격 유틸리티 원문이다.
- tokens는 참조 토큰 이름·계산값·시안 CSS의 선언값이다. 색의 candidateTokens는 매칭된 모든 선언을 순서대로 보존한다. CSS 명시도·중요도에 따른 최종 토큰이라고 단정하지 않는다.
- componentHint는 수집 단계에서 null이다. LLM은 클래스 근거로 매핑을 판단한다. 판단은 별도 산출물에 남겨 원본 사실의 digest를 유지한다.
- interactions는 항목·초기 상태·클릭 후 상태·openPolicy:single|multi|unknown·reclick:close|stay|unknown을 가진다. 알 수 없는 동작은 unknown이다.

반복 위젯은 details, ARIA, trigger/toggle 속성으로 탐색한다. 링크·제출 버튼은 클릭하지 않는다. 지원 범위 밖 위젯은 관찰하지 못한 것으로 남긴다.

`component-baseline.json`은 시안이 참조하는 DS 컴포넌트 페이지의 클래스·마크업·규격을 캐시한다. 명시된 data-size 등의 속성은 사실이다. 관찰한 높이만으로 size를 만들지 않는다.

`existing-patterns.json`은 implementation 입력의 고정 커밋에서 찾은 사용례다. 후보는 sourceId·path:line·검색어·코드 조각을 가진다. 비슷해 보인다는 이유로 자동 채택하지 않는다.

## S4와 S5: 계획서

| 출처·분류 | LLM이 결정하는 반영 방식 |
|---|---|
| plan / adopt | 정책·규칙·데이터 의미를 원본 근거로 채택한다 |
| plan / existing-pattern | 실재하는 구현 코드 근거를 달고 기존 UI 패턴을 따른다 |
| plan / omission-suspect | 기존 패턴의 누락 의심을 기획 질문으로 남긴다 |
| plan / prototype-artifact | 임의 구현·미구현·데모 동작은 요구사항에서 제외한다 |
| design | 구조·동작·문구를 엄격히 따른다. 컴포넌트 규칙은 px보다 우선한다 |

시안 동작 > 기획 HTML > 기획 문서다. 정책·규칙은 기획 문서가 정본이다. LLM은 size/variant/prop → 기존 조합 → 반복 UI의 새 컴포넌트 판단 순서로 검토한다. 임의 px 덮어쓰기는 수정 후보로 올린다.

높이·크기 유틸리티와 너비 토큰을 구분한다. 토큰 이름의 접미사나 측정 px로 size를 정하지 않는다. componentHint는 component·size·variant·shape와 근거 클래스를 가진다.

계획서 v3의 designSpecs는 증거 id·요구사항·컴포넌트·componentHint·strict|component-rule|htmlLimit 판정·이유를 연결한다. htmlLimit도 LLM이 기준 증거를 대조해 판단한다. 상호작용의 자연어 의미는 LLM이 읽는다. S5는 명시된 openPolicy와 관찰값의 불일치만 계산한다. 충돌이 해소되지 않으면 LLM이 to:design 질문을 쓰고 요구사항을 resolution:pending으로 둔다. 스크립트는 질문 내용을 생성하지 않는다.

S5는 출처 분류의 존재와 실재 근거를 검사한다. 분류의 적합성은 독립 critic이 검토한다. v1·v2는 기존 계약을 유지한다. 렌더 증거가 없으면 추가 정책 게이트는 skipped다.

## S8: 사실과 판정

`node scripts/verify.mjs <case|--root dir> --url <http(s) URL> --code <기능 폴더> [--theme dark|light] [--source id]`로 실행한다. 여러 시안은 source로 화면에 대응시킨다.

1. 같은 추출기로 구현 화면의 사실을 수집한다.
2. 시안 요소별로 텍스트 등이 같은 구현 후보와 수치 차이를 제시한다. 종류 차이는 비교 항목이며 후보를 제거하지 않는다. 기준 렌더 후보는 같은 태그와 공유 클래스 수를 제공하며 파일명으로 대응을 정하지 않는다.
3. JSX의 className 원문·정적 문자열의 모든 클래스 토큰과 CSS 토큰 선언을 수집한다. 동적 표현식은 원문으로 남기며 평가하지 않는다. 토큰 검색 범위는 searched:{root,extensions,excluded}로 기록한다. 검색 범위는 코드 레포의 추적·비무시 CSS이며 패키지·다른 확장자의 선언을 포함하지 않는다.
4. conformance-facts.json에 사실·후보·digest를 기록한다.
5. scripts/run.mjs가 roles/conformance.md를 별도 claude 또는 codex 세션으로 실행한다.
6. 형식 게이트는 모든 사실에 판정과 실재 근거가 있는지 검사한다. 위반은 다음 시도에 주입한다.
7. 검증된 판정을 conformance.json·review.html·conformance-brief.md로 렌더한다.

code.sourceFiles는 수집한 JS·TS·JSX·TSX·CSS 파일의 경로·digest·행 수를 가진다. 코드 인용은 이 파일의 범위 안에 있는 path:line을 쓴다. 특정 JSX 시작 줄 외에도 컴포넌트 규칙과 레이아웃 선언 줄을 인용할 수 있다. 게이트는 위치의 실재만 검사하며 인용 내용의 적합성은 LLM이 판단한다.

역할은 각 차이와 인용한 규칙의 적용 이유를 대조한다. DOM 분할 차이도 실제 코드의 구조·읽는 순서·동작으로 확인한다. 크기 차이의 설명으로 행간 등 다른 스타일 차이를 수용하지 않는다. CSS 검색 밖의 토큰은 인라인 스타일 등 실제 주입 위치를 확인하며, 필요한 근거가 없으면 자료 보강을 요청한다.

위치·크기 ±1px, 간격 ±2px는 기본 비교 정보다. size 오차는 너비·높이와 간격 이외의 수치 스타일(font-size·line-height·border-radius 등)에 적용한다. kh.config.json에서 바꾼다. 오차 안팎을 사실로 제공하며 그 값으로 의미상 수용을 확정하지 않는다.

| LLM 판정 | 뜻 |
|---|---|
| match | 의미와 동작이 대응하며 관찰 차이가 없음 |
| acceptable | 차이가 있으나 컴포넌트 규칙 등 확인된 근거로 수용함 |
| gap | 설명되지 않는 차이. 수정 필요 |
| ds-override | 임의 px 클래스가 컴포넌트 규칙을 덮어씀 |
| token-missing | 시안의 참조 토큰이 구현 CSS에 정의되지 않음 |
| needs-component | 기존 컴포넌트 매핑이 없어 조합·신규 판단 필요 |
| behavior-mismatch | 상호작용 규칙이 다름. 디자인 확인 필요 |

모든 판정은 factIds·이유·근거와 observations:[{fact,implementation}]을 가진다. implementation은 해당 사실의 후보 id이며 대응 후보가 없으면 null이다. 스크립트는 expected/actual을 선택된 후보의 comparisons에서 채운다. 후보를 선택하지 않은 행은 시안 원문 사실과 구현 대응 부재를 보존한다. 코드 사실은 수집된 expected/actual을 사용한다. LLM이 쓴 수치 필드는 보고서에 사용하지 않는다. 구현 요소 id도 근거로 인용한다. acceptable은 기준 또는 코드 근거를 가진다. 판정의 타당성과 이유의 서술은 LLM·사람이 검토한다. 판단 결과가 없으면 needs-judgment이며 통과가 아니다.

gap·ds-override·token-missing·behavior-mismatch 판정이 있으면 종료 코드 1이다. needs-component는 경고다. 도구·형식 오류는 2다. 자료 보강이나 판단이 필요하면 3이다. Chrome·시안 증거 부재는 skipped와 이유를 기록하고 종료 코드 3을 반환한다. skipped는 이전 증거를 삭제하지 않는다. 이전 유효 증거가 있으면 계획서 검증은 그 증거를 사용한다.

구현 URL은 부수효과 없는 화면이어야 한다. verify는 상태 탐색을 위해 화면의 동작을 실행한다. 중단 신호·프로세스 종료는 해당 Chrome과 임시 렌더 폴더를 정리한다.

구현 지시서 머리말에는 컴포넌트 우선 원칙과 판단 순서를 적는다. 같은 종류 컴포넌트의 토큰 className 사용례를 후보로 제공한다.

## 작성과 근거

CDP 계약은 [Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/)와 [Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/)을 따른다. 직접 CDP를 사용해 의존성을 늘리지 않는다. 클래스·토큰·코드 탐색은 후보를 제공하고 의미 판단은 별도 세션에 둔다.
