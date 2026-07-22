package local.grader;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

public final class Main {
    private Main() {
    }

    public static void main(String[] arguments) {
        Protocol.Session session = new Protocol.Session();
        try {
            while (true) {
                Protocol.Frame frame = Protocol.readFrame(System.in);
                if (frame == null) {
                    return;
                }
                Protocol.Request request = session.acceptRequestFrame(frame);
                String response = Protocol.unsupportedResponse(request, "CAPABILITY_UNSUPPORTED");
                session.acceptResponseFrame(response);
                System.out.write(response.getBytes(StandardCharsets.UTF_8));
                System.out.write('\n');
                System.out.flush();
            }
        } catch (Protocol.ProtocolException exception) {
            System.err.println("IPC_PROTOCOL_ERROR: " + exception.getMessage());
            System.exit(2);
        } catch (IOException exception) {
            System.err.println("IPC_PROTOCOL_ERROR: unable to read JSONL input");
            System.exit(2);
        }
    }

}
