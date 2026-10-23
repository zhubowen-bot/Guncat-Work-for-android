package com.guncat.work;

import android.content.Context;
import android.os.Build;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.Reader;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 真实命令执行 + 应用工作区落盘。
 *
 * 两个后端：
 *   1. bundled —— 随包内置的 Termux 用户态（bash + coreutils + apt 工具链）。
 *      首次启动解压到应用私有目录，不需要用户安装 Termux；执行前由 JS 层把 memfs
 *      工作区同步到真实目录，因此 ls / grep / tar 看到的就是智能体工作区里的文件。
 *   2. system —— /system/bin/sh（Android 自带的 mksh + toybox），内置终端不可用时的兜底。
 *
 * 进程输出用环形缓冲：超过上限从头丢，并把丢弃数量告诉 JS，避免模型跑 yes 时把 WebView 撑爆。
 * 全部方法都在 WebView 的 JS 线程被同步调用（@JavascriptInterface），不做跨线程等待。
 */
public final class ShellManager {
    private static final String TAG = "GuncatShell";

    /** 虚拟根：core 的 filesDir 在 Android 版就是 /guncat/data（见 src/mobile/boot.ts） */
    static final String VIRTUAL_ROOT = "/guncat/data";

    private static final int FS_LIST_LIMIT = 20000;

    private static ShellManager instance;

    private final Context context;
    private final File nativeRoot;
    private final File tempDir;
    private final TermuxBootstrap bootstrap;
    private final Map<String, Job> jobs = new ConcurrentHashMap<String, Job>();
    private final AtomicInteger seq = new AtomicInteger(0);

    ShellManager(Context context) {
        this.context = context.getApplicationContext();
        this.nativeRoot = new File(context.getFilesDir(), "guncat-data");
        this.tempDir = new File(nativeRoot, "temp");
        if (!nativeRoot.exists()) {
            //noinspection ResultOfMethodCallIgnored
            nativeRoot.mkdirs();
        }
        if (!tempDir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            tempDir.mkdirs();
        }
        this.bootstrap = new TermuxBootstrap(context);
        this.bootstrap.prepareAsync();
    }

    static synchronized void install(ShellManager manager) {
        instance = manager;
    }

    static synchronized ShellManager get() {
        return instance;
    }

    // ===== 给 JS 的能力探测 =====

    @JavascriptInterface
    public String info() {
        JSONObject out = new JSONObject();
        try {
            out.put("ok", true);
            out.put("virtualRoot", VIRTUAL_ROOT);
            out.put("nativeRoot", nativeRoot.getAbsolutePath());
            out.put("shell", "/system/bin/sh");
            out.put("sdk", Build.VERSION.SDK_INT);
            out.put("abi", Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "");
            out.put("bundled", new JSONObject(bootstrap.statusJson()));
        } catch (Exception e) {
            return err(e.getMessage());
        }
        return out.toString();
    }

    @JavascriptInterface
    public void reinstallBundled() {
        bootstrap.reinstall();
    }

    // ===== 启动命令 =====

    @JavascriptInterface
    public String start(String command, String virtualCwd, String envJson, int limitChars, String backend) {
        JSONObject out = new JSONObject();
        try {
            if (command == null || command.trim().isEmpty()) {
                throw new IllegalArgumentException("命令为空");
            }
            int limit = Math.max(4096, Math.min(limitChars <= 0 ? 256 * 1024 : limitChars, 4 * 1024 * 1024));
            String mode = backend == null ? "" : backend;
            if ("system".equals(mode)) {
                return startNative(command, virtualCwd, envJson, limit);
            }
            // bundled 是默认值；"termux" 是旧版本留在 localStorage 里的值，一并兼容
            return startBundled(command, virtualCwd, envJson, limit);
        } catch (Exception e) {
            try {
                out.put("ok", false);
                out.put("error", messageOf(e));
            } catch (Exception ignored) {
            }
            return out.toString();
        }
    }

    private String startNative(String command, String virtualCwd, String envJson, int limit) throws Exception {
        File cwd = ensureWorkDir(virtualCwd);
        ProcessBuilder builder = new ProcessBuilder("/system/bin/sh", "-c", command);
        builder.redirectErrorStream(true);
        builder.directory(cwd);
        Map<String, String> env = builder.environment();
        env.clear();
        env.put("PATH", "/system/bin:/system/xbin:/vendor/bin");
        env.put("HOME", nativeRoot.getAbsolutePath());
        env.put("PWD", cwd.getAbsolutePath());
        env.put("TMPDIR", tempDir.getAbsolutePath());
        env.put("TMP", tempDir.getAbsolutePath());
        env.put("LANG", "C.UTF-8");
        env.put("LC_ALL", "C.UTF-8");
        env.put("TERM", "dumb");
        env.put("NO_COLOR", "1");
        env.put("FORCE_COLOR", "0");
        env.put("GUNCAT_SHELL", "system");
        mergeEnv(env, envJson);
        // 这几个是执行语义的一部分，不允许被上层环境覆盖
        env.put("PATH", "/system/bin:/system/xbin:/vendor/bin");
        env.put("HOME", nativeRoot.getAbsolutePath());
        env.put("PWD", cwd.getAbsolutePath());
        env.put("TMPDIR", tempDir.getAbsolutePath());
        return launch(builder, cwd, virtualCwd, "system", limit);
    }

    /**
     * 随包内置的 Termux 用户态。bash 直接由 ProcessBuilder 拉起，不经过 /system/bin/sh；
     * 路径是构建期按等长规则改写过的，环境变量必须用别名路径（不是 files/usr）。
     */
    private String startBundled(String command, String virtualCwd, String envJson, int limit) throws Exception {
        if (!bootstrap.isReady()) {
            String progress = bootstrap.isInstalling()
                    ? "（正在解压内置终端，已解压 " + bootstrap.extracted() + " 个文件）" : "";
            String reason = bootstrap.error();
            throw new IllegalStateException("内置终端还没有就绪" + progress +
                    (reason.isEmpty() ? "，请稍后再试" : "：" + reason));
        }
        File cwd = ensureWorkDir(virtualCwd);
        String prefix = bootstrap.prefixPath();
        File bash = new File(bootstrap.prefixDir(), "bin/bash");
        if (!bash.isFile()) {
            throw new IOException("内置终端的 bash 不存在: " + bash.getAbsolutePath());
        }
        List<String> args = new ArrayList<String>();
        args.add(bash.getAbsolutePath());
        args.add("--noprofile");
        args.add("--norc");
        args.add("-c");
        args.add(command);
        ProcessBuilder builder = new ProcessBuilder(args);
        builder.redirectErrorStream(true);
        builder.directory(cwd);
        Map<String, String> env = builder.environment();
        env.clear();
        env.put("PREFIX", prefix);
        env.put("TERMUX_PREFIX", prefix);
        env.put("HOME", bootstrap.homePath());
        env.put("TMPDIR", prefix + "/tmp");
        env.put("TMP", prefix + "/tmp");
        env.put("PATH", prefix + "/bin:/system/bin:/system/xbin:/vendor/bin");
        env.put("LD_LIBRARY_PATH", prefix + "/lib");
        env.put("SHELL", prefix + "/bin/bash");
        env.put("LANG", "C.UTF-8");
        env.put("LC_ALL", "C.UTF-8");
        env.put("TERM", "dumb");
        env.put("NO_COLOR", "1");
        env.put("FORCE_COLOR", "0");
        env.put("GUNCAT_SHELL", "bundled");
        mergeEnv(env, envJson);
        // 覆盖上层传下来的宿主机路径（HOME 在 App 里是 /guncat/data，对 Linux 用户态无意义）
        env.put("PREFIX", prefix);
        env.put("TERMUX_PREFIX", prefix);
        env.put("HOME", bootstrap.homePath());
        env.put("TMPDIR", prefix + "/tmp");
        env.put("PATH", prefix + "/bin:/system/bin:/system/xbin:/vendor/bin");
        env.put("LD_LIBRARY_PATH", prefix + "/lib");
        env.put("SHELL", prefix + "/bin/bash");
        env.put("PWD", cwd.getAbsolutePath());
        return launch(builder, cwd, virtualCwd, "bundled", limit);
    }

    private File ensureWorkDir(String virtualCwd) throws IOException {
        File cwd = resolveVirtual(virtualCwd);
        if (!cwd.exists() && !cwd.mkdirs()) {
            throw new IOException("无法创建工作目录: " + virtualCwd);
        }
        if (!cwd.isDirectory()) {
            throw new IOException("工作目录不是文件夹: " + virtualCwd);
        }
        return cwd;
    }

    private String launch(ProcessBuilder builder, File cwd, String virtualCwd,
                          String backend, int limit) throws Exception {
        final Process process;
        try {
            process = builder.start();
        } catch (IOException e) {
            String name = "bundled".equals(backend) ? "内置终端" : "/system/bin/sh";
            throw new IOException("无法启动 " + name + ": " + e.getMessage());
        }
        String id = ("bundled".equals(backend) ? "b" : "s") + seq.incrementAndGet();
        final Job job = new Job(id, backend, limit);
        job.process = process;
        job.pid = pidOf(process);
        jobs.put(id, job);
        Thread reader = new Thread(new Runnable() {
            @Override
            public void run() {
                readProcess(process, job);
            }
        }, "guncat-shell-" + id);
        reader.setDaemon(true);
        reader.start();

        JSONObject out = new JSONObject();
        out.put("ok", true);
        out.put("id", id);
        out.put("pid", job.pid);
        out.put("backend", backend);
        out.put("cwd", virtualCwd);
        out.put("startedAt", job.startedAt);
        return out.toString();
    }

    private void readProcess(Process process, Job job) {
        Reader reader = null;
        try {
            reader = new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8);
            char[] buffer = new char[8192];
            int read;
            while ((read = reader.read(buffer)) >= 0) {
                if (read > 0) {
                    job.append(new String(buffer, 0, read));
                }
            }
        } catch (IOException e) {
            job.append("\n[读取进程输出失败: " + messageOf(e) + "]\n");
        } finally {
            if (reader != null) {
                try {
                    reader.close();
                } catch (IOException ignored) {
                }
            }
            int code;
            try {
                code = process.waitFor();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                code = -1;
            }
            job.finish(code, "");
        }
    }

    // ===== 读取 / 终止 =====

    @JavascriptInterface
    public String read(String id, int from) {
        JSONObject out = new JSONObject();
        Job job = jobs.get(id);
        if (job == null) {
            try {
                out.put("ok", false);
                out.put("error", "任务不存在或已释放");
            } catch (Exception ignored) {
            }
            return out.toString();
        }
        try {
            synchronized (job.lock) {
                int dropped = job.dropped;
                String data;
                int next;
                if (from < dropped) {
                    data = job.out.toString();
                    next = dropped + job.out.length();
                    out.put("gap", dropped - Math.max(0, from));
                } else {
                    int local = from - dropped;
                    if (local >= job.out.length()) {
                        data = "";
                    } else {
                        data = job.out.substring(local);
                    }
                    next = dropped + job.out.length();
                }
                out.put("ok", true);
                out.put("id", id);
                out.put("data", data);
                out.put("next", next);
                out.put("dropped", dropped);
                out.put("running", job.running);
                out.put("exitCode", job.exitCode);
                out.put("killed", job.killed);
                out.put("backend", job.backend);
                out.put("error", job.error);
                out.put("pid", job.pid);
            }
        } catch (Exception e) {
            return err(messageOf(e));
        }
        return out.toString();
    }

    @JavascriptInterface
    public void kill(String id) {
        Job job = jobs.get(id);
        if (job == null) {
            return;
        }
        job.killed = true;
        if (job.process != null && job.pid > 0) {
            killTree(job.pid);
            try {
                job.process.destroy();
            } catch (Exception ignored) {
            }
        }
        job.finish(-1, "");
    }

    @JavascriptInterface
    public void release(String id) {
        jobs.remove(id);
    }

    void shutdown() {
        List<String> ids = new ArrayList<String>(jobs.keySet());
        for (String id : ids) {
            kill(id);
        }
        jobs.clear();
    }

    // ===== 工作区镜像用的文件接口（只接受 /guncat/data 之内） =====

    @JavascriptInterface
    public String fsList(String virtualPath) {
        JSONObject out = new JSONObject();
        try {
            File base = resolveVirtual(virtualPath);
            JSONArray entries = new JSONArray();
            boolean[] truncated = new boolean[]{false};
            walk(base, base, entries, truncated);
            out.put("ok", true);
            out.put("entries", entries);
            out.put("truncated", truncated[0]);
        } catch (Exception e) {
            return err(messageOf(e));
        }
        return out.toString();
    }

    private void walk(File base, File dir, JSONArray entries, boolean[] truncated) {
        if (truncated[0]) {
            return;
        }
        File[] children = dir.listFiles();
        if (children == null) {
            return;
        }
        for (File child : children) {
            if (entries.length() >= FS_LIST_LIMIT) {
                truncated[0] = true;
                return;
            }
            // 不跟随符号链接：命令可以自己 ln -s，跟随会跑出沙箱或绕成环
            try {
                if (java.nio.file.Files.isSymbolicLink(child.toPath())) {
                    continue;
                }
            } catch (Exception ignored) {
            }
            String rel = relative(base, child);
            if (rel == null) {
                continue;
            }
            JSONArray item = new JSONArray();
            item.put(rel);
            if (child.isDirectory()) {
                item.put("d");
                item.put(0);
                item.put(child.lastModified());
                entries.put(item);
                walk(base, child, entries, truncated);
            } else if (child.isFile()) {
                item.put("f");
                item.put(child.length());
                item.put(child.lastModified());
                entries.put(item);
            }
        }
    }

    @JavascriptInterface
    public String fsRead(String virtualPath) {
        try {
            File file = resolveVirtual(virtualPath);
            if (!file.exists()) {
                return err("文件不存在: " + virtualPath);
            }
            if (!file.isFile()) {
                return err("不是文件: " + virtualPath);
            }
            if (file.length() > 32L * 1024 * 1024) {
                return err("文件超过 32MB，镜像不读取: " + virtualPath);
            }
            byte[] bytes = readAll(file);
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
            out.put("size", bytes.length);
            out.put("mtime", file.lastModified());
            return out.toString();
        } catch (Exception e) {
            return err(messageOf(e));
        }
    }

    @JavascriptInterface
    public String fsWrite(String virtualPath, String base64) {
        try {
            File file = resolveVirtual(virtualPath);
            File parent = file.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) {
                throw new IOException("无法创建目录: " + parent.getAbsolutePath());
            }
            byte[] bytes = Base64.decode(base64 == null ? "" : base64, Base64.DEFAULT);
            OutputStream output = new FileOutputStream(file);
            try {
                output.write(bytes);
            } finally {
                output.close();
            }
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("size", file.length());
            out.put("mtime", file.lastModified());
            return out.toString();
        } catch (Exception e) {
            return err(messageOf(e));
        }
    }

    @JavascriptInterface
    public String fsDelete(String virtualPath) {
        try {
            File file = resolveVirtual(virtualPath);
            deleteRecursive(file);
            JSONObject out = new JSONObject();
            out.put("ok", true);
            return out.toString();
        } catch (Exception e) {
            return err(messageOf(e));
        }
    }

    @JavascriptInterface
    public String fsMkdir(String virtualPath) {
        try {
            File file = resolveVirtual(virtualPath);
            if (!file.exists() && !file.mkdirs()) {
                throw new IOException("无法创建目录: " + virtualPath);
            }
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("mtime", file.lastModified());
            return out.toString();
        } catch (Exception e) {
            return err(messageOf(e));
        }
    }

    @JavascriptInterface
    public String fsStat(String virtualPath) {
        try {
            File file = resolveVirtual(virtualPath);
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("exists", file.exists());
            out.put("dir", file.isDirectory());
            out.put("size", file.isFile() ? file.length() : 0);
            out.put("mtime", file.exists() ? file.lastModified() : 0);
            return out.toString();
        } catch (Exception e) {
            return err(messageOf(e));
        }
    }

    // ===== 路径与杂项 =====

    private File resolveVirtual(String virtualPath) throws IOException {
        String normalized = normalizeVirtual(virtualPath == null ? VIRTUAL_ROOT : virtualPath);
        if (!normalized.equals(VIRTUAL_ROOT) && !normalized.startsWith(VIRTUAL_ROOT + "/")) {
            throw new IOException("路径越界（Shell 镜像只能访问 " + VIRTUAL_ROOT + "）: " + virtualPath);
        }
        String rel = normalized.length() == VIRTUAL_ROOT.length()
                ? "" : normalized.substring(VIRTUAL_ROOT.length() + 1);
        File file = new File(nativeRoot, rel);
        String root = nativeRoot.getCanonicalPath();
        String target = file.getCanonicalPath();
        if (!target.equals(root) && !target.startsWith(root + File.separator)) {
            throw new IOException("路径越界: " + virtualPath);
        }
        return file;
    }

    private static String normalizeVirtual(String path) {
        String input = path.replace('\\', '/');
        if (!input.startsWith("/")) {
            input = "/" + input;
        }
        String[] parts = input.split("/");
        List<String> stack = new ArrayList<String>();
        for (String part : parts) {
            if (part.isEmpty() || ".".equals(part)) {
                continue;
            }
            if ("..".equals(part)) {
                if (!stack.isEmpty()) {
                    stack.remove(stack.size() - 1);
                }
                continue;
            }
            stack.add(part);
        }
        StringBuilder out = new StringBuilder();
        for (String part : stack) {
            out.append('/').append(part);
        }
        return out.length() == 0 ? "/" : out.toString();
    }

    private static String relative(File base, File child) {
        try {
            String basePath = base.getCanonicalPath();
            String childPath = child.getCanonicalPath();
            if (!childPath.startsWith(basePath + File.separator)) {
                return null;
            }
            return childPath.substring(basePath.length() + 1).replace(File.separatorChar, '/');
        } catch (IOException e) {
            return null;
        }
    }

    private static byte[] readAll(File file) throws IOException {
        InputStream input = new FileInputStream(file);
        try {
            ByteArrayOutputStream output = new ByteArrayOutputStream((int) Math.min(file.length(), 1 << 20));
            byte[] buffer = new byte[16384];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        } finally {
            input.close();
        }
    }

    private static void deleteRecursive(File file) {
        if (!file.exists()) {
            return;
        }
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

    private static void mergeEnv(Map<String, String> env, String envJson) {
        if (envJson == null || envJson.trim().isEmpty()) {
            return;
        }
        try {
            JSONObject object = new JSONObject(envJson);
            java.util.Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (key == null || key.isEmpty() || key.indexOf('=') >= 0 || key.indexOf('\u0000') >= 0) {
                    continue;
                }
                String value = object.optString(key, "");
                if (value.indexOf('\u0000') >= 0) {
                    continue;
                }
                env.put(key, value);
            }
        } catch (Exception e) {
            Log.w(TAG, "env json invalid: " + e.getMessage());
        }
    }

    private static int pidOf(Process process) {
        try {
            Method method = Process.class.getMethod("pid");
            Object value = method.invoke(process);
            if (value instanceof Number) {
                return ((Number) value).intValue();
            }
        } catch (Exception ignored) {
        }
        return -1;
    }

    /** 从 /proc 递归找子进程再逐个发信号：光杀 sh 会留下一堆孙进程 */
    private static void killTree(int pid) {
        List<Integer> children = childPids(pid);
        for (Integer child : children) {
            killTree(child.intValue());
        }
        try {
            android.os.Process.sendSignal(pid, 9);
        } catch (Exception ignored) {
        }
    }

    private static List<Integer> childPids(int pid) {
        List<Integer> out = new ArrayList<Integer>();
        try {
            File file = new File("/proc/" + pid + "/task/" + pid + "/children");
            if (!file.exists()) {
                return out;
            }
            byte[] bytes = readAll(file);
            String text = new String(bytes, StandardCharsets.UTF_8).trim();
            if (text.isEmpty()) {
                return out;
            }
            for (String part : text.split("\\s+")) {
                try {
                    out.add(Integer.valueOf(Integer.parseInt(part)));
                } catch (NumberFormatException ignored) {
                }
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    private static String messageOf(Throwable error) {
        String message = error.getMessage();
        return message == null || message.isEmpty() ? error.getClass().getSimpleName() : message;
    }

    private static String err(String message) {
        JSONObject out = new JSONObject();
        try {
            out.put("ok", false);
            out.put("error", message == null ? "未知错误" : message);
        } catch (Exception ignored) {
        }
        return out.toString();
    }

    // ===== 任务 =====

    static final class Job {
        final String id;
        final String backend;
        final StringBuilder out = new StringBuilder();
        final Object lock = new Object();
        final int limit;
        final long startedAt = System.currentTimeMillis();
        int dropped = 0;
        boolean running = true;
        boolean killed = false;
        int exitCode = -1;
        String error = "";
        int pid = -1;
        Process process;

        Job(String id, String backend, int limit) {
            this.id = id;
            this.backend = backend;
            this.limit = limit;
        }

        void append(String text) {
            if (text == null || text.isEmpty()) {
                return;
            }
            synchronized (lock) {
                out.append(text);
                if (out.length() > limit) {
                    int cut = out.length() - limit;
                    out.delete(0, cut);
                    dropped += cut;
                }
                lock.notifyAll();
            }
        }

        int outLength() {
            synchronized (lock) {
                return out.length();
            }
        }

        void finish(int code, String message) {
            synchronized (lock) {
                exitCode = code;
                if (message != null && !message.isEmpty()) {
                    error = message;
                }
                running = false;
                lock.notifyAll();
            }
        }
    }
}
