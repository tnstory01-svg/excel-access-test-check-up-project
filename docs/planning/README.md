# 구현 계획 프레임워크

이 디렉터리는 로컬 Excel·Access 실기 채점기의 **합의 계획, G001 공개 게시 기반, 문서 전용 GitHub 게시가 승인된 기록**을 저장소에서 읽을 수 있게 정리한 문서입니다. G001은 provenance와 source-only 게시 경계의 기반만 기록합니다. 승인된 계획에 따른 제품 구현 실행은 현재 진행 중이지만, G001만으로 이후 기능·테스트·패키징 게이트가 완료되었다고 주장하지 않습니다.

- 상세 설계·게이트·수용 기준: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
- 프로젝트 소개: [루트 README](../../README.md)
- G001 provenance 및 PUBLIC `main` 게시 결정: [provenance.md](provenance.md)

## 문서 출처와 무결성

- 현재 상태: 합의 계획과 이 문서 전용 GitHub 게시는 승인되었고, 승인된 계획에 따른 제품 구현 실행은 진행 중임. G001은 공개 게시 기반만 수립하며 이후 제품 기능·테스트·패키징 게이트의 완료를 뜻하지 않음.
- `IMPLEMENTATION_PLAN.md`에 포함된 제목/본문의 `승인 대기`는 불변 원본 artifact가 생성될 당시의 상태 표기이며, 현재 문서 게시 승인 상태를 뜻하지 않는다.
- 원본 역할/단계: `planner` / `ralplan final approval`; 원본 artifact SHA-256: `3853a0c4cbdc75036d8d36e36c8435ea03c658e1b8b0b3ea92b53355200594ec`
- Deep Interview 명세 SHA-256: `55bab2a8d12ac87026b3a99b0cb5f66689cd0937e84f9a9646c33f1b3367d3d2`; planner stage 1 SHA-256: `807dc1c77f0e6dbb20f69931584a5e7acb9a8c97e6894b1b4278da53d2c959c4`
- revision SHA-256: r2 `c8c356847210c76b5a32d2a327b6db8fa3c23f022f0be203e8ca1bcf483e6ca7`; r3 `02d7b4871ba55060d56f05ffa7824746e9b3b3ba1259905872e5db29fc907dcd`; r4 `a324f42e68db296737af96fd9b9fe68ff31014cc8de8c3e99dfd7b21c9c9df5b`; r5 `57563f2f923bfa7a2542d1489cf30210c006d1dd2326ccff04cb38ebde2ba17b`
- final architect pass5 SHA-256: `9d89251c003c9cdf71f972ef10ac6a7c1ef042590ae95d8f0f74463699a5f2a5` — WATCH/REQUEST CHANGES는 stale ZIP 문구만을 이유로 했고 최종 artifact에서 정정됨.
- final critic pass5 SHA-256: `903f22e9484254fdd0402829bd3850a7d5a130f27e890df571a4049a0293aa3b` — OKAY. 위 최종 SHA들은 정정된 승인 artifact의 계보다.
- 위 hash와 계보는 공개 문서의 provenance 표기이며, 원본 `.gjc` private artifact 또는 그 내부 검토 기록이 공개적으로 검증 가능하다는 주장이 아니다.

## 공개 및 추적 정책

저장소는 `PUBLIC`, 기본/대상 브랜치는 `main`, 게시 방식은 direct source/docs push이다. **NO LICENSE** 정책으로 저작권을 보유하며 재사용 허락을 제공하지 않는다.

공개 `main`에는 source, docs, 합성 fixture/oracle/manifest, lockfile, workflow YAML, legal metadata만 허용한다. `.gjc/**`, LocalAppData 데이터, DB/log/tmp/token, 테스트 보고서·미디어·workflow evidence·로컬 VM 산출물, 제품 binary/portable ZIP/runtime/JAR/JRE/Node/helper/launcher binary는 추적·push·GitHub Release 게시 대상이 아니다. Gate 0C/0D 검증용 ZIP/runtime artifact는 ignored 임시 저장소에서만 생성할 수 있으며 Git 추적·push·Release 게시해서는 안 된다.
