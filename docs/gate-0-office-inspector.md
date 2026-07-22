# ADR: Gate 0A/0B Office Inspector 기반

- 상태: 기반 완료, 최종 승인 보류
- 범위: Excel Gate 0A, Access Gate 0B

## 결정

Java 21 도구체인에서 Apache POI 5.4.0으로 Excel의 저장된 수식과 스타일 증거를 추출하고, Jackcess 4.0.8로 Access 카탈로그를 **실행 없이** 관찰한다. Access query는 보수적 closure classifier가 닫힌 정적 `SELECT`/`UNION` 의존성만 후보로 분류한다. UCanAccess 5.1.3은 잠긴 의존성의 후보일 뿐 아직 실행하지 않는다.

현재 IPC는 프로토콜 v1 JSONL만 허용한다. 프레임은 1 MiB, 세션 누계는 16 MiB, 증거 예산은 8 MiB 이하이며, capability ID는 최대 256개, `maxChecks`/`maxRows`는 각각 최대 1,000,000이다. 미구현 capability는 명시적으로 `unsupported` (`CAPABILITY_UNSUPPORTED`)를 반환한다.

## 근거

- POI 5.4.0 (`poi`, `poi-ooxml`) 기반 Excel extractor와 formula canonicalizer가 저장 수식 및 number format, font, fill, border, alignment 스타일 증거 경로를 갖는다.
- Jackcess 4.0.8 catalog observer는 테이블, 필드, PK, 인덱스와 query 정의를 정렬해 읽으며 JDBC 연결이나 query 실행을 하지 않는다.
- closure classifier는 NFC + invariant-case-fold 식별자 충돌, 순환/미해결/외부·linked 참조, pass-through, parameter, UDF·비승인 함수, volatile 함수, `TRANSFORM`, `SELECT INTO`를 거부한다. query-result 후보에는 비어 있지 않고 non-null·unique인 명시 `orderBy`가 필요하다.
- `gradle.lockfile`은 POI 5.4.0, Jackcess 4.0.8, UCanAccess 5.1.3 및 전이 의존성을 해석된 버전으로 잠근다.
- Gradle compile은 성공했다. 로컬 Gradle test worker는 `ClassNotFoundException` 제한이 있었으나, 집중 direct JUnit 실행은 통과했다.

## 한계와 비지원

이는 capability 지원 또는 production-ready 선언이 아니다. 현재 `Main`은 검증된 요청에도 `unsupported`만 응답하며 Excel/Access 추출 결과를 IPC로 제공하지 않는다. UCanAccess query 실행, query-result parity, 독립 oracle fixture 비교 및 형식쌍 검증은 아직 수행되지 않았다. 따라서 자동 fallback, query 실행, 결과 비교를 지원한다고 주장하지 않는다.

## 다음 게이트 기준

Gate 0A/0B는 기반 구현 기준으로 완료되었지만, 최종 독립 fixture/parity 승인은 보류다. 승인 전에는 capability×format의 positive/boundary/negative 독립 fixture와 oracle로 POI formula/style 증거를 비교하고, Access catalog/closure 및 허용 query-result의 parity를 검증해야 한다. UCanAccess는 classifier 승인 immutable `queryId`만 private scratch의 server-fixed read-only 경로에서 별도로 실행·검증한 뒤에만 재평가한다. Gradle test-worker `ClassNotFoundException`도 재현·원인 해결 또는 신뢰 가능한 CI 대체 증거가 필요하다.
