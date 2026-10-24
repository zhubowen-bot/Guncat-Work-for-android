package com.guncat.work;

import android.content.Context;
import android.os.Build;
import android.system.ErrnoException;
import android.system.Os;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 首次启动把随包内置的 Termux 用户态解压到应用私有目录。
 *
 * 为什么路径长这样：
 *   Termux 的二进制里写死了 `/data/data/com.termux/files/usr`。我们的包名是
 *   `com.guncat.work`，路径更长，不能直接原地改。构建期把 bootstrap 里的
 *   `/data/data/com.termux/files/usr`（31 字符）替换成
 *   `/data/data/com.guncat.work/abcd`（也是 31 字符），home 路径同理替换成
 *   `/data/data/com.guncat.work/abcde`（32 字符）。于是：
 *     · 所有 ELF / 脚本里的路径都是等长替换，不需要改写文件结构；
 *     · `abcd` / `abcde` 是应用私有目录下的真实目录，不是指向别处的符号链接；
 *     · 只有在 targetSdk <= 28 时，Android 才允许执行应用私有目录里的文件 ——
 *       这也是 Termux 官方一直把 targetSdk 压在 28 的原因。
 *
 * 解压逻辑对齐 termux-app 的 TermuxInstaller：zip 里没有符号链接，`SYMLINKS.txt`
 * 用 `←` 分隔「目标←链接路径」，需要先解压文件、再统一建链接。
 */
final class TermuxBootstrap {
    private static final String TAG = "GuncatBootstrap";
    static final String VERSION = "2026.10.18-r1+tools2";
    private static final String ASSET = "termux/bootstrap-aarch64.zip";
    private static final String MARKER = ".guncat-bootstrap";

    private final Context context;
    private final File appHome;
    private final File prefix;
    private final File homeDir;
    private final File cacheDir;
    private final String prefixAlias;
    private final String homeAlias;
    private final String cacheAlias;

    private volatile boolean ready = false;
    private volatile boolean installing = false;
    private volatile int extracted = 0;
    private volatile String error = "";
    private Thread worker;

    TermuxBootstrap(Context context) {
        this.context = context.getApplicationContext();
        this.appHome = this.context.getFilesDir().getParentFile();
        this.prefix = new File(appHome, "abcd");
        this.homeDir = new File(appHome, "abcde");
        this.cacheDir = new File(appHome, "cache");
        String packageName = this.context.getPackageName();
        this.prefixAlias = "/data/data/" + packageName + "/abcd";
        this.homeAlias = "/data/data/" + packageName + "/abcde";
        this.cacheAlias = "/data/data/" + packageName + "/cache";
    }

    File prefixDir() {
        return prefix;
    }

    String prefixPath() {
        return prefixAlias;
    }

    String homePath() {
        return homeAlias;
    }

    String cachePath() {
        return cacheAlias;
    }

    boolean isReady() {
        return ready;
    }

    boolean isInstalling() {
        return installing;
    }

    int extracted() {
        return extracted;
    }

    String error() {
        return error;
    }

    String statusJson() {
        JSONObject out = new JSONObject();
        try {
            out.put("supported", supportedAbi());
            out.put("ready", ready);
            out.put("installing", installing);
            out.put("extracted", extracted);
            out.put("error", error);
            out.put("version", VERSION);
            out.put("prefix", prefixAlias);
            out.put("abi", Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "");
        } catch (Exception ignored) {
        }
        return out.toString();
    }

    private boolean supportedAbi() {
        if (Build.SUPPORTED_ABIS.length == 0) {
            return false;
        }
        String abi = Build.SUPPORTED_ABIS[0];
        return abi != null && abi.startsWith("arm64");
    }

    /** 启动后台安装。重复调用不会起第二个线程。 */
    synchronized void prepareAsync() {
        if (ready || installing) {
            return;
        }
        if (!supportedAbi()) {
            error = "内置终端目前只提供 arm64 版本，本机 ABI 为 " +
                    (Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "未知") +
                    "。可以在设置里改用系统 Shell。";
            return;
        }
        installing = true;
        error = "";
        worker = new Thread(new Runnable() {
            @Override
            public void run() {
                install();
            }
        }, "guncat-bootstrap");
        worker.setDaemon(true);
        worker.start();
    }

    /** 用户在设置里点「重新安装」时使用。 */
    synchronized void reinstall() {
        if (installing) {
            return;
        }
        ready = false;
        deleteRecursive(prefix);
        deleteRecursive(homeDir);
        deleteRecursive(cacheDir);
        prepareAsync();
    }

    private void install() {
        try {
            if (markerMatches() && new File(prefix, "bin/bash").isFile()) {
                ensureRuntimeDirs();
                ready = true;
                installing = false;
                return;
            }
            Log.i(TAG, "installing bundled Termux bootstrap " + VERSION);
            extracted = 0;
            deleteRecursive(prefix);
            if (!prefix.mkdirs() && !prefix.isDirectory()) {
                throw new IOException("无法创建 " + prefix.getAbsolutePath());
            }
            List<String[]> symlinks = new ArrayList<String[]>(1300);
            long total = 0;
            try (InputStream raw = context.getAssets().open(ASSET);
                 ZipInputStream zip = new ZipInputStream(raw)) {
                ZipEntry entry;
                byte[] buffer = new byte[32 * 1024];
                while ((entry = zip.getNextEntry()) != null) {
                    String name = entry.getName();
                    if (name == null || name.isEmpty()) {
                        continue;
                    }
                    if (name.equals("SYMLINKS.txt")) {
                        readSymlinks(zip, symlinks);
                        continue;
                    }
                    File target = safeChild(prefix, name);
                    if (entry.isDirectory()) {
                        // 空目录也要建：etc/apt/apt.conf.d、var/lib/apt/lists 这些目录
                        // 在 zip 里是空的，跳过等 apt 自己建就会先报权限/路径错误
                        if (!target.isDirectory() && !target.mkdirs()) {
                            throw new IOException("无法创建目录 " + target.getAbsolutePath());
                        }
                        continue;
                    }
                    File parent = target.getParentFile();
                    if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                        throw new IOException("无法创建目录 " + parent.getAbsolutePath());
                    }
                    try (OutputStream output = new FileOutputStream(target)) {
                        int read;
                        while ((read = zip.read(buffer)) >= 0) {
                            output.write(buffer, 0, read);
                        }
                    }
                    if (needsExecutable(name)) {
                        Os.chmod(target.getAbsolutePath(), 0700);
                    }
                    total += target.length();
                    extracted++;
                }
            }
            if (symlinks.isEmpty()) {
                throw new IOException("bootstrap 里没有 SYMLINKS.txt，压缩包不完整");
            }
            for (String[] link : symlinks) {
                File linkFile = safeChild(prefix, link[1]);
                File parent = linkFile.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                    continue;
                }
                // 只删链接自身，不跟随它指向的目录
                try {
                    Os.remove(linkFile.getAbsolutePath());
                } catch (Exception ignored) {
                }
                try {
                    Os.symlink(link[0], linkFile.getAbsolutePath());
                } catch (ErrnoException e) {
                    Log.w(TAG, "symlink failed " + linkFile + " -> " + link[0] + ": " + e.getMessage());
                }
            }
            ensureRuntimeDirs();
            writeMarker();
            Log.i(TAG, "bootstrap ready, " + extracted + " files, " + (total / 1024 / 1024) + " MB");
            error = "";
            ready = true;
        } catch (Throwable e) {
            Log.e(TAG, "bootstrap install failed", e);
            error = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            ready = false;
        } finally {
            installing = false;
        }
    }

    private void readSymlinks(InputStream input, List<String[]> out) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int read;
        while ((read = input.read(chunk)) >= 0) {
            buffer.write(chunk, 0, read);
        }
        String text = new String(buffer.toByteArray(), StandardCharsets.UTF_8);
        for (String line : text.split("\n")) {
            if (line.isEmpty()) {
                continue;
            }
            int arrow = line.indexOf('\u2190');
            if (arrow < 0) {
                continue;
            }
            String target = line.substring(0, arrow);
            String path = line.substring(arrow + 1);
            while (path.startsWith("./")) {
                path = path.substring(2);
            }
            out.add(new String[]{target, path});
        }
    }

    private void ensureRuntimeDirs() {
        if (!homeDir.isDirectory()) {
            //noinspection ResultOfMethodCallIgnored
            homeDir.mkdirs();
        }
        if (!cacheDir.isDirectory()) {
            //noinspection ResultOfMethodCallIgnored
            cacheDir.mkdirs();
        }
        String[] dirs = new String[]{
                "tmp",
                "var/tmp",
                "var/log/apt",
                "var/lib/apt/lists/partial",
                "var/cache/apt/archives/partial",
                "var/lib/dpkg/info",
                "etc/apt/apt.conf.d",
                "etc/apt/trusted.gpg.d",
                "etc/apt/preferences.d",
                "home"
        };
        for (String dir : dirs) {
            File target = new File(prefix, dir);
            if (!target.isDirectory()) {
                //noinspection ResultOfMethodCallIgnored
                target.mkdirs();
            }
        }
        // apt 编译时把 cache 默认值写死在旧包名路径上；用配置显式指到本应用目录
        File confDir = new File(prefix, "etc/apt/apt.conf.d");
        if (confDir.isDirectory()) {
            File conf = new File(confDir, "00-guncat-paths");
            String body = "Dir::Cache \"" + cacheAlias + "\";\n" +
                    "Dir::Cache::archives \"archives\";\n" +
                    "Dir::State::lists \"" + prefixAlias + "/var/lib/apt/lists\";\n";
            try {
                if (!conf.exists()) {
                    writeText(conf, body);
                }
            } catch (IOException e) {
                Log.w(TAG, "write apt conf failed: " + e.getMessage());
            }
        }
    }

    private static void writeText(File file, String text) throws IOException {
        OutputStream output = new FileOutputStream(file);
        try {
            output.write(text.getBytes(StandardCharsets.UTF_8));
        } finally {
            output.close();
        }
    }

    private boolean markerMatches() {
        File marker = new File(prefix, MARKER);
        if (!marker.isFile()) {
            return false;
        }
        try {
            byte[] bytes = new byte[(int) Math.min(marker.length(), 256)];
            try (InputStream input = new java.io.FileInputStream(marker)) {
                int read = input.read(bytes);
                if (read <= 0) {
                    return false;
                }
                return new String(bytes, 0, read, StandardCharsets.UTF_8).trim().equals(VERSION);
            }
        } catch (IOException e) {
            return false;
        }
    }

    private void writeMarker() throws IOException {
        writeText(new File(prefix, MARKER), VERSION + "\n");
    }

    private static boolean needsExecutable(String name) {
        // Termux 的 zip 不保留 Unix mode；按路径判断：bin/、libexec/、apt 的 helper/methods，
        // 以及 node/npm 这类把脚本放在 lib/.../bin/ 下的包（npm-cli.js 被 bin/npm 符号链接指向）。
        return name.startsWith("bin/") || name.startsWith("libexec/") ||
                name.contains("/bin/") ||
                name.startsWith("lib/apt/apt-helper") || name.startsWith("lib/apt/methods");
    }

    private static File safeChild(File base, String name) throws IOException {
        String clean = name.replace('\\', '/');
        while (clean.startsWith("/")) {
            clean = clean.substring(1);
        }
        if (clean.isEmpty()) {
            throw new IOException("空路径");
        }
        String[] parts = clean.split("/");
        for (String part : parts) {
            if (part.isEmpty() || ".".equals(part) || "..".equals(part)) {
                throw new IOException("非法路径: " + name);
            }
        }
        return new File(base, clean);
    }

    static void deleteRecursive(File file) {
        if (file == null || !file.exists()) {
            return;
        }
        // 符号链接只删链接自身：跟随它会递归删到链接指向的目录（可能是用户文件）
        try {
            if (java.nio.file.Files.isSymbolicLink(file.toPath())) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
                return;
            }
        } catch (Exception ignored) {
        }
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursive(child);
                }
            }
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }
}
