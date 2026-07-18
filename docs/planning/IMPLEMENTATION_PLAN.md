> 공개 provenance: 합의 계획과 이 문서 전용 GitHub 게시는 승인되었다. 제품 구현·테스트·패키징은 미승인·미수행이다. 아래 제목/본문의 `승인 대기`는 불변 원본 artifact 생성 당시의 상태이며 현재 문서 게시 승인 상태가 아니다.
>
> 불변 계보: 원본 artifact SHA-256 `3853a0c4cbdc75036d8d36e36c8435ea03c658e1b8b0b3ea92b53355200594ec`; r2 `c8c356847210c76b5a32d2a327b6db8fa3c23f022f0be203e8ca1bcf483e6ca7`; r3 `02d7b4871ba55060d56f05ffa7824746e9b3b3ba1259905872e5db29fc907dcd`; r4 `a324f42e68db296737af96fd9b9fe68ff31014cc8de8c3e99dfd7b21c9c9df5b`; r5 `57563f2f923bfa7a2542d1489cf30210c006d1dd2326ccff04cb38ebde2ba17b`.
> final architect pass5 SHA-256 `9d89251c003c9cdf71f972ef10ac6a7c1ef042590ae95d8f0f74463699a5f2a5`: stale ZIP 문구만으로 WATCH/REQUEST CHANGES였으며 최종 artifact에서 정정되었다. final critic pass5 SHA-256 `903f22e9484254fdd0402829bd3850a7d5a130f27e890df571a4049a0293aa3b`: OKAY. 위 final SHA들은 정정된 승인 artifact의 계보다.
>
# RALPLAN 최종 계획 — 로컬 Excel·Access 실기 채점기 (승인 대기)

## 요약
제품 베이스라인은 `README.md` 한 파일뿐인 greenfield다. 원 명세는 `.gjc/_session-019f738b-9143-7000-86d7-fb22405e7122/specs/deep-interview-excel-access-local-grader.md`이며, Windows 단일 사용자가 Office 설치·특정 버전·COM·ADO·Access Database Engine·외부 서버 없이 `127.0.0.1` localhost UI에서 `.xlsx`, `.xlsm`, `.xls`, `.accdb`, `.mdb`를 채점한다.

이 계획은 planner stage 1 SHA `807dc1c77f0e6dbb20f69931584a5e7acb9a8c97e6894b1b4278da53d2c959c4`, revisions 2–5 및 합의 검토를 보존한 최종 승인 기준이다. 이 문서는 제품 구현·테스트·커밋·push를 실행하지 않는다.

## Intent Reconciliation
- 정답 파일에서 기준을 자동 추출하고 사용자가 검사 요소·배점·활성 상태를 수정·저장한다. 전체와 지정 문제 채점을 모두 제공하며 총점/문제별 점수/위치/이유 또는 불완전 사유를 localhost에 표시한다.
- Excel은 저장 값·수식·fixture로 증명된 서식을 선택 검사한다. Access는 신뢰성 있게 분석 가능한 구조·속성과 엄격하게 제한된 저장 읽기 query 결과만 검사한다.
- 원본 정답/제출 바이트는 SHA-256으로 식별해 변경하지 않는다. 제품 데이터는 LocalAppData에만 보관하며 외부 전송, 클라우드, 원격 접속, 다중 사용자, 인증은 제공하지 않는다.
- 암호화/손상 파일 복구, 다섯 형식 외 지원, Access 폼/보고서/매크로/VBA/이벤트/액션 query 완전 재현, `.xlsm` macro/ActiveX 실행, Excel 외부 연결/재계산/피벗·차트 시각 결과는 제외한다.
- 원격은 `https://github.com/tnstory01-svg/excel-access-test-check-up-project`, 저장소는 **PUBLIC**, default/대상 branch는 **`main`**, 게시 방식은 **direct source/docs push**다. 프로젝트는 **NO LICENSE**이며 저작권을 보유하고 재사용 허락을 제공하지 않는다. source/docs/합성 fixture/legal metadata만 public `main`에 게시한다.
- **정정된 binary 정책:** CI 또는 로컬 검증용 ZIP·runtime artifact는 Gate 0C/0D만을 위해 ignored temporary storage에서 **생성할 수 있다(MAY)**. 그러나 이는 **절대 Git 추적, push 또는 GitHub Release 게시해서는 안 된다(MUST NEVER)**. 제품 binary, portable ZIP, runtime은 source-only publication 대상이 아니다.

## RALPLAN-DR 원칙
1. **Office·네트워크 비의존:** Office 자동화와 loopback 밖 수신/전송을 금지한다.
2. **fixture 우선:** format signature×형식쌍×capability×parser/normalizer version의 독립 oracle fixture가 통과한 기능만 `supported`다.
3. **불변 artifact와 최소 권한:** worker에는 원본 경로/이름/임의 SQL이 아닌 opaque handle만 준다.
4. **점수·범위·판정 분리:** subset을 전체 성적으로 보이지 않고 unsupported/error를 fail 또는 비례 재산정으로 위장하지 않는다.
5. **배포 검증:** runtime, legal, checksum, launcher, LocalAppData, offline clean-VM 증거도 수용 조건이다.

## ADR — 핵심 아키텍처 결정
### Decision
Node localhost UI/API·SQLite·정책 계층, Java `office-inspector`(Apache POI HSSF/XSSF, Jackcess metadata, 제한 UCanAccess), Rust `product-launcher`와 `win-job-launcher`, fixture-backed support matrix를 채택한다. production publication은 source-only이며 CI/local temporary validation binary는 Gate 0C/0D에서만 허용한다.

### Drivers
1. Office 비의존 다섯 형식 분석 정확성.
2. 원본 불변, 악성 파일/query/process/localhost 공격면 통제.
3. Windows 10/11 x64에서 외부 runtime 없는 오프라인 재현성.

### Alternatives considered
| 대안 | 판단 |
|---|---|
| Node UI/API + Java inspector + POI/Jackcess/제한 UCanAccess | **조건부 선택**; fixture와 배포 gate 통과 범위만 지원 |
| Node + SheetJS CE | rich style fidelity 근거 부족; 불채택 및 자동 fallback 금지 |
| Node + SheetJS Pro | POI gate 실패 시 법무/fixture 재승인 후보 |
| COM/ADO/Access Engine/LibreOffice 자동화 | Office/별도 제품 의존으로 제외 |

### Why chosen
POI는 HSSF/XSSF style API 후보를, Jackcess는 실행 없는 metadata 관찰을, UCanAccess는 제한된 query 결과 후보를 제공한다. Java runtime은 Excel과 Access를 같은 resource/IPC 경계에서 처리할 수 있다. Rust는 race-free suspended process→Job Object assignment와 product lifecycle을 제공한다. 이 선택은 기술 가능성을 가정하지 않고 Gate 0과 capability matrix로 증명한다.

### Consequences
두 런타임과 native helper 공급망, JSONL IPC, Java/Rust lockfile, binary checksum/SBOM/NOTICE, fixture oracle, Hyper-V 검증을 유지해야 한다. query-result와 style capability는 gate 실패 시 미지원이며 자동 축소/대체가 아니다. NO LICENSE 공개 저장소라도 의존성은 재배포 가능성과 legal artifact를 별도로 충족해야 한다.

### Follow-ups
Gate 0A/0B/0C/0D 결과를 ADR로 기록한다. POI fidelity, query closure/parity, native launcher/helper, runtime legal, score invariant 또는 clean-VM 실패는 해당 경로를 중단하고 architect/critic 재검토와 필요한 사용자 재승인을 받는다.

## Gate 0 — 선행 차단 조건
### 0A Excel fidelity
Apache POI HSSF/XSSF가 `.xlsx/.xlsm/.xls`에서 다음 capability를 independent oracle과 비교한다. style/theme ID 동일성만으로 합격하지 않는다. capability×format pair별 positive/boundary/negative fixture가 필수이고, 실패 capability는 명시 `unsupported`; 핵심 수용 기준 축소는 사용자 재승인 대상이다.

| capability ID | canonical evidence |
|---|---|
| `excel.cell.value.v1` | `{kind:'blank'|'string'|'boolean'|'error'|'number'|'date',value}` |
| `excel.cell.formula.stored.v1` | `{formulaCanonical,cachedValue?}` |
| `excel.style.number-format.v1` | `{formatCodeCanonical}` |
| `excel.style.font.v1` | `{name,sizePt,bold,italic,underline,strikeout,colorArgb}` |
| `excel.style.fill.v1` | `{patternType,foregroundColorArgb,backgroundColorArgb}` |
| `excel.style.border.v1` | `{top,right,bottom,left,diagonal:{style,colorArgb,up,down}}` |
| `excel.style.alignment.v1` | `{horizontal,vertical,wrapText,textRotation,indent,shrinkToFit}` |

Formula는 Java POI worker의 token-aware parser/normalizer만 처리한다. leading `=`와 token sequence를 보존하고 function identifier만 ASCII uppercase한다. 문자열/error/array literal, quoted sheet/workbook, A1/R1C1/external reference, defined name, structured reference와 escape는 lexical 의미를 보존한다. reference 사이 space는 `SPACE_INTERSECTION` token으로 보존한다. `=SUM(B7:D7 C6:C8)`, `=SUM(B7:D7,C6:C8)`, `=SUM(B7:D7C6:C8)`은 서로 다르다. 비의미 formatting whitespace만 제거한다. 애매하게 tokenize되는 formula는 `unsupported`이며 space 삭제로 강제하지 않는다. `formula-collision-v1`에는 intersection/union, structured reference, quoted sheet (`'Q1 Data'!A1`, `'O''Brien'!A1`), external/defined-name, literal embedded space, whitespace-removal collision을 넣는다.

Text는 NFC/`\n`, number는 finite decimal canonical text, date는 workbook 1900/1904 기준 ISO와 1900-02-29 sentinel, color는 uppercase opaque ARGB로 정규화한다. theme+tint는 gate된 resolver만 허용한다. default/null/inheritance는 명시 값이며 missing field와 다르다.

### 0B Access fidelity/safety
Jackcess는 catalog/`Query.Type` metadata만 읽고 query를 실행하지 않는다.

| ID | locator | evidence |
|---|---|---|
| `access.table.schema.v1` | `{objectType:'table',table}` | `{table,nameCanonical,fields}` |
| `access.field.property.v1` | `{objectType:'field',table,field}` | `{table,field,type,length,required,allowZeroLength,defaultValueCanonical}` |
| `access.primary-key.v1` | `{objectType:'primary-key',table}` | `{table,columns,nameCanonical?}` |
| `access.index.v1` | `{objectType:'index',table,index}` | `{table,index,unique,primary,columns}` |
| `access.relationship.v1` | `{objectType:'relationship',relationship}` | `{name,fromTable,toTable,columns,updateRule,deleteRule}` |
| `access.query.definition.v1` | `{objectType:'query',query}` | `{query,typeCanonical,sqlCanonical,dependencies,closureState}` |
| `access.query.result.v1` | `{objectType:'query-result',query,orderBy}` | `{query,columns:[{name,type}],rows:[[typeTag,value]]}` |

UCanAccess는 closure classifier가 승인한 immutable `queryId`만 private scratch에서 server-fixed JDBC template/read-only transaction으로 실행한다. 허용은 local non-linked table 또는 동등 허용 query로만 닫힌 static `SELECT`/`UNION` dependency graph다. action/DDL/`SELECT INTO`, pass-through, parameter, external/linked, unresolved reference, VBA/UDF, volatile function, cycle, `TRANSFORM`, NULL/duplicate/불명확 order key는 `unsupported`이며 실행하지 않는다. parity fixture 없는 query-result는 definition 비교만 지원한다.

Identifiers는 source spelling과 NFC+invariant-case-fold key를 같이 보관하며 collision/ambiguous selector는 unsupported다. SQL은 lexer token stream으로 comments/non-semantic whitespace 제거·keyword uppercase, literals/bracket identifiers 의미 보존한다. rows는 규칙의 non-null unique `orderBy`로 type-aware stable sort한다. `access-metadata-{accdb,mdb,cross}-v1`, `access-query-closure-{positive,negative}-v1`, `access-corrupt-encrypted-v1` fixture가 형식쌍/closure/probe 상태를 증명한다.

### 0C CI/temp portable packaging spike
최종 제품과 독립된 CI/temp-only unsigned portable ZIP로 bundle self-containment를 확인한다. `windows-2022` runner의 build tools 사전 설치는 기록하되 clean-machine 근거로 쓰지 않는다. sanitized `PATH`/`PATHEXT`/environment에서 `where node`, `where java`, `where pnpm`, `where gradle`가 실패하고 system runtime 경로 실행을 거부하는 denial probe 후 bundle internal absolute Node/JRE/launcher만 사용해 LocalAppData write, random-port bind, SBOM/NOTICE/checksum을 확인한다. manifest/SHA, `ImageOS`/`ImageVersion`, sanitized environment hash, denial/bind/process probe는 workflow artifact receipt로 보관한다. ZIP/runtime artifact는 ignored CI/local temporary storage에만 MAY 생성되며 MUST NEVER Git 추적, push 또는 GitHub Release 게시된다.

### 0D full-product offline clean-VM
0C와 별개로 user-local Hyper-V Generation 2 clean VM의 Windows 10 22H2 x64 및 Windows 11 24H2 x64에서 final candidate를 검증한다. Microsoft base image source, edition/language, ISO/VHDX SHA-256, VM config hash, staging harness SHA를 문서화한다. stage 후 NIC disconnect+egress firewall 차단 상태에서 Office/Node/Java/pnpm 미설치로 checksum→unzip→launcher→Excel/Access 최소 흐름→Host/non-loopback 거부→종료/재기동/LocalAppData→SBOM/NOTICE를 확인한다. 원시 logs/screenshots/ZIP/runtime artifact는 ignored local artifact에만 두며, CI에는 실행자, VM hash, bundle/harness hash, 결과/시각만 가진 비밀 없는 요약 receipt를 retention artifact로 보관한다. 이 validation artifact 역시 MUST NEVER Git 추적, push 또는 GitHub Release 게시된다.

## 구조와 제안 파일
```text
README.md package.json pnpm-workspace.yaml pnpm-lock.yaml .nvmrc .gitignore
rust-toolchain.toml
.gradle/wrapper/ tools/office-inspector/{build.gradle.kts,gradle.lockfile,gradlew*,gradle/verification-metadata.xml}
tools/product-launcher/{Cargo.toml,Cargo.lock,src/main.rs,README.md}
tools/win-job-launcher/{Cargo.toml,Cargo.lock,src/main.rs,README.md}
apps/server/src/{main.ts,app.ts,config.ts,artifact-registry.ts,job-coordinator.ts,launcher-auth.ts}
apps/server/src/security/{intake.ts,host-origin.ts,csrf.ts,limits.ts,worker-spawn.ts,job-object.ts}
apps/web/src/{main.tsx,api.ts,pages/,components/}
packages/domain/src/{rules.ts,results.ts,scoring.ts,capabilities.ts,ipc.ts,draft.ts,access-evidence.ts,errors.ts}
packages/grader/src/{extract.ts,grade.ts,score.ts,normalization.ts,problem-filter.ts}
packages/{adapters-excel,adapters-access}/src/
packages/support-matrix/{support-matrix.json,fixture-manifest.json,validate.ts}
tools/office-inspector/src/main/java/.../{Main.java,ExcelExtractor.java,JackcessCatalog.java,ClosureClassifier.java,UCanAccessQueryRunner.java,Protocol.java}
tests/{unit,integration,e2e,security,fixtures,oracles}/
docs/{architecture.md,support-matrix.md,security.md,operations.md,distribution.md,access-boundary.md,scoring.md,draft-extraction.md}
docs/planning/{RALPLAN.md,README.md,provenance.md}
.github/workflows/{ci.yml,windows-packaging-spike.yml,windows-clean-vm-smoke.yml}
```
Node owns loopback API, persistence, policy and protocol validation only. **Node never parses Excel raw files.** Java `office-inspector` performs every POI Excel operation under the native Job Object with JVM `-Xmx512m`, private cwd/temp and deadline/budget. Node validates capped canonical protocol evidence only.

## Deterministic draft extraction
### Excel
1. Java extractor sorts sheets by workbook index and cells by row then column. It emits non-empty used cells, capped by **emitted check count**: 50,000/workbook and 10,000/sheet. Styled blanks qualify only inside used range, with at least one supported non-default style dimension, excluding merged non-top-left cells; their checks use the same cap.
2. Emit separate checks: non-empty value; stored formula when present; each observed supported non-default number-format/font/fill/border/alignment dimension. Never emit cached formula result, macro, external connection, unsupported style, or default-only blank.
3. Cutoff is deterministic: sorted candidate checks are emitted until per-sheet/global cap; later checks are omitted. Diagnostics include `DRAFT_CANDIDATE_CAP_REACHED` per affected sheet with source total/emitted/omitted and one workbook total diagnostic. No silent omission.
4. Group draft `Problem` by worksheet (`시트: <source name>`), section by check kind, never infer exam question semantics. All checks default `enabled:false`, `points:0`, `draftState:'pending-user-allocation'`; problem max starts 0. UI provides ordered preview, sheet/kind filtering, capability/evidence, explicit selection and safe-integer allocation. Rule save requires enabled check sum equal maxScore and at least one enabled problem for whole-run grading.

### Access
1. Emit catalog candidates in deterministic canonical order: table, field, PK, index, relationship, query definition. Apply emitted check caps of 20,000/database, 5,000/table and 2,000/query definition after total order. Per-source/database diagnostics carry source/emitted/omitted counts.
2. Propose query-result only after closure is supported. UI requires user-selected result-column `orderBy`; answer evidence must prove non-null unique keys. If absent emit `ACCESS_QUERY_ORDER_REQUIRED` and offer definition-only check; never infer order. UCanAccess preview is never automatic; explicit user request creates eligible scratch job under limits.
3. Candidates start disabled with zero points/pending allocation; filtering, evidence preview, policy-rejection reason, caps and allocation mirror Excel.

## Artifact, worker and launcher security
- Intake validates extension+magic/container, SHA-256, size, encryption/corruption preflight, copies once to read-only LocalAppData artifact storage, and exposes only `{id,sha256,family,detectedFormat,size,createdAt}`.
- Every job gets `%LOCALAPPDATA%\ExcelAccessGrader\tmp\job-<uuid>`. Server alone materializes fixed read-only `input.bin`; reparse points/junctions/symlinks/cwd escapes are rejected. Worker receives opaque handle only.
- JSONL protocol uses stdout frames only: request `{protocolVersion,requestId,operation,artifactHandle,capabilityIds,deadlineEpochMs,budget,cancelToken}` and same-ID `ok|unsupported|error|cancelled` response. Caps: 1 MiB/frame, 16 MiB total request/response, 8 MiB evidence, 256 KiB stderr. Malformed/duplicate/oversize/version mismatch is `IPC_PROTOCOL_ERROR` and tree kill.
- Access scratch DB/`.ldb`/`.laccdb` stay in private cwd. Sidecar in artifact store/parent is policy violation→error→kill→cleanup.
- `tools/win-job-launcher` is a worker-only Rust helper. Common `rust-toolchain.toml` and committed `Cargo.lock` pin **Rust 1.88.0** / **`x86_64-pc-windows-msvc`**. It invokes `CreateProcessW(CREATE_SUSPENDED)`, creates Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, assigns primary process before resume, then resumes it; pipes are inherited. This removes spawn-to-assignment descendant race. 2-second cooperative cancel grace then Job close/terminate kills the tree. Test timeout, cancellation, assignment failure, parent crash/handle close and child/grandchild cleanup. Helper binary is ignored CI/local temporary artifact with manifest/SBOM/checksum; it MUST NEVER be Git-tracked, pushed or GitHub Released.
- `tools/product-launcher` is separate from worker helper and has its own `Cargo.toml`/committed `Cargo.lock`, under the same exact Rust toolchain target/pin. It owns application lifecycle: choose random port, start bundled Node by absolute path, receive server-ready bootstrap through inherited anonymous pipe, then open browser. It passes a 256-bit one-time token only in bootstrap URL **fragment**. Browser client `POST`s token to same-origin bootstrap endpoint; server allows one use within 60 seconds, issues `HttpOnly; SameSite=Strict` session and CSRF token, and client immediately calls `history.replaceState` to remove fragment. Token is memory-only and never in DB/logs/stderr/response body/referrer. Launcher waits for and terminates server tree on user exit.
- Threat/tests cover process command-line inspection, browser history/referrer, copied-URL replay, expiry, duplicate exchange, launcher/server crash, anonymous-pipe readiness spoofing, missing fragment removal and token/log/DB absence. Fragment avoids HTTP request/referrer transport but cannot protect a compromised local browser/process; this is documented as reduced, not eliminated.

## Score/result wire and invariants
All points, every problem accumulator and all summary aggregates are `ScorePoints`: non-negative `Number.isSafeInteger`. Checked addition validates operands and `sum <= Number.MAX_SAFE_INTEGER` before mutation. Rule save/allocation rejects overflow; grading returns stable `SCORE_OVERFLOW` error before partial summary if an aggregate would overflow.

```ts
type ScorePoints = number;
type ExecutionScope = 'full' | 'selected';
type Adjudication = 'final' | 'incomplete' | 'empty';
type GradeSummaryWire = {
  declaredMax: ScorePoints; selectedDeclaredMax: ScorePoints; outOfScopePoints: ScorePoints;
  verifiedEarned: ScorePoints; failedPoints: ScorePoints; indeterminatePoints: ScorePoints;
  finalScorePoints: ScorePoints | null; finalPercent: number | null;
  executionScope: ExecutionScope; adjudication: Adjudication; representsWholeRuleSet: boolean;
};
type RedactedEvidence = {digest:string;preview?:unknown;byteLength:number;redacted:boolean;truncated:boolean};
type CheckResultWire = {
  checkId:string;problemId:string;status:'pass'|'fail'|'unsupported'|'error'|'skipped';
  declaredPoints:ScorePoints;awardedPoints:ScorePoints|null;capabilityId:string;
  locator:Record<string,unknown>;location:string;reasonCode:string;diagnosticCode?:string;
  expected?:RedactedEvidence;observed?:RedactedEvidence;
};
type ProblemResultWire = {
  problemId:string;title:string;declaredPoints:ScorePoints;awardedPoints:ScorePoints|null;
  status:'final'|'incomplete'|'empty'|'out-of-scope';checks:CheckResultWire[];
};
```

Evidence cap is 8 MiB/job canonical payload and 64 KiB/check preview. Larger preview emits digest+metadata only. Never expose raw upload bytes/path/session token/full macro/query secret/stderr. Stable codes: `MATCH`, `VALUE_MISMATCH`, `LOCATOR_MISSING`, `CAPABILITY_UNSUPPORTED`, `PROBE_UNSUPPORTED`, `POLICY_REJECTED`, `LIMIT_EXCEEDED`, `IPC_PROTOCOL_ERROR`, `WORKER_TIMEOUT`, `CANCELLED`, `SCORE_OVERFLOW`, `DRAFT_CANDIDATE_CAP_REACHED`, `ACCESS_QUERY_ORDER_REQUIRED`.

### Status/scope bucket table and invariants
| bucket/status | selected aggregate | result fields |
|---|---|---|
| selected `pass` | `verifiedEarned += points` | awarded=`points`, declared=`points` |
| selected `fail` | `failedPoints += points` | awarded=`0`, declared=`points` |
| selected `unsupported`, `error`, unexpected `skipped` | `indeterminatePoints += points` | awarded=`null`, declared=`points`; incomplete |
| disabled | excluded from declared/selected/out-of-scope and all results | no `CheckResult` |
| enabled unselected problem/check | `outOfScopePoints += points` | `ProblemResult.status='out-of-scope'`; not adjudicated |
| selected empty | no adjudicated buckets | awarded fields null; `adjudication='empty'` |

`declaredMax = selectedDeclaredMax + outOfScopePoints`. Selected scope has `selectedDeclaredMax = verifiedEarned + failedPoints + indeterminatePoints` except empty where selected max is zero. Full has `outOfScopePoints=0`; selected has `outOfScopePoints>0` unless caller chose every enabled problem, then normalize to `executionScope:'full'`. Disabled never contributes. `representsWholeRuleSet === (executionScope==='full')`. `final` needs selected max>0 and indeterminate=0; `incomplete` has indeterminate>0; `empty` only has selected max=0. `finalScorePoints=verifiedEarned` and `finalPercent` non-null only for final. Incomplete/empty final score and affected `ProblemResult.awardedPoints` are null. Selected final is a final **subset**, never a whole-rule grade.

For final only, denominator `selectedDeclaredMax>0`, exact BigInt hundredths-of-percent are:

```ts
q = (BigInt(earned) * 10000n + BigInt(denominator) / 2n) / BigInt(denominator);
finalPercent = Number(q) / 100;
```

Require `0n <= q <= 10000n`; otherwise `SCORE_INVARIANT_ERROR`. UI/export renders exactly two decimals. No floating arithmetic decides rounding. Normative vectors: `0/1 => 0 => 0.00`, `1/6 => 1667 => 16.67`, `1/8 => 1250 => 12.50`, `1/200 => 50 => 0.50`, `199/200 => 9950 => 99.50`, `1/3 => 3333 => 33.33`, `2/3 => 6667 => 66.67`, denominator zero => null, earned>denominator => invariant error. Unit tests include vectors, max-safe and overflow.

## localhost policy and resource limits
Server binds IPv4 `127.0.0.1:<random-port>` only; no `::1`, `localhost`, `0.0.0.0` or public option. Exact Host is `127.0.0.1:<port>`. Mutation requires exact `Origin: http://127.0.0.1:<port>`, valid session and `X-CSRF-Token`; CORS disabled. CSP is self-only with no base/object/frame; nosniff/no-referrer/schema validation/output escaping and LocalAppData ACL apply.

Defaults: upload 128 MiB; artifact store 2 GiB; ZIP 10,000 entries/64 MiB single/512 MiB total/100:1 ratio; Excel 1,000,000 evidence cells/45s; Access metadata/query/job 30s/15s/60s; JVM heap/metaspace 512/128 MiB; query 10,000 rows/8 MiB; jobs 1 and queue 10; scratch 768 MiB; API JSON 1 MiB. Configuration only lowers limits. Resource observation loss is unsupported; infrastructure failure is error, never fail.

## Support matrix, supply chain, distribution, provenance and retention
Matrix row includes format signature/generation, answer/submission formats, capability ID, parser/normalizer version, status/limitation, fixture IDs/manifest oracle SHA and canonical matrix SHA signature. Pair state is static support ∩ answer probe ∩ submission probe ∩ policy ∩ fixture proof. Every supported row needs positive/boundary/negative oracle fixture; validator failure blocks CI. Capability/parser/normalizer/limit/canonicalization changes increment matrix revision and preserve result fingerprint.

Pins: Node `22.14.0` x64, Temurin `21.0.6+7` x64, Corepack pnpm `10.13.1`, Gradle wrapper `8.14.3` with official distribution SHA, `better-sqlite3` `12.2.0` exact Node ABI/x64 prebuild SHA gate, Rust `1.88.0` MSVC. Maven candidates: `org.apache.poi:poi:5.4.0`, `org.apache.poi:poi-ooxml:5.4.0`, `com.healthmarketscience.jackcess:jackcess:4.0.8`, `io.github.spannm:ucanaccess:5.1.3`. Gate records resolved transitives, SPDX, official source URL, SHA and NOTICE; only legally redistributable dependencies pass. pnpm lock, Gradle dependency lock/verification metadata, Cargo locks, runtime source/legal, native ABI/prebuild and launcher/helper SBOM/checksum are mandatory.

CI/local validation ZIP/runtime artifacts MAY be generated solely in ignored temporary storage for Gate 0C/0D. They MUST NEVER be Git-tracked, pushed, or published as GitHub Releases. Data remains `%LOCALAPPDATA%\ExcelAccessGrader\{data,uploads,db,logs,tmp,backups}`; installation directory writes and automatic network updates are prohibited.

Tracked `docs/planning/RALPLAN.md`/`provenance.md` record spec/planner/review hashes, ADRs and requirement trace; `.gjc/**` is never public. Ignore `.gjc/**`, data, dist/installer/artifacts, ZIP/JAR/JRE/Node/helper/launcher binaries, DB/log/tmp/token, test reports/media, workflow evidence and local VM artifacts. CI retention: 14 days; redacted security diagnostics: 7 days; raw user/bundle/token/credential/failure input is deleted. Source allowlist permits source/docs, synthesized fixture/oracle/manifest, lockfiles, workflow YAML, legal metadata and planning provenance only; CI rejects tracked paths outside it.

## Sequencing and dependencies
1. Track provenance, ADR, NO LICENSE/PUBLIC-main/direct-push decision documents without copying `.gjc`.
2. Run Gate 0A formula/style and Gate 0B Access closure/parity; publish ADR outcomes; stop/reapprove on core failure.
3. Run Gate 0C sanitized bundle proof.
4. Create locked domain/support matrix/IPC/score/draft/result schemas, independent fixtures/oracles and CI skeleton.
5. Build artifact/private-cwd/input.bin, separate Rust product launcher and Job helper, Host/Origin/session/CSRF/lifecycle boundaries.
6. Build Java-only POI Excel and Jackcess→closure→restricted UCanAccess capabilities.
7. Build deterministic drafts, editor allocation, full/selected results and evidence UI/API/export.
8. Run CI/local temporary validation ZIP and Gate 0D; complete Korean README/docs; direct push allowlisted source/docs to public `main` only if protection permits.

## Acceptance criteria
1. Excel token-aware formula canonicalization preserves intersection spaces, structured refs and quoted sheet/reference tokens; collision fixtures prove distinct formulas do not collapse.
2. Excel used-cell/styled-blank and Access object/query draft extraction has deterministic emitted-check order/cutoff/caps/diagnostics/default-disabled zero-point allocation; UI exposes truncation/orderBy rejection instead of guessing.
3. Access literal capability/locator/evidence schemas, pair fixtures, canonicalization, read-only sidecar and closure contracts are enforced.
4. `GradeSummaryWire` separates `executionScope`, `adjudication`, `representsWholeRuleSet`; all score aggregates are checked safe integers. `ProblemResultWire`/`CheckResultWire` expose stable location/reason/awarded/declared evidence with redaction/caps.
5. Selected-supported is `selected/final/false`; full-supported is `full/final/true`; incomplete/empty obey bucket invariants. Percent uses exact BigInt rational half-up vectors.
6. Worker uses opaque handle and read-only private `input.bin`; Rust helper assigns suspended child to Job Object before resume and kill/cancel/crash tests pass.
7. Product launcher fragment token obeys expiry/replay/history/command-line/security tests; server bind and Host/Origin/session/CSRF policy are exact.
8. Gate 0C proves self-contained bundle despite preinstalled `windows-2022` tooling; Gate 0D documents Hyper-V Gen2 Windows 10 22H2/Windows 11 24H2 offline proof.
9. Only fixture-proven capabilities are user-selectable; unsupported/error never becomes fail or rescaled score.
10. CI/local validation ZIP/runtime artifacts are ignored temporary artifacts only: never Git-tracked, pushed or GitHub Released. Public `main` receives allowlisted source/docs only; no `.gjc`, product binary, portable ZIP, runtime or workflow evidence.
11. Korean README documents launch, extraction, allocation, full/selected/incomplete scoring, support boundaries, LocalAppData, security and NO LICENSE restriction.

## Verification plan
Implementation phase only; no command runs for this planning revision.

```powershell
corepack pnpm install --frozen-lockfile
pnpm verify:dependencies
pnpm verify:fixtures
pnpm verify:source-allowlist
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm test:security
pnpm test:e2e
pnpm build
pnpm package:windows-x64:spike
pnpm test:packaging-spike
pnpm test:clean-vm
```

Unit covers formula tokens/collisions, safe addition/overflow and exact BigInt percent vectors. Integration covers drafts/caps, score/result wire, opaque artifacts/IPC, Job Object/sidecar/closure. Security covers hostile input, Host/Origin/CSRF, token lifecycle/history/command-line, runtime denial and process kill-tree. E2E covers answer→draft edit/allocation→full/selected→final/incomplete/empty evidence. 0C and 0D retain distinct non-secret provenance receipts.

## Incremental commits, risks and handoff
Planned commits: provenance/ADR decisions; gate fixtures; pinned contracts; artifacts/jobs/launchers; Excel; Access; drafts/scope-aware UI; CI-only bundle validation; docs. Each implementation commit needs focused verification and `git diff --check`; direct push to `main` cannot bypass protection. No product binary/release is in any commit.

POI fidelity, Access closure/parity, native launcher/helper, legal/runtime, score invariants or clean-VM failure blocks the affected path; no silent fallback/weakening is allowed. Access query failure retains metadata/query-definition only pending reapproval. Remote/multiuser/cloud, forms/reports/macros, format expansion or release publication returns to deep-interview/ultragoal. After approval executor begins gates/contracts; architect validates gates/native boundary; critic validates score/draft/result/security regression; team parallelizes Java, Node/security and UI only after domain/matrix/IPC lock.
