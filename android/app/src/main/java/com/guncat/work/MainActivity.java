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
import android.provider.MediaStore;
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
    /** 固定端口：IndexedDB 与 origin 绑定，端口一变上次的数据就看不到了 */
    private static final int APP_PORT = 47653;

    private WebView webView;
    private GuncatServer server;
    private ValueCallback<Uri[]> fileCallback;
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

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
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
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, safeName);
            values.put(MediaStore.MediaColumns.MIME_TYPE,
                    mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Guncat Work");
            Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
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
        public String getVersion() {
            return versionName();
        }

        private String safeFileName(String name) {
            String value = name == null || name.trim().isEmpty() ? "guncat-file" : name.trim();
            return value.replaceAll("[\\\\/:*?\"<>|]", "_");
        }
    }
}
