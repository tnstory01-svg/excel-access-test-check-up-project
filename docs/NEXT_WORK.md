# 다음 작업 인계

## 완료된 커밋

- `c6d3628` — fail-closed Office Inspector 기반을 추가했다.
- `eb971a0` — localhost 서버 보안 경계를 적용했다.
- `32a4fcc` — 결정론적 채점 워크플로를 구현했다.

## 남은 작업

- **G005/G001:** Office Inspector 검토 상태를 해소한다.
- **G006/G002:** 서버 검토 상태를 해소한다.
- **G003 차단 항목:** 비교와 비식별화를 분리하고, 8 MiB 누적 증거 예산, 안정적인 reason code, 전체 wire 검증, 인증된 서버 upload/draft/grade 라우트와 영속성, fixture로 입증한 support-matrix gating, 실제 subset 선택, 고정된 정적 typecheck, 소수점 둘째 자리 퍼센트, export/e2e를 완료한다.
- **G004:** source-only CI, Gate 0C, 문서화 및 최종 검증을 완료한다.

## 재개 절차

1. `gjc ultragoal status --json`으로 현재 상태를 확인한다.
2. 완료된 source 또는 docs 단위마다 각각 커밋하고 push한다.
3. QA 보고서, 바이너리, 런타임 산출물은 절대 추적하지 않는다.
