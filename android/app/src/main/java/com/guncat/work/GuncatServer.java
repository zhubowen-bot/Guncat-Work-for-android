package com.guncat.work;

import android.content.res.AssetManager;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 应用内本地 HTTP 服务。
 *
 * 它同时承担两件事：
 *   1. 把 APK assets/public 下的前端产物以 http://127.0.0.1:<port>/ 提供出来
 *      （WebView 用 http 源，才能用 fetch 流式读 SSE，也不会踩 file:// 的各种限制）；
 *   2. 作为同源反向代理 /__fetch?url=...，把模型 API 请求从 WebView 里转出去，
 *      绕过 CORS，并把响应逐块 flush 回去（流式输出不能等整包）。
 *
 * 只绑定回环地址；代理入口要求启动时注入到页面的随机 token。
 */
final class GuncatServer {
    private static final String TAG = "GuncatServer";
    private static final int BUFFER = 16 * 1024;

    interface AssetLookup {
        InputStream open(String path) throws IOException;
    }

    private final AssetLookup assets;
    private final String token;
    private final String version;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private ServerSocket serverSocket;
    private Thread acceptThread;

    GuncatServer(AssetLookup assets, String token, String version) {
        this.assets = assets;
        this.token = token;
        this.version = version;
    }

    int start(int preferredPort) throws IOException {
        try {
            serverSocket = new ServerSocket();
            serverSocket.setReuseAddress(true);
            serverSocket.bind(new java.net.InetSocketAddress(
                    InetAddress.getByName("127.0.0.1"), preferredPort), 50);
        } catch (IOException e) {
            // 固定端口被占用时退回随机端口：功能可用，但 IndexedDB 的 origin 会变，
            // 那一轮启动看不到上次的数据。正常情况下 47653 只有本应用在用。
            Log.w(TAG, "preferred port " + preferredPort + " unavailable, falling back", e);
            serverSocket = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        }
        acceptThread = new Thread(new Runnable() {
            @Override
            public void run() {
                acceptLoop();
            }
        }, "guncat-http");
        acceptThread.setDaemon(true);
        acceptThread.start();
        return serverSocket.getLocalPort();
    }

    void stop() {
        try {
            if (serverSocket != null) {
                serverSocket.close();
            }
        } catch (IOException ignored) {
        }
        pool.shutdownNow();
    }

    private void acceptLoop() {
        while (!serverSocket.isClosed()) {
            try {
                final Socket socket = serverSocket.accept();
                pool.execute(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            handle(socket);
                        } catch (Exception e) {
                            Log.w(TAG, "request failed: " + e.getMessage());
                        } finally {
                            try {
                                socket.close();
                            } catch (IOException ignored) {
                            }
                        }
                    }
                });
            } catch (IOException e) {
                if (!serverSocket.isClosed()) {
                    Log.w(TAG, "accept failed: " + e.getMessage());
                }
            }
        }
    }

    private void handle(Socket socket) throws IOException {
        socket.setSoTimeout(120_000);
        InputStream rawIn = new BufferedInputStream(socket.getInputStream(), BUFFER);
        OutputStream rawOut = new BufferedOutputStream(socket.getOutputStream(), BUFFER);

        String requestLine = readLine(rawIn);
        if (requestLine == null || requestLine.isEmpty()) {
            return;
        }
        String[] parts = requestLine.split(" ");
        if (parts.length < 2) {
            writeText(rawOut, 400, "text/plain; charset=utf-8", "bad request");
            return;
        }
        String method = parts[0];
        String target = parts[1];

        Map<String, String> headers = new HashMap<String, String>();
        String line;
        while ((line = readLine(rawIn)) != null && !line.isEmpty()) {
            int colon = line.indexOf(':');
            if (colon > 0) {
                headers.put(line.substring(0, colon).trim().toLowerCase(Locale.US), line.substring(colon + 1).trim());
            }
        }

        int contentLength = 0;
        try {
            String value = headers.get("content-length");
            if (value != null) {
                contentLength = Integer.parseInt(value);
            }
        } catch (NumberFormatException ignored) {
        }

        if (target.startsWith("/__fetch")) {
            handleProxy(method, target, headers, rawIn, contentLength, rawOut);
            return;
        }

        if (!"GET".equals(method) && !"HEAD".equals(method)) {
            writeText(rawOut, 405, "text/plain; charset=utf-8", "method not allowed");
            return;
        }

        String path = target;
        int query = path.indexOf('?');
        if (query >= 0) {
            path = path.substring(0, query);
        }
        path = URLDecoder.decode(path, "UTF-8");
        if (path.equals("/") || path.isEmpty()) {
            path = "/index.html";
        }
        if (path.contains("..")) {
            writeText(rawOut, 400, "text/plain; charset=utf-8", "bad path");
            return;
        }

        String assetPath = "public" + path;
        byte[] body = readAsset(assetPath);
        if (body == null) {
            writeText(rawOut, 404, "text/plain; charset=utf-8", "not found: " + path);
            return;
        }
        if (path.equals("/index.html")) {
            String html = new String(body, StandardCharsets.UTF_8);
            html = html.replace("__GUNCAT_TOKEN__", token).replace("__GUNCAT_VERSION__", version);
            body = html.getBytes(StandardCharsets.UTF_8);
        }
        String mime = mimeOf(path);
        rawOut.write(("HTTP/1.1 200 OK\r\n").getBytes(StandardCharsets.US_ASCII));
        rawOut.write(("Content-Type: " + mime + "\r\n").getBytes(StandardCharsets.UTF_8));
        rawOut.write(("Content-Length: " + body.length + "\r\n").getBytes(StandardCharsets.US_ASCII));
        rawOut.write(("Cache-Control: " + (path.equals("/index.html") ? "no-store" : "public, max-age=3600") + "\r\n").getBytes(StandardCharsets.US_ASCII));
        rawOut.write("Connection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
        if (!"HEAD".equals(method)) {
            rawOut.write(body);
        }
        rawOut.flush();
    }

    private byte[] readAsset(String path) {
        try {
            InputStream in = assets.open(path);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[BUFFER];
            int read;
            while ((read = in.read(buffer)) >= 0) {
                out.write(buffer, 0, read);
            }
            in.close();
            return out.toByteArray();
        } catch (IOException e) {
            return null;
        }
    }

    private void handleProxy(
            String method,
            String target,
            Map<String, String> headers,
            InputStream rawIn,
            int contentLength,
            OutputStream rawOut) throws IOException {
        String provided = headers.get("x-guncat-token");
        if (provided == null || !provided.equals(token)) {
            writeText(rawOut, 403, "text/plain; charset=utf-8", "forbidden");
            return;
        }
        int query = target.indexOf("url=");
        if (query < 0) {
            writeText(rawOut, 400, "text/plain; charset=utf-8", "missing url");
            return;
        }
        // URLDecoder 会把 '+' 解成空格，而 URL 的查询串里加号是合法字符
        String encodedUrl = target.substring(query + 4).replace("+", "%2B");
        String url = URLDecoder.decode(encodedUrl, "UTF-8");
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setRequestMethod(method);
            connection.setConnectTimeout(30_000);
            connection.setReadTimeout(0);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("Accept-Encoding", "identity");
            for (Map.Entry<String, String> entry : headers.entrySet()) {
                String key = entry.getKey();
                if (key.equals("host") || key.equals("origin") || key.equals("referer")
                        || key.equals("content-length") || key.equals("connection")
                        || key.equals("accept-encoding") || key.equals("x-guncat-token")
                        || key.startsWith("sec-") || key.startsWith("proxy-")) {
                    continue;
                }
                connection.setRequestProperty(key, entry.getValue());
            }
            if (contentLength > 0 && !"GET".equals(method) && !"HEAD".equals(method)) {
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(contentLength);
                OutputStream out = connection.getOutputStream();
                copy(rawIn, out, contentLength);
                out.flush();
                out.close();
            }

            int status = connection.getResponseCode();
            InputStream body = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            rawOut.write(("HTTP/1.1 " + status + " " + safeReason(connection.getResponseMessage()) + "\r\n").getBytes(StandardCharsets.US_ASCII));
            for (Map.Entry<String, java.util.List<String>> entry : connection.getHeaderFields().entrySet()) {
                String key = entry.getKey();
                if (key == null) {
                    continue;
                }
                String lower = key.toLowerCase(Locale.US);
                if (lower.equals("transfer-encoding") || lower.equals("content-length")
                        || lower.equals("connection") || lower.equals("content-encoding")
                        || lower.equals("keep-alive")) {
                    continue;
                }
                for (String value : entry.getValue()) {
                    if (value != null) {
                        rawOut.write((key + ": " + value + "\r\n").getBytes(StandardCharsets.UTF_8));
                    }
                }
            }
            rawOut.write("Connection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
            rawOut.flush();
            if (body != null && !"HEAD".equals(method)) {
                byte[] buffer = new byte[BUFFER];
                int read;
                while ((read = body.read(buffer)) >= 0) {
                    rawOut.write(buffer, 0, read);
                    rawOut.flush();
                }
                body.close();
            }
        } catch (IOException e) {
            Log.w(TAG, "proxy failed: " + e.getMessage());
            if (connection != null) {
                connection.disconnect();
            }
            try {
                writeText(rawOut, 502, "text/plain; charset=utf-8", "upstream failed: " + e.getMessage());
            } catch (IOException ignored) {
            }
        }
    }

    private static String safeReason(String reason) {
        if (reason == null || reason.isEmpty()) {
            return "OK";
        }
        return reason.replace("\r", " ").replace("\n", " ");
    }

    private static void copy(InputStream in, OutputStream out, int length) throws IOException {
        byte[] buffer = new byte[BUFFER];
        int remaining = length;
        while (remaining > 0) {
            int read = in.read(buffer, 0, Math.min(buffer.length, remaining));
            if (read < 0) {
                break;
            }
            out.write(buffer, 0, read);
            remaining -= read;
        }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int ch;
        while ((ch = in.read()) >= 0) {
            if (ch == '\n') {
                break;
            }
            if (ch != '\r') {
                out.write(ch);
            }
            if (out.size() > 16 * 1024) {
                break;
            }
        }
        if (ch < 0 && out.size() == 0) {
            return null;
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    static void writeText(OutputStream out, int status, String mime, String text) throws IOException {
        byte[] body = text.getBytes(StandardCharsets.UTF_8);
        out.write(("HTTP/1.1 " + status + " X\r\n").getBytes(StandardCharsets.US_ASCII));
        out.write(("Content-Type: " + mime + "\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(("Content-Length: " + body.length + "\r\n").getBytes(StandardCharsets.US_ASCII));
        out.write("Connection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
        out.write(body);
        out.flush();
    }

    private static String mimeOf(String path) {
        String lower = path.toLowerCase(Locale.US);
        if (lower.endsWith(".html")) return "text/html; charset=utf-8";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript; charset=utf-8";
        if (lower.endsWith(".css")) return "text/css; charset=utf-8";
        if (lower.endsWith(".json")) return "application/json; charset=utf-8";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".ico")) return "image/x-icon";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".woff")) return "font/woff";
        if (lower.endsWith(".ttf")) return "font/ttf";
        if (lower.endsWith(".md")) return "text/markdown; charset=utf-8";
        if (lower.endsWith(".wasm")) return "application/wasm";
        return "application/octet-stream";
    }
}
