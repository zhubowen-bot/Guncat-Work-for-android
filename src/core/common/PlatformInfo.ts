// 运行平台提示：让共享的 PromptBuilder / HarnessTools 在 Android 上生成正确的
// 「命令该用哪种语法」的说明，而不是一律按 Windows cmd 写。
//
// 默认值为空（桌面端保持既有提示）；Android 宿主在启动时调用 setShellPlatform('android')。
// 这里只存一个字符串，不依赖任何平台 API，core 仍可被桌面/鸿蒙复用。
let shellPlatform: string = '';

export function setShellPlatform(platform: string): void {
  shellPlatform = platform;
}

export function isAndroidShell(): boolean {
  return shellPlatform === 'android';
}

/** 追加到 run_command 描述 / 系统提示里的平台说明；非 Android 返回空串 */
export function shellPlatformNote(): string {
  if (!isAndroidShell()) {
    return '';
  }
  return (
    '\n**当前平台：Android（手机）**。run_command 执行的是随包内置的 Linux（bash），' +
    '不是 Windows cmd/PowerShell：请用 POSIX 命令 `pwd/ls/cat/grep/cp/mv/rm/which`，' +
    '路径分隔符用 `/`；不要用 `dir/type/copy/move/del/erase/findstr/where/cls` 或 PowerShell 语法。' +
    '不确定环境时先跑 `uname -a; pwd; ls`。工作目录就是本会话工作区，文件工具和终端看到的是同一批文件。'
  );
}
