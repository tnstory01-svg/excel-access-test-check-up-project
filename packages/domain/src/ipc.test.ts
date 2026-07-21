import {
  IPC_MAX_EVIDENCE_BYTES,
  IPC_MAX_FRAME_BYTES,
  IPC_MAX_TOTAL_BYTES,
  IPC_PROTOCOL_VERSION,
  IpcProtocolError,
  IpcProtocolSession,
  parseJsonlFrame,
  validateIpcRequest,
  validateIpcResponse,
} from "./ipc.ts";

const validRequest = {
  protocolVersion: IPC_PROTOCOL_VERSION,
  requestId: "request-1",
  operation: "extract",
  artifactHandle: "artifact-1",
  capabilityIds: ["excel.cell.value.v1"],
  deadlineEpochMs: 1,
  budget: { maxEvidenceBytes: 1, maxChecks: 1, maxRows: 1 },
  cancelToken: "cancel-1",
};

const validResponse = {
  protocolVersion: IPC_PROTOCOL_VERSION,
  requestId: "request-1",
  status: "ok",
  result: { extracted: true },
  evidence: { source: "workbook" },
};

function expectProtocolError(action: () => unknown, message: string): void {
  try {
    action();
  } catch (error) {
    if (error instanceof IpcProtocolError && error.code === "IPC_PROTOCOL_ERROR") return;
    throw error;
  }
  throw new Error(`Expected IPC protocol error: ${message}`);
}

const request = validateIpcRequest(validRequest);
if (request !== validRequest && request.requestId !== validRequest.requestId) throw new Error("valid request was not preserved");
const response = validateIpcResponse(validResponse);
if (response.requestId !== validResponse.requestId || response.status !== "ok") throw new Error("valid response was not preserved");

const session = new IpcProtocolSession();
const requestFrame = JSON.stringify(validRequest);
const responseFrame = JSON.stringify(validResponse);
if (session.acceptRequestFrame(requestFrame).requestId !== "request-1") throw new Error("request frame was rejected");
if (session.acceptResponseFrame(responseFrame).result?.extracted !== true) throw new Error("response frame was rejected");

expectProtocolError(() => validateIpcRequest({ ...validRequest, protocolVersion: IPC_PROTOCOL_VERSION + 1 }), "request protocol mismatch");
expectProtocolError(() => validateIpcResponse({ ...validResponse, protocolVersion: IPC_PROTOCOL_VERSION + 1 }), "response protocol mismatch");
expectProtocolError(() => validateIpcRequest({ ...validRequest, capabilityIds: ["unknown.capability.v1"] }), "unknown capability");
expectProtocolError(() => validateIpcRequest({ ...validRequest, capabilityIds: ["excel.cell.value.v1", "excel.cell.value.v1"] }), "duplicate capability");
expectProtocolError(() => validateIpcRequest({ ...validRequest, requestId: "" }), "empty request identity");
expectProtocolError(() => validateIpcResponse({ ...validResponse, requestId: "" }), "empty response identity");
expectProtocolError(() => parseJsonlFrame("not-json"), "malformed JSONL");
expectProtocolError(() => parseJsonlFrame("x".repeat(IPC_MAX_FRAME_BYTES + 1)), "oversize frame");
expectProtocolError(() => validateIpcResponse({ ...validResponse, evidence: { payload: "x".repeat(IPC_MAX_EVIDENCE_BYTES) } }), "oversize evidence");

const identitySession = new IpcProtocolSession();
identitySession.acceptRequestFrame(requestFrame);
expectProtocolError(() => identitySession.acceptRequestFrame(requestFrame), "duplicate request identity");
expectProtocolError(() => identitySession.acceptResponseFrame(JSON.stringify({ ...validResponse, requestId: "unknown-request" })), "unknown response identity");
identitySession.acceptResponseFrame(responseFrame);
expectProtocolError(() => identitySession.acceptResponseFrame(responseFrame), "duplicate response identity");

const totalSession = new IpcProtocolSession();
const largeResult = { payload: "x".repeat(IPC_MAX_FRAME_BYTES - 2_000) };
let totalExceeded = false;
for (let index = 0; index < 32 && !totalExceeded; index += 1) {
  const requestId = `total-${index}`;
  totalSession.acceptRequestFrame(JSON.stringify({ ...validRequest, requestId }));
  try {
    totalSession.acceptResponseFrame(JSON.stringify({ ...validResponse, requestId, result: largeResult }));
  } catch (error) {
    if (!(error instanceof IpcProtocolError) || error.code !== "IPC_PROTOCOL_ERROR") throw error;
    totalExceeded = true;
  }
}
if (!totalExceeded) throw new Error(`Expected total cap of ${IPC_MAX_TOTAL_BYTES} bytes to reject frames`);
