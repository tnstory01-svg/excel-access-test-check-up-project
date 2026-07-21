# G001 공개 provenance 및 게시 결정

## 목적과 범위

이 문서는 `IMPLEMENTATION_PLAN.md`의 Sequencing 1을 위한 공개 provenance/ADR 기록이다. 제품 기능, Gate 0 검증, 테스트, 패키징 또는 릴리스를 수행했다는 뜻이 아니다. 원본 `.gjc` artifact와 그 내부 검토 기록은 비공개이며 이 문서에 복사하거나 게시하지 않는다.

## 결정

- 저장소 공개 범위는 `PUBLIC`이고 기본 및 게시 대상 브랜치는 `main`이다.
- 게시 방식은 보호 규칙을 우회하지 않는 direct source/docs push이다.
- 저장소에는 **LICENSE를 추가하지 않는다(NO LICENSE)**. 저작권은 보유하며 재사용 허락을 제공하지 않는다.
- 공개 `main`에는 source, docs, 합성 fixture/oracle/manifest, lockfile, workflow YAML, legal metadata 및 planning provenance만 게시한다.
- `.gjc/**`, LocalAppData 데이터, DB/log/tmp/token, 테스트 보고서·미디어·workflow evidence·로컬 VM 산출물, 제품 binary, portable ZIP, runtime, JAR/JRE/Node 및 helper/launcher binary는 Git 추적, push, GitHub Release 게시 대상이 아니다.
- Gate 0C/0D 검증용 ZIP/runtime artifact는 ignored temporary storage에서만 생성할 수 있으며 Git 추적, push 또는 GitHub Release 게시은 금지한다.

## ADR — source-only 공개 경계

### 배경

승인된 계획은 제품 구현 이전에 공개 저장소의 provenance와 배포 경계를 먼저 고정하도록 요구한다. 검증 산출물에는 사용자 데이터, 토큰, 로컬 실행 환경 또는 재배포 대상 runtime이 포함될 수 있으므로 source-only 공개와 분리해야 한다.

### 선택

`.gitignore`로 금지 산출물의 생성·추적 실수를 줄이고, 향후 CI가 계획의 source allowlist 밖의 tracked path를 거부하도록 한다. 현재 저장소에는 실행 스크립트, 패키지 매니페스트 또는 CI 관례가 없으므로 추측성 allowlist 검사기를 추가하지 않았다.

### 결과

이 결정은 Git ignore 규칙만으로 공개 적합성을 증명하지 않으며, 이미 추적된 파일이나 push 권한을 통제하지도 않는다. allowlist CI 검증과 Gate 0C/0D receipt는 각각 승인된 후속 단계에서 구현·실행해야 한다.

## 공개 계보

- 원본 artifact SHA-256: `3853a0c4cbdc75036d8d36e36c8435ea03c658e1b8b0b3ea92b53355200594ec`
- revision SHA-256: r2 `c8c356847210c76b5a32d2a327b6db8fa3c23f022f0be203e8ca1bcf483e6ca7`; r3 `02d7b4871ba55060d56f05ffa7824746e9b3b3ba1259905872e5db29fc907dcd`; r4 `a324f42e68db296737af96fd9b9fe68ff31014cc8de8c3e99dfd7b21c9c9df5b`; r5 `57563f2f923bfa7a2542d1489cf30210c006d1dd2326ccff04cb38ebde2ba17b`
- final architect pass5 SHA-256: `9d89251c003c9cdf71f972ef10ac6a7c1ef042590ae95d8f0f74463699a5f2a5`
- final critic pass5 SHA-256: `903f22e9484254fdd0402829bd3850a7d5a130f27e890df571a4049a0293aa3b`

위 hash는 공개 문서의 provenance 표기이며, 비공개 원본 artifact 또는 내부 검토 기록을 공개적으로 검증할 수 있다는 주장이 아니다.
