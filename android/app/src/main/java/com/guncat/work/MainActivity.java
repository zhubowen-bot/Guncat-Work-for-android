package com.guncat.work;

import android.Manifest;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Locale;

/**
 * 唯一 Activity：一个全屏 WebView + 应用内 HTTP 服务。
 *
 * 界面产物来自 src/mobile 的 Vite 构建（打进 assets/public），运行时由 127.0.0.1 的
 * GuncatServer 提供：这样页面是 http 源，fetch 流式读取 SSE 不受 file:// 限制；
 * 跨域 API 请求再经同源代理 /__fetch 转出去。
 */
public class MainActivity extends Activity {
    private static final int REQ_FILE = 1001;
    private static final int REQ_AUDIO_PERMISSION = 1002;
    private static final int REQ_CAPTURE = 1003;
    /** 固定端口：IndexedDB 与 origin 绑定，端口一变上次的数据就看不到了 */
    private static final int APP_PORT = 47653;

    private WebView webView;
    private GuncatServer server;
    private ShellManager shellManager;
    private ValueCallback<Uri[]> fileCallback;
    private Uri pendingCameraUri;
    private boolean cameraCaptureRequested;
    private SpeechRecognizer speechRecognizer;
    private String speechRequestId;
    private boolean speechFinalSent;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private String token;
    private int serverPort;
    private long lastBackAt = 0L;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applySystemBars();

        token = randomToken();
        server = new GuncatServer(new GuncatServer.AssetLookup() {
            @Override
            public java.io.InputStream open(String path) throws java.io.IOException {
                return getAssets().open(path);
            }
        }, token, versionName());

        try {
            serverPort = server.start(APP_PORT);
        } catch (Exception e) {
            Toast.makeText(this, "本地服务启动失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
            finish();
            return;
        }

        webView = new WebView(this);
        webView.setBackgroundColor(Color.TRANSPARENT);
        configureWebView();
        webView.addJavascriptInterface(new NativeBridge(), "GuncatAndroid");
        // 真实命令执行 + 工作区落盘。与 GuncatAndroid 分开注入：前者是系统能力，
        // 这里是可以执行任意命令的入口，边界更清晰。
        shellManager = new ShellManager(this);
        ShellManager.install(shellManager);
        webView.addJavascriptInterface(shellManager, "GuncatShell");
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(246, 246, 247));
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        webView.loadUrl("http://127.0.0.1:" + serverPort + "/index.html");
        if (serverPort != APP_PORT) {
            Toast.makeText(this,
                    "端口 " + APP_PORT + " 被占用，本次使用 " + serverPort + "；历史数据可能不会显示",
                    Toast.LENGTH_LONG).show();
        }

        tts = new TextToSpeech(this, new TextToSpeech.OnInitListener() {
            @Override
            public void onInit(int status) {
                if (status == TextToSpeech.SUCCESS) {
                    ttsReady = true;
                    try {
                        tts.setLanguage(Locale.SIMPLIFIED_CHINESE);
                    } catch (Exception ignored) {
                    }
                }
            }
        });

        requestAudioPermission();
    }

    private void applySystemBars() {
        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        boolean dark = (getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
                == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        int bar = dark ? Color.rgb(24, 24, 26) : Color.rgb(246, 246, 247);
        window.setStatusBarColor(bar);
        window.setNavigationBarColor(bar);
        int flags = window.getDecorView().getSystemUiVisibility();
        if (dark) {
            flags &= ~(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        } else {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= 26) {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
        }
        window.getDecorView().setSystemUiVisibility(flags);
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);
        settings.setSupportZoom(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String host = uri.getHost();
                if (host != null && (host.equals("127.0.0.1") || host.equals("localhost"))) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = callback;
                try {
                    boolean camera = params.isCaptureEnabled() || cameraCaptureRequested;
                    cameraCaptureRequested = false;
                    if (camera) {
                        startCameraCapture();
                        return true;
                    }
                    Intent intent = params.createIntent();
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(intent, REQ_FILE);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        request.grant(request.getResources());
                    }
                });
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                android.util.Log.d("GuncatWeb", message.message() + " @" + message.sourceId() + ":" + message.lineNumber());
                return true;
            }
        });
    }

    private void requestAudioPermission() {
        if (Build.VERSION.SDK_INT >= 23
                && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO_PERMISSION);
        }
    }

    /** 真正调起系统相机：输出到 cache/camera，经 CameraProvider 换成 content:// 交给 WebView。 */
    private void startCameraCapture() throws Exception {
        File dir = new File(getCacheDir(), "camera");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new Exception("无法创建相机缓存目录");
        }
        File output = new File(dir, "capture_" + System.currentTimeMillis() + ".jpg");
        pendingCameraUri = CameraProvider.uriFor(this, output);
        Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        intent.putExtra(MediaStore.EXTRA_OUTPUT, pendingCameraUri);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        startActivityForResult(intent, REQ_CAPTURE);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_CAPTURE) {
            Uri result = null;
            if (resultCode == Activity.RESULT_OK && pendingCameraUri != null) {
                File output = new File(new File(getCacheDir(), "camera"),
                        pendingCameraUri.getLastPathSegment() == null ? "" : pendingCameraUri.getLastPathSegment());
                if (output.exists() && output.length() > 0) {
                    result = pendingCameraUri;
                }
            }
            if (fileCallback != null) {
                fileCallback.onReceiveValue(result == null ? null : new Uri[]{result});
                fileCallback = null;
            }
            pendingCameraUri = null;
            return;
        }
        if (requestCode == REQ_FILE) {
            Uri[] result = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            }
            if (fileCallback != null) {
                fileCallback.onReceiveValue(result);
                fileCallback = null;
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(
                "(function(){"
                        + "var b=document.querySelector('.mobile-backdrop');if(b){b.click();return '1';}"
                        + "var m=document.querySelector('.mobile-sheet-layer');if(m){m.click();return '1';}"
                        + "var p=document.querySelector('.preview-overlay .icon-btn');if(p){p.click();return '1';}"
                        + "var o=document.querySelector('.overlay');if(o){var c=o.querySelector('.icon-btn');if(c){c.click();return '1';}}"
                        + "var w=document.querySelector('.workspace .mobile-only');if(w){w.click();return '1';}"
                        + "return '0';})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (value != null && value.contains("1")) {
                            return;
                        }
                        long now = System.currentTimeMillis();
                        if (now - lastBackAt < 2000) {
                            finish();
                        } else {
                            lastBackAt = now;
                            Toast.makeText(MainActivity.this, "再按一次退出", Toast.LENGTH_SHORT).show();
                        }
                    }
                });
    }

    @Override
    protected void onDestroy() {
        releaseSpeech();
        if (shellManager != null) {
            shellManager.shutdown();
        }
        if (server != null) {
            server.stop();
        }
        if (tts != null) {
            tts.stop();
            tts.shutdown();
        }
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }

    private String asrStatusValue() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && SpeechRecognizer.isOnDeviceRecognitionAvailable(this)) {
            return "on-device";
        }
        return SpeechRecognizer.isRecognitionAvailable(this) ? "system" : "none";
    }

    private void startSpeech(final String requestId) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                releaseSpeech();
                speechRequestId = requestId;
                speechFinalSent = false;
                boolean onDevice = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                        && SpeechRecognizer.isOnDeviceRecognitionAvailable(MainActivity.this);
                if (!onDevice && !SpeechRecognizer.isRecognitionAvailable(MainActivity.this)) {
                    emitAsr(requestId, false, "", "设备没有可用的语音识别服务");
                    return;
                }
                try {
                    speechRecognizer = onDevice
                            ? SpeechRecognizer.createOnDeviceSpeechRecognizer(MainActivity.this)
                            : SpeechRecognizer.createSpeechRecognizer(MainActivity.this);
                } catch (Exception e) {
                    emitAsr(requestId, false, "", "语音识别初始化失败：" + e.getMessage());
                    return;
                }
                speechRecognizer.setRecognitionListener(new RecognitionListener() {
                    @Override
                    public void onReadyForSpeech(Bundle params) {
                    }

                    @Override
                    public void onBeginningOfSpeech() {
                    }

                    @Override
                    public void onRmsChanged(float rmsdB) {
                    }

                    @Override
                    public void onBufferReceived(byte[] buffer) {
                    }

                    @Override
                    public void onEndOfSpeech() {
                    }

                    @Override
                    public void onError(int error) {
                        emitAsr(requestId, false, "", asrErrorMessage(error));
                    }

                    @Override
                    public void onResults(Bundle results) {
                        ArrayList<String> list = results == null ? null
                                : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                        String text = list == null || list.isEmpty() ? "" : list.get(0);
                        if (text == null || text.trim().isEmpty()) {
                            emitAsr(requestId, false, "", "没有识别到语音，请再说一次");
                        } else {
                            emitAsr(requestId, true, text.trim(), "");
                        }
                    }

                    @Override
                    public void onPartialResults(Bundle partialResults) {
                    }

                    @Override
                    public void onEvent(int eventType, Bundle params) {
                    }
                });
                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                        RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag());
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
                intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
                try {
                    speechRecognizer.startListening(intent);
                } catch (Exception e) {
                    emitAsr(requestId, false, "", "无法启动语音识别：" + e.getMessage());
                }
            }
        });
    }

    private void stopSpeech() {
        if (speechRecognizer != null) {
            try {
                speechRecognizer.stopListening();
            } catch (Exception ignored) {
            }
        }
    }

    private void releaseSpeech() {
        if (speechRecognizer != null) {
            try {
                speechRecognizer.cancel();
            } catch (Exception ignored) {
            }
            try {
                speechRecognizer.destroy();
            } catch (Exception ignored) {
            }
            speechRecognizer = null;
        }
    }

    private void emitAsr(String requestId, boolean ok, String text, String error) {
        if (speechFinalSent) {
            return;
        }
        speechFinalSent = true;
        String id = requestId == null || requestId.isEmpty() ? speechRequestId : requestId;
        speechRequestId = null;
        try {
            JSONObject out = new JSONObject();
            out.put("ok", ok);
            out.put("text", text == null ? "" : text);
            out.put("error", error == null ? "" : error);
            final String js = "window.__guncatAsrResult(" + JSONObject.quote(id == null ? "" : id)
                    + "," + JSONObject.quote(out.toString()) + ")";
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (webView != null) {
                        webView.evaluateJavascript(js, null);
                    }
                    releaseSpeech();
                }
            });
        } catch (Exception ignored) {
        }
    }

    private String asrErrorMessage(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_AUDIO:
                return "录音出错，请检查麦克风";
            case SpeechRecognizer.ERROR_CLIENT:
                return "语音识别客户端出错";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "没有麦克风权限，请在系统设置里允许录音";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "语音识别网络错误";
            case SpeechRecognizer.ERROR_NO_MATCH:
                return "没有识别到语音，请再说一次";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "语音识别忙，请稍后再试";
            case SpeechRecognizer.ERROR_SERVER:
                return "语音识别服务出错";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "没有检测到语音输入";
            default:
                return "语音识别失败（错误码 " + error + "）";
        }
    }

    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "0.0.0";
        }
    }

    private static String randomToken() {
        byte[] bytes = new byte[24];
        new SecureRandom().nextBytes(bytes);
        StringBuilder out = new StringBuilder();
        for (byte b : bytes) {
            out.append(String.format(Locale.US, "%02x", b));
        }
        return out.toString();
    }

    /** WebView 拿不到的系统能力。所有方法都在 JS 线程调用。 */
    private class NativeBridge {
        @JavascriptInterface
        public String saveFile(String name, String mime, String base64) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                String safeName = safeFileName(name);
                Uri uri = saveToDownloads(safeName, mime, bytes);
                if (uri == null) {
                    return "err:无法写入下载目录";
                }
                return "ok:下载/Guncat Work/" + safeName;
            } catch (Exception e) {
                return "err:" + e.getMessage();
            }
        }

        private Uri saveToDownloads(String safeName, String mime, byte[] bytes) throws Exception {
            if (Build.VERSION.SDK_INT < 29) {
                throw new Exception("需要 Android 10 及以上");
            }
            // 用反射拿 MediaStore.Downloads：minSdk 28 的机器上没有这个类，
            // 直接写常量会让类验证阶段就解析失败（即使这段代码永远不会执行）。
            Uri collection = (Uri) Class.forName("android.provider.MediaStore$Downloads")
                    .getField("EXTERNAL_CONTENT_URI").get(null);
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, safeName);
            values.put(MediaStore.MediaColumns.MIME_TYPE,
                    mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Guncat Work");
            Uri uri = getContentResolver().insert(collection, values);
            if (uri == null) {
                return null;
            }
            OutputStream out = getContentResolver().openOutputStream(uri);
            if (out == null) {
                return null;
            }
            out.write(bytes);
            out.close();
            return uri;
        }

        @JavascriptInterface
        public String openFile(String name, String mime, String base64) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                Uri uri = saveToDownloads(safeFileName(name), mime, bytes);
                if (uri == null) {
                    return "err:无法写入下载目录";
                }
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, mime == null || mime.isEmpty() ? "*/*" : mime);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
                return "ok";
            } catch (Exception e) {
                return "err:" + e.getMessage();
            }
        }

        @JavascriptInterface
        public String shareFile(String name, String mime, String base64) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                Uri uri = saveToDownloads(safeFileName(name), mime, bytes);
                if (uri == null) {
                    return "err:无法写入下载目录";
                }
                Intent intent = new Intent(Intent.ACTION_SEND);
                intent.setType(mime == null || mime.isEmpty() ? "*/*" : mime);
                intent.putExtra(Intent.EXTRA_STREAM, uri);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(Intent.createChooser(intent, "分享文件"));
                return "ok";
            } catch (Exception e) {
                return "err:" + e.getMessage();
            }
        }

        @JavascriptInterface
        public void toast(String message) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(MainActivity.this, message, Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public String info() {
            try {
                JSONObject json = new JSONObject();
                json.put("version", versionName());
                json.put("sdk", Build.VERSION.SDK_INT);
                json.put("model", Build.MODEL);
                return json.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public void ttsSpeak(String text, String rate) {
            if (!ttsReady || tts == null || text == null || text.isEmpty()) {
                return;
            }
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        tts.setSpeechRate(Float.parseFloat(rate));
                    } catch (Exception ignored) {
                    }
                    tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "guncat");
                }
            });
        }

        @JavascriptInterface
        public void ttsStop() {
            if (tts != null) {
                tts.stop();
            }
        }

        @JavascriptInterface
        public String pickDirectory() {
            return "";
        }

        @JavascriptInterface
        public String asrStatus() {
            return asrStatusValue();
        }

        @JavascriptInterface
        public String asrStart() {
            String id = "asr_" + System.currentTimeMillis() + "_" + Math.abs(new SecureRandom().nextInt());
            startSpeech(id);
            return id;
        }

        @JavascriptInterface
        public void asrStop() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    stopSpeech();
                }
            });
        }

        @JavascriptInterface
        public void armCameraCapture() {
            // WebView 在不同版本对 input[capture] 的 isCaptureEnabled() 支持不一致；
            // JS 在点 input 前显式举旗，原生侧据此一定走系统相机。
            cameraCaptureRequested = true;
            new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
                @Override
                public void run() {
                    cameraCaptureRequested = false;
                }
            }, 5000);
        }

        @JavascriptInterface
        public String getVersion() {
            return versionName();
        }

        private String safeFileName(String name) {
            String value = name == null || name.trim().isEmpty() ? "guncat-file" : name.trim();
            return value.replaceAll("[\\\\/:*?\"<>|]", "_");
        }
    }
}
