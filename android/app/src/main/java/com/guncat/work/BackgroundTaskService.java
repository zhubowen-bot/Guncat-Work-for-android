package com.guncat.work;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * 任务执行期间的前台保活服务。
 *
 * 为什么需要它（用户报障：任务一退到后台就容易失效）：
 * 本应用的全部业务都跑在 WebView 里，Activity 一退到后台就变成 cached 进程，
 * 系统随时可以冻结/回收，网络流式请求、内置终端的子进程、对话状态一起断掉。
 * 这里在任务开始/结束时由 JS 桥拉起/停止一个前台服务，并同时持有：
 *   · PARTIAL_WAKE_LOCK：熄屏后 CPU 仍可调度（否则 Doze 下能睡到任务超时）；
 *   · WIFI_MODE_FULL_HIGH_PERF：屏幕熄灭后不把 Wi-Fi 射频省电关掉；
 *   · 常驻通知：把进程提到前台服务优先级，避开 cached/App Standby 的冻结与回收。
 *
 * 服务本身不执行业务：WebView、GuncatServer、ShellManager 都在同一个应用进程里，
 * 进程活着它们就继续跑。服务被停止（任务结束/Activity 销毁）时释放全部锁。
 */
public class BackgroundTaskService extends Service {
    private static final String ACTION_START = "com.guncat.work.action.START_BACKGROUND_TASK";
    private static final String CHANNEL_ID = "guncat_background_task";
    private static final int NOTIFICATION_ID = 4301;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    /** startForeground 是否已经真正生效：JS 侧据此判断「通知出现了，可以发请求了」 */
    private static volatile boolean foreground = false;

    public static boolean isForeground() {
        return foreground;
    }

    /** JS 任务运行态的唯一入口：true 拉起，false 停止。 */
    public static void setTaskRunning(Context context, boolean running) {
        if (running) {
            Intent intent = new Intent(context, BackgroundTaskService.class);
            intent.setAction(ACTION_START);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } else {
            context.stopService(new Intent(context, BackgroundTaskService.class));
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, buildNotification());
        foreground = true;
        acquireLocks();
        // START_NOT_STICKY：服务重启时 WebView 已经不存在，重新拉起只会留一条
        // 「任务在跑」的假通知。任务本身靠前台优先级+唤醒锁保活，不靠重启。
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        foreground = false;
        releaseLocks();
        stopForeground(true);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createChannel() {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.bg_task_channel_name),
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(getString(R.string.bg_task_channel_desc));
        channel.setShowBadge(false);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        channel.enableVibration(false);
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(
                this,
                0,
                open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_guncat)
                .setContentTitle(getString(R.string.bg_task_title))
                .setContentText(getString(R.string.bg_task_text))
                .setContentIntent(content)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .build();
    }

    @SuppressWarnings("deprecation")
    private void acquireLocks() {
        if (wakeLock == null) {
            PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
            if (power != null) {
                wakeLock = power.newWakeLock(
                        PowerManager.PARTIAL_WAKE_LOCK, "Guncat:BackgroundTask");
                wakeLock.setReferenceCounted(false);
            }
        }
        if (wakeLock != null && !wakeLock.isHeld()) {
            // 任务结束由 JS 显式 stopService；这里故意不设超时，避免长任务跑到一半锁先过期。
            wakeLock.acquire();
        }
        if (wifiLock == null) {
            WifiManager wifi = (WifiManager) getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) {
                // API 29+ 用 LOW_LATENCY：这是给「屏幕熄灭后仍要持续传输」的场景准备的；
                // 旧的 FULL_HIGH_PERF 在部分新 ROM 上会被省电策略忽略。
                int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                        ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                        : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                wifiLock = wifi.createWifiLock(mode, "Guncat:BackgroundTask");
                wifiLock.setReferenceCounted(false);
            }
        }
        if (wifiLock != null && !wifiLock.isHeld()) {
            wifiLock.acquire();
        }
    }

    private void releaseLocks() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        wakeLock = null;
        if (wifiLock != null && wifiLock.isHeld()) {
            wifiLock.release();
        }
        wifiLock = null;
    }
}
