package in.thecontrarian.manorama.events;

/** Host JNI contract smoke test; no Android SDK, Gradle or pixels involved. */
public final class RustBridge {
    public static native String cluster(String itemsJson, String configJson);
    public static native String decodeIndex(String indexJson);
    public static native String encodeIndex(String indexJson);

    private static int checks;
    private static void check(boolean condition) {
        checks++;
        if (!condition) throw new AssertionError("JNI check " + checks);
    }
    private static void invalid(Runnable action) {
        try {
            action.run();
            throw new AssertionError("invalid input returned success");
        } catch (IllegalArgumentException error) {
            check(error.getMessage().startsWith("{"));
            check(error.getMessage().contains("\"code\":\"INVALID_INPUT\""));
            check(error.getMessage().contains("\"message\":"));
        }
    }
    public static void main(String[] args) {
        System.load(args[0]);
        String options = "{\"sourceId\":\"source\",\"calendar\":{\"identifier\":\"gregorian\",\"secondsFromGMT\":0},\"config\":{}}";
        String result = cluster("[{\"id\":\"a\",\"timestamp\":-0.5,\"isScreenshot\":false}]", options);
        check(result.contains("\"startDate\":-0.5"));
        check(result.contains("\"itemIds\":[\"a\"]"));
        check(cluster("[]", options).contains("\"events\":[]"));
        String index = "{\"schemaVersion\":1,\"source\":{\"deviceId\":\"device\",\"sourceId\":\"source\",\"sourceKind\":\"mediastore\",\"label\":\"Camera\",\"lastIndexedAt\":-0.5},\"config\":{},\"itemCache\":{},\"events\":[],\"screenshotItemIds\":[]}";
        String encoded = encodeIndex(index);
        check(decodeIndex(encoded).equals(encoded));
        invalid(() -> cluster("not-json", options));
        invalid(() -> cluster("[]", "{}"));
        invalid(() -> cluster("[]", options.replace("gregorian", "buddhist")));
        invalid(() -> cluster("[{\"id\":\"a\",\"timestamp\":1e100,\"isScreenshot\":false}]", options));
        invalid(() -> decodeIndex("{}"));
        invalid(() -> encodeIndex(index.replace("\"schemaVersion\":1", "\"schemaVersion\":2")));
        // Every export must reject before get_string copies the Java backing
        // array. Check the phase in the structured error, not merely failure.
        String huge = " ".repeat(16 * 1024 * 1024 + 1);
        for (Runnable action : new Runnable[] { () -> cluster(huge, options), () -> decodeIndex(huge), () -> encodeIndex(huge) }) {
            try { action.run(); throw new AssertionError("pre-copy limit missed"); }
            catch (IllegalArgumentException error) {
                check(error.getMessage().contains("before copy"));
                check(error.getMessage().contains("INVALID_INPUT"));
            }
        }
        String configHuge = options + " ".repeat(16 * 1024);
        invalid(() -> cluster("[]", configHuge));
        invalid(() -> cluster("[{\"id\":\"" + "x".repeat(1024 * 1024) + "\",\"timestamp\":0,\"isScreenshot\":false}]", options));
        invalid(() -> cluster("[{\"id\":\"a\",\"timestamp\":0,\"isScreenshot\":false,\"burstIdentifier\":\"" + "x".repeat(4097) + "\"}]", options));
        invalid(() -> cluster("[]", options.replace("\"source\"", "\"" + "x".repeat(4097) + "\"")));
        String countHuge = "[" + "0,".repeat(100000) + "0]";
        invalid(() -> cluster(countHuge, options));
        invalid(() -> decodeIndex(index.replace("\"screenshotItemIds\":[]", "\"screenshotItemIds\":[" + "\"a\",".repeat(100000) + "\"a\"]")));
        invalid(() -> encodeIndex(index.replace("\"sourceId\":\"source\"", "\"sourceId\":\"" + "x".repeat(4097) + "\"")));
        invalid(() -> cluster(null, options));
        invalid(() -> decodeIndex(null));
        invalid(() -> encodeIndex(null));
        // Real Java UTF-16 length is under the ceiling, but its UTF-8 bytes
        // exceed 32 MiB. Whitespace isn't JSON, so require the byte-limit phase.
        String utf8Huge = "界".repeat(12 * 1024 * 1024);
        try { decodeIndex(utf8Huge); throw new AssertionError("UTF-8 limit missed"); }
        catch (IllegalArgumentException error) { check(error.getMessage().contains("UTF-8 JSON resource limit")); }
        StringBuilder fiftyK = new StringBuilder("[");
        for (int n = 0; n < 50000; n++) {
            if (n != 0) fiftyK.append(',');
            fiftyK.append("{\"id\":\"camera/IMG_").append(n).append(".jpg\",\"timestamp\":").append(1760000000L + n).append(",\"isScreenshot\":false}");
        }
        fiftyK.append(']');
        check(cluster(fiftyK.toString(), options).contains("camera/IMG_49999.jpg"));
        System.out.println("JNI host contract: " + checks + " checks passed");
    }
}
