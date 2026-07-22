package local.grader;

import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

final class ProtocolTest {
    private static final String REQUEST = """
            {"protocolVersion":1,"requestId":"request-1","operation":"extract","artifactHandle":"artifact-1","capabilityIds":["excel.cell.value.v1"],"deadlineEpochMs":1,"budget":{"maxEvidenceBytes":1,"maxChecks":1,"maxRows":1},"cancelToken":"cancel-1"}
            """.strip();

    @Test
    void acceptsValidRequestFrameAndEmitsSameIdUnsupportedResponse() throws Exception {
        Protocol.Session session = new Protocol.Session();

        Protocol.Request request = session.acceptRequestFrame(frame(REQUEST));
        String response = Protocol.unsupportedResponse(request, "CAPABILITY_UNSUPPORTED");

        assertEquals("request-1", request.requestId());
        assertEquals("extract", request.operation());
        assertEquals("{\"protocolVersion\":1,\"requestId\":\"request-1\",\"status\":\"unsupported\",\"diagnosticCode\":\"CAPABILITY_UNSUPPORTED\"}", response);
    }

    @Test
    void rejectsMalformedFrame() {
        assertThrows(Protocol.ProtocolException.class, () -> Protocol.parseRequestFrame("{not-json"));
    }

    @Test
    void rejectsUnsupportedProtocolVersion() {
        assertThrows(Protocol.ProtocolException.class, () -> Protocol.parseRequestFrame(REQUEST.replace("\"protocolVersion\":1", "\"protocolVersion\":2")));
    }

    @Test
    void rejectsOversizeFrame() {
        String frame = " ".repeat(Protocol.MAX_FRAME_BYTES + 1);
        assertThrows(Protocol.ProtocolException.class, () -> Protocol.parseRequestFrame(frame));
    }
    @Test
    void acceptsFrameAtExactByteCap() throws Exception {
        String request = REQUEST + " ".repeat(Protocol.MAX_FRAME_BYTES - REQUEST.getBytes(StandardCharsets.UTF_8).length);
        Protocol.Frame frame = Protocol.readFrame(new ByteArrayInputStream((request + "\n").getBytes(StandardCharsets.UTF_8)));

        assertEquals(Protocol.MAX_FRAME_BYTES, frame.bytes().length);
        new Protocol.Session().acceptRequestFrame(frame);
    }

    @Test
    void rejectsCompleteRequestAtEofWithoutLf() throws Exception {
        Protocol.Frame frame = Protocol.readFrame(new ByteArrayInputStream(REQUEST.getBytes(StandardCharsets.UTF_8)));

        assertThrows(Protocol.ProtocolException.class, () -> new Protocol.Session().acceptRequestFrame(frame));
    }

    @Test
    void rejectsCrLfRequestFrame() throws Exception {
        Protocol.Frame frame = Protocol.readFrame(new ByteArrayInputStream((REQUEST + "\r\n").getBytes(StandardCharsets.UTF_8)));

        assertThrows(Protocol.ProtocolException.class, () -> new Protocol.Session().acceptRequestFrame(frame));
    }

    @Test
    void rejectsMalformedUtf8BeforeParsing() {
        Protocol.Session session = new Protocol.Session();

        assertThrows(Protocol.ProtocolException.class,
                () -> session.acceptRequestFrame(new Protocol.Frame(new byte[]{(byte) 0xc3, 0x28}, true)));
    }

    @Test
    void rejectsTrailingJsonValue() {
        assertThrows(Protocol.ProtocolException.class, () -> Protocol.parseRequestFrame(REQUEST + "{}"));
    }

    @Test
    void rejectsDuplicateJsonField() {
        assertThrows(Protocol.ProtocolException.class,
                () -> Protocol.parseRequestFrame(REQUEST.replace("\"requestId\":\"request-1\"", "\"requestId\":\"request-1\",\"requestId\":\"request-2\"")));
    }

    @Test
    void rejectsDuplicateRequestIdWithoutChargingIt() throws Exception {
        Protocol.Session session = new Protocol.Session();

        session.acceptRequestFrame(frame(REQUEST));
        assertThrows(Protocol.ProtocolException.class, () -> session.acceptRequestFrame(frame(REQUEST)));
    }

    @Test
    void acceptsExactAggregateCapAndRejectsAnotherDelimiter() throws Exception {
        Protocol.Session session = new Protocol.Session();
        String maximumResponse = " ".repeat(Protocol.MAX_FRAME_BYTES);

        for (int index = 0; index < 15; index++) {
            session.acceptResponseFrame(maximumResponse);
        }
        session.acceptResponseFrame(" ".repeat(Protocol.MAX_FRAME_BYTES - 16));

        assertThrows(Protocol.ProtocolException.class, () -> session.acceptResponseFrame(""));
    }
    @Test
    void mainEmitsUtf8ResponseTerminatedByLiteralLfWithoutCr() {
        InputStream originalIn = System.in;
        PrintStream originalOut = System.out;
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try {
            System.setIn(new ByteArrayInputStream((REQUEST + "\n").getBytes(StandardCharsets.UTF_8)));
            System.setOut(new PrintStream(output, true, StandardCharsets.UTF_8));
            Main.main(new String[0]);
        } finally {
            System.setIn(originalIn);
            System.setOut(originalOut);
        }

        byte[] bytes = output.toByteArray();
        String expected = "{\"protocolVersion\":1,\"requestId\":\"request-1\",\"status\":\"unsupported\",\"diagnosticCode\":\"CAPABILITY_UNSUPPORTED\"}\n";
        assertEquals(expected, new String(bytes, StandardCharsets.UTF_8));
        assertEquals(-1, indexOf(bytes, (byte) '\r'));
    }

    private static int indexOf(byte[] bytes, byte value) {
        for (int index = 0; index < bytes.length; index++) {
            if (bytes[index] == value) {
                return index;
            }
        }
        return -1;
    }

    private static Protocol.Frame frame(String value) {
        return new Protocol.Frame(value.getBytes(StandardCharsets.UTF_8), true);
    }
}
