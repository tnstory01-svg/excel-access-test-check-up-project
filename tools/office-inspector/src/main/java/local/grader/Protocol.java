package local.grader;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;

public final class Protocol {
    public static final int VERSION = 1;
    public static final int MAX_FRAME_BYTES = 1024 * 1024;
    public static final int MAX_TOTAL_BYTES = 16 * 1024 * 1024;
    public static final int MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
    private static final int MAX_CAPABILITY_IDS = 256;
    private static final ObjectMapper JSON = new ObjectMapper(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .build());
    private static final Set<String> REQUEST_FIELDS = Set.of(
            "protocolVersion", "requestId", "operation", "artifactHandle", "capabilityIds",
            "deadlineEpochMs", "budget", "cancelToken");
    private static final Set<String> BUDGET_FIELDS = Set.of("maxEvidenceBytes", "maxChecks", "maxRows");
    private static final Set<String> CAPABILITY_IDS = Set.of(
            "excel.cell.value.v1",
            "excel.cell.formula.stored.v1",
            "excel.style.number-format.v1",
            "excel.style.font.v1",
            "excel.style.fill.v1",
            "excel.style.border.v1",
            "excel.style.alignment.v1",
            "access.table.schema.v1",
            "access.field.property.v1",
            "access.primary-key.v1",
            "access.index.v1",
            "access.relationship.v1",
            "access.query.definition.v1",
            "access.query.result.v1");

    private Protocol() {
    }

    public record Request(
            String requestId,
            String operation,
            String artifactHandle,
            ArrayNode capabilityIds,
            long deadlineEpochMs,
            ObjectNode budget,
            String cancelToken) {
    }

    public static final class ProtocolException extends Exception {
        public ProtocolException(String message) {
            super(message);
        }
    }
    public record Frame(byte[] bytes, boolean terminated) {
    }

    public static Frame readFrame(InputStream input) throws IOException, ProtocolException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        while (true) {
            int next = input.read();
            if (next == -1) {
                return buffer.size() == 0 ? null : new Frame(buffer.toByteArray(), false);
            }
            if (next == '\n') {
                return new Frame(buffer.toByteArray(), true);
            }
            if (buffer.size() >= MAX_FRAME_BYTES) {
                throw new ProtocolException("JSONL frame exceeds 1 MiB");
            }
            buffer.write(next);
        }
    }


    public static final class Session {
        private int totalBytes;
        private final Set<String> requestIds = new HashSet<>();

        public Request acceptRequestFrame(Frame frame) throws ProtocolException {
            if (!frame.terminated()) {
                throw new ProtocolException("JSONL request frame must end with LF");
            }
            String requestText = decodeUtf8(frame.bytes());
            Request request = parseRequestFrame(requestText, frame.bytes().length);
            if (requestIds.contains(request.requestId())) {
                throw new ProtocolException("Duplicate requestId");
            }
            charge(frame.bytes().length, frame.terminated());
            requestIds.add(request.requestId());
            return request;
        }

        public void acceptResponseFrame(String frame) throws ProtocolException {
            int bytes = frame.getBytes(StandardCharsets.UTF_8).length;
            if (bytes > MAX_FRAME_BYTES) {
                throw new ProtocolException("Response frame exceeds 1 MiB");
            }
            charge(bytes, true);
        }

        private void charge(int bytes, boolean terminated) throws ProtocolException {
            long additional = (long) bytes + (terminated ? 1 : 0);
            if ((long) totalBytes + additional > MAX_TOTAL_BYTES) {
                throw new ProtocolException("JSONL request/response total exceeds 16 MiB");
            }
            totalBytes += (int) additional;
        }
    }

    public static Request parseRequestFrame(String frame) throws ProtocolException {
        return parseRequestFrame(frame, frame.getBytes(StandardCharsets.UTF_8).length);
    }

    private static Request parseRequestFrame(String frame, int bytes) throws ProtocolException {
        if (frame.indexOf('\n') >= 0 || frame.indexOf('\r') >= 0) {
            throw new ProtocolException("JSONL frame must contain exactly one line");
        }
        if (bytes > MAX_FRAME_BYTES) {
            throw new ProtocolException("JSONL frame exceeds 1 MiB");
        }
        JsonNode value;
        try (JsonParser parser = JSON.createParser(frame)) {
            value = JSON.readTree(parser);
            if (parser.nextToken() != null) {
                throw new ProtocolException("JSONL frame must contain exactly one JSON value");
            }
        } catch (ProtocolException exception) {
            throw exception;
        } catch (Exception exception) {
            throw new ProtocolException("Malformed JSONL frame");
        }
        if (!(value instanceof ObjectNode object) || !hasOnlyFields(object, REQUEST_FIELDS)) {
            throw new ProtocolException("Request must contain only protocol fields");
        }
        if (!object.path("protocolVersion").isInt() || object.path("protocolVersion").intValue() != VERSION) {
            throw new ProtocolException("Unsupported protocol version");
        }
        String requestId = requiredString(object, "requestId", 128);
        String operation = requiredString(object, "operation", 32);
        if (!operation.equals("extract") && !operation.equals("grade")) {
            throw new ProtocolException("Unsupported operation");
        }
        String artifactHandle = requiredString(object, "artifactHandle", 512);
        String cancelToken = requiredString(object, "cancelToken", 512);
        ArrayNode capabilityIds = requiredCapabilities(object);
        long deadlineEpochMs = positiveInteger(object, "deadlineEpochMs", 9_007_199_254_740_991L);
        ObjectNode budget = requiredBudget(object);
        return new Request(requestId, operation, artifactHandle, capabilityIds, deadlineEpochMs, budget, cancelToken);
    }

    public static String unsupportedResponse(Request request, String diagnosticCode) throws ProtocolException {
        ObjectNode response = JSON.createObjectNode();
        response.put("protocolVersion", VERSION);
        response.put("requestId", request.requestId());
        response.put("status", "unsupported");
        response.put("diagnosticCode", requiredNonEmpty(diagnosticCode, "diagnosticCode", 128));
        try {
            String frame = JSON.writeValueAsString(response);
            if (frame.getBytes(StandardCharsets.UTF_8).length > MAX_FRAME_BYTES) {
                throw new ProtocolException("Response frame exceeds 1 MiB");
            }
            return frame;
        } catch (ProtocolException exception) {
            throw exception;
        } catch (Exception exception) {
            throw new ProtocolException("Unable to serialize response");
        }
    }
    private static String decodeUtf8(byte[] bytes) throws ProtocolException {
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString();
        } catch (CharacterCodingException exception) {
            throw new ProtocolException("Malformed UTF-8 JSONL frame");
        }
    }

    private static boolean hasOnlyFields(ObjectNode object, Set<String> allowed) {
        Iterator<String> fields = object.fieldNames();
        while (fields.hasNext()) {
            if (!allowed.contains(fields.next())) {
                return false;
            }
        }
        return object.size() == allowed.size();
    }

    private static String requiredString(ObjectNode object, String field, int maximum) throws ProtocolException {
        JsonNode value = object.get(field);
        if (value == null || !value.isTextual()) {
            throw new ProtocolException(field + " must be a string");
        }
        return requiredNonEmpty(value.textValue(), field, maximum);
    }

    private static String requiredNonEmpty(String value, String field, int maximum) throws ProtocolException {
        if (value.isEmpty() || value.length() > maximum) {
            throw new ProtocolException(field + " must be a non-empty string no longer than " + maximum + " characters");
        }
        return value;
    }

    private static ArrayNode requiredCapabilities(ObjectNode object) throws ProtocolException {
        JsonNode value = object.get("capabilityIds");
        if (!(value instanceof ArrayNode capabilities) || capabilities.size() > MAX_CAPABILITY_IDS) {
            throw new ProtocolException("capabilityIds must contain at most 256 strings");
        }
        Set<String> seen = new HashSet<>();
        for (JsonNode capability : capabilities) {
            if (!capability.isTextual() || !CAPABILITY_IDS.contains(capability.textValue()) || !seen.add(capability.textValue())) {
                throw new ProtocolException("capabilityIds must contain unique canonical capability IDs");
            }
        }
        return capabilities;
    }

    private static long positiveInteger(ObjectNode object, String field, long maximum) throws ProtocolException {
        JsonNode value = object.get(field);
        if (value == null || !value.canConvertToLong() || !value.isIntegralNumber() || value.longValue() <= 0 || value.longValue() > maximum) {
            throw new ProtocolException(field + " must be a positive integer");
        }
        return value.longValue();
    }

    private static ObjectNode requiredBudget(ObjectNode object) throws ProtocolException {
        JsonNode value = object.get("budget");
        if (!(value instanceof ObjectNode budget) || !hasOnlyFields(budget, BUDGET_FIELDS)) {
            throw new ProtocolException("budget must contain only maxEvidenceBytes, maxChecks, and maxRows");
        }
        positiveInteger(budget, "maxEvidenceBytes", MAX_EVIDENCE_BYTES);
        positiveInteger(budget, "maxChecks", 1_000_000);
        positiveInteger(budget, "maxRows", 1_000_000);
        return budget;
    }
}
