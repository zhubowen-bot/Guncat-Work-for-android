// 打包产物里启动/诊断脚本（.cmd / .ps1）的生成器 + 纯 ASCII 校验。
//
// 为什么把生成逻辑抽成模块：这些脚本的失败方式是**静默**的 —— 脚本本身写错了，
// 打包流程照样成功，用户双击后只看到 cmd 窗口一闪、或者一行
// "XX is not recognized"，而没有任何东西告诉他是脚本坏了。
// 抽出来之后，启动链路的无头验证（startup-check.mjs）可以直接断言生成的内容。
//
// 为什么必须纯 ASCII（踩过的坑，务必保留这段说明）：
//   cmd.exe 在中文 Windows 上按 GBK 解析批处理。文件里写 UTF-8 中文时，那些字节被解成
//   乱码，整行变成无法识别的命令，批处理的 if/goto 控制流直接被拆坏
//   （实测表现为 "'…' is not recognized"）。chcp 65001 放在文件里也救不了 ——
//   解析从第一行就开始了。PowerShell 5.1 对 .ps1 同理：按 ANSI 读，UTF-8 中文必然乱码。
//   所以这里做的是**字节级**校验（写盘后再读回来验），而不是「看起来没问题」。
//   中文说明一律放 使用说明.txt（UTF-8 带 BOM）。
import fs from 'node:fs'
import path from 'node:path'

/** 找出所有非 ASCII 字符的位置（用于把「哪个字符毁掉了脚本」说清楚） */
export function asciiViolations(text, label = 'script') {
  const violations = []
  const lines = String(text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    for (let j = 0; j < lines[i].length; j++) {
      const code = lines[i].charCodeAt(j)
      if (code > 0x7f) {
        violations.push({ label, line: i + 1, column: j + 1, code })
        break
      }
    }
  }
  return violations
}

/** 断言纯 ASCII，否则抛错并指出确切位置 */
export function assertAscii(text, label = 'script') {
  const violations = asciiViolations(text, label)
  if (violations.length > 0) {
    const v = violations[0]
    throw new Error(
      `${label} 含非 ASCII 字符（第 ${v.line} 行第 ${v.column} 列，码位 U+${v.code
        .toString(16)
        .toUpperCase()}）：cmd.exe 按 GBK、PowerShell 5.1 按 ANSI 解析，整行会变成非法命令`
    )
  }
  return text
}

/**
 * 以 latin1（= 逐字节）写出，并**在写盘之后把字节读回来再验一遍**。
 * 两道校验的理由：源码是 ASCII 不代表落盘是 ASCII（编码参数写错、编辑器插了 BOM 都会破功）。
 */
export function writeAsciiFile(file, text) {
  assertAscii(text, path.basename(file))
  fs.writeFileSync(file, Buffer.from(text, 'latin1'))
  const bytes = fs.readFileSync(file)
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] > 0x7f) {
      throw new Error(
        `${path.basename(file)} 落盘后第 ${i} 个字节是 0x${bytes[i].toString(16)}（非 ASCII）`
      )
    }
  }
  return file
}

/**
 * 兼容模式启动器（不提权）。
 *
 * 事故：默认启动（渲染进程带沙箱）在部分 Windows 机器上起不来 —— 但根因（见
 * docs/STARTUP-TROUBLESHOOTING.md）不是渲染进程，而是沙箱下 Chromium 建不出 GPU 子进程，
 * fallback 耗尽后主进程执行 LOG(FATAL)「GPU process isn't usable. Goodbye.」自杀
 * （STATUS_BREAKPOINT / 退出码 -2147483645）。
 *
 * 结论：只有 --no-sandbox 能改变结果。现在它已经是 win32 打包态的默认启动方式
 * （src/main/index.ts 会自我重启一次把真实参数带上），这个入口只是给用户的显式入口，
 * 顺带在「自我重启因为某种原因没生效」时兜底。
 */
export function buildRunCompatCmd(appName, switches) {
  return (
    [
      '@echo off',
      'cd /d "%~dp0"',
      `start "" "${appName}.exe" ${switches.join(' ')}`,
      'exit /b 0'
    ].join('\r\n') + '\r\n'
  )
}

/**
 * 自提权启动器 —— 最后的逃生口，不是默认路径。
 *
 * 调查结论（docs/STARTUP-TROUBLESHOOTING.md §5）：原先「提权才好」的判断是**变量未分离**
 * 造成的 —— 这个入口同时做了提权**和**加参数，而真正起作用的是参数（--no-sandbox）。提权的作用至今未获证实，
 * 因此它只作为「--no-sandbox 也不管用」时的最后手段保留。
 *
 * 实现要点：
 *   · Start-Process -Verb RunAs 才会触发 UAC；普通 Start-Process 不会。
 *   · 路径经 Join-Path 拼（目录里有空格），-WorkingDirectory 显式给上
 *     （提权进程的默认工作目录会变成 System32）。
 *   · -Command 里只用单引号，整段包在双引号里，cmd 不需要做任何转义。
 */
export function buildRunAsAdminCmd(appName, switches) {
  const argList = switches.map((flag) => `'${flag}'`).join(',')
  return (
    [
      '@echo off',
      'setlocal',
      'cd /d "%~dp0"',
      'rem Escape hatch: start Guncat Work with administrator rights (UAC).',
      'rem NOT the normal path - --no-sandbox is what actually fixes the crash.',
      'rem ASCII only - see scripts/launch-scripts.mjs for why.',
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -Verb RunAs -WorkingDirectory (Get-Location).Path -FilePath (Join-Path (Get-Location).Path '${appName}.exe') -ArgumentList ${argList}"`,
      'if errorlevel 1 goto failed',
      'exit /b 0',
      ':failed',
      'echo.',
      'echo Could not start with administrator rights.',
      'echo The UAC prompt may have been declined, or PowerShell is unavailable.',
      'echo Try run-compat.cmd first - it does not need elevation.',
      'echo.',
      'pause',
      'exit /b 1',
      ''
    ].join('\r\n')
  )
}

/**
 * 让「双击 exe 即可用」被固化到产物里（而不是只存在于某台机器的注册表里）。
 *
 * 背景（本机实测，变量已分离）：
 *   同样一份产物、同样带 --no-sandbox：
 *     管理员身份运行 → 完全成功（DOM 就绪 / 加载完成 / React 已挂载 / 首帧已产出）
 *     非管理员双击   → 完全没反应，而且**启动日志里没有新记录**
 *   启动日志是 main 的第一条语句写的，所以非管理员那次连第一行 JS 都没跑到 ——
 *   失败在「进程能不能起来」这一层，而非 Chromium 内部。根因尚未查明。
 *
 * 在这种前提下，最可靠的做法是给这个 exe 挂上 Windows 的 RUNASADMIN 兼容性层：
 * 之后普通双击就会弹一次 UAC 并以提权身份运行（等价于右键「以管理员身份运行」）。
 *
 * 为什么必须做成脚本而不是口头说明：
 *   该设置存在 HKCU 里、并且**按 exe 的完整路径**匹配。
 *   一旦把文件夹挪位置、或者拷给别人，设置就失效 —— 用户会以为是我们修坏了。
 *
 * 代价：每次启动都会弹一次 UAC。等非管理员失败的根因查清后，这个脚本就该退休。
 */
export function buildEnableAdminCmd(appName) {
  return (
    [
      '@echo off',
      'setlocal',
      'cd /d "%~dp0"',
      'rem Make a plain double-click of the exe ask for elevation (one UAC prompt).',
      'rem Needed because this build does NOT start when launched unelevated, and the',
      'rem reason is still unknown. Remove it with disable-admin-mode.cmd once fixed.',
      'rem ASCII only - see scripts/launch-scripts.mjs for why.',
      'set "EXE=%~dp0' + appName + '.exe"',
      'set "KEY=HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers"',
      'reg add "%KEY%" /v "%EXE%" /t REG_SZ /d "~ RUNASADMIN" /f >nul',
      'if errorlevel 1 goto failed',
      'echo.',
      'echo Done. Double-clicking "%EXE%" will now show a UAC prompt',
      'echo and start with administrator rights.',
      'echo.',
      'echo Note: this is tied to that exact path. If you move this folder,',
      'echo run this script again.',
      'echo To undo it, run disable-admin-mode.cmd',
      'pause',
      'exit /b 0',
      ':failed',
      'echo.',
      'echo Could not write the registry key. Nothing was changed.',
      'pause',
      'exit /b 1',
      ''
    ].join('\r\n')
  )
}

/** 撤销上面那个兼容性层（还原成普通双击） */
export function buildDisableAdminCmd(appName) {
  return (
    [
      '@echo off',
      'setlocal',
      'cd /d "%~dp0"',
      'rem Undo enable-admin-mode.cmd.',
      'rem ASCII only - see scripts/launch-scripts.mjs for why.',
      'set "EXE=%~dp0' + appName + '.exe"',
      'set "KEY=HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers"',
      'reg delete "%KEY%" /v "%EXE%" /f >nul 2>&1',
      'echo.',
      'echo Done. "%EXE%" will no longer ask for elevation.',
      'echo If it does not start that way, run enable-admin-mode.cmd again.',
      'pause',
      'exit /b 0',
      ''
    ].join('\r\n')
  )
}

/**
 * 生成桌面快捷方式。
 *
 * 为什么补这个：release 里的「使用说明.txt」一直让用户双击
 * create-desktop-shortcut.cmd，但**产物里从来没有这个文件** ——
 * 说明让人去找一个不存在的脚本，用户只会以为打包坏了。
 *
 * 实现用 PowerShell 的 WScript.Shell COM（Windows 上唯一稳定的建快捷方式方式），
 * 图标指向随包资源里的 app-icon.ico（与主进程给窗口设的图标同源）。
 * 仍然只写 ASCII：cmd.exe 在中文 Windows 上按 GBK 解析批处理，中文提示会把控制流拆坏。
 */
export function buildDesktopShortcutCmd(appName) {
  return (
    [
      '@echo off',
      'setlocal',
      'cd /d "%~dp0"',
      'rem Create a desktop shortcut for this portable folder.',
      'rem The shortcut target must be the absolute path of the exe here.',
      'rem ASCII only - see scripts/launch-scripts.mjs for why.',
      'set "EXE=%~dp0' + appName + '.exe"',
      'set "ICO=%~dp0resources\\resources\\app-icon.ico"',
      'if not exist "%EXE%" goto noexe',
      'rem One single PowerShell line on purpose: no caret line-continuation, because',
      'rem that is exactly the kind of batch parsing the ASCII/quoting rules guard against.',
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([IO.Path]::Combine([Environment]::GetFolderPath(\'Desktop\'),\'' +
        appName +
        '.lnk\')); $s.TargetPath=\'%EXE%\'; $s.WorkingDirectory=\'%~dp0\'; if (Test-Path \'%ICO%\') { $s.IconLocation=\'%ICO%\' }; $s.Save()"',
      'if errorlevel 1 goto failed',
      'echo.',
      'echo Done. A "' + appName + '" shortcut is now on your desktop.',
      'echo It points at: "%EXE%"',
      'echo Note: if you move this folder, run this script again.',
      'pause',
      'exit /b 0',
      ':noexe',
      'echo.',
      'echo Cannot find "%EXE%". Keep this script next to the exe.',
      'pause',
      'exit /b 1',
      ':failed',
      'echo.',
      'echo Could not create the shortcut. Nothing was changed.',
      'pause',
      'exit /b 1',
      ''
    ].join('\r\n')
  )
}

/**
 * 诊断阶梯：一轮一档，每轮独立用户数据目录，一次跑完就能回答两个问题 ——
 * 「哪一档才真的可用」以及「这一档究竟卡在哪一步」。
 *
 * 档位设计依据（14 组对照实验）：
 *   只有 --no-sandbox 能改变结果；其余开关单独使用一律照崩。
 *   所以第一档就是它（也是现在的默认启动方式），--disable-gpu 只在第二档作为兜底出现。
 *
 * 两档刻意做「对照」，它们预期是**失败**的，用来证明结论：
 *   · sandbox-on：显式保留沙箱（--guncat-keep-sandbox 抑制应用自我重启）→ 预期复现
 *     退出码 -2147483645。装上无条件带 --no-sandbox 之后，这是唯一还能复现根因的路径，
 *     而这正是排查「为什么只有这份产物建不出 GPU 子进程」所需要的。
 *   · white-screen：老的三参数组合。--disable-gpu 关掉 GPU 后 Chromium 会退回软件光栅化，
 *     再关掉软件光栅化就一个像素都画不出来 → 预期「加载完成但画不出帧」。
 */
export const DIAG_MODES = [
  { name: 'no-sandbox', args: ['--no-sandbox'], expect: 'pass' },
  { name: 'no-sandbox-no-gpu', args: ['--no-sandbox', '--disable-gpu'], expect: 'pass' },
  { name: 'normal', args: [], expect: 'pass' },
  { name: 'sandbox-on', args: ['--guncat-keep-sandbox'], expect: 'crash' },
  {
    name: 'white-screen-control',
    args: ['--no-sandbox', '--disable-gpu', '--disable-software-rasterizer'],
    expect: 'blank'
  },
  { name: 'diag-page', args: ['--guncat-diag', '--no-sandbox'], expect: 'pass' }
]

/** 主进程写进启动日志的 ASCII 里程碑标记（bootlog.ts 的 bootMark） */
export const DIAG_MARKERS = {
  domReady: 'RENDERER_DOM_READY',
  finishLoad: 'RENDERER_FINISH_LOAD',
  mounted: 'REACT_MOUNTED',
  painted: 'FRAME_PAINTED',
  stalled: 'RENDERER_STALLED',
  preloadError: 'RENDERER_PRELOAD_ERROR',
  reactError: 'REACT_ERROR',
  autoDegrade: 'AUTO_DEGRADE',
  /** 应用自我重启过（为了把 --no-sandbox 放到真实命令行上） */
  relaunch: 'BOOT_RELAUNCH_NO_SANDBOX',
  /** --no-sandbox 最终是否生效 */
  sandboxState: 'SANDBOX_STATE'
}

/**
 * diagnose.ps1：逐轮启动、每轮独立用户数据目录，并把「走到哪一步」判定出来。
 *
 * 用 PowerShell 而不是批处理的原因（沿用上一版的结论）：
 *   批处理没有超时、拿不到进程存活状态、也不好逐轮隔离环境。
 * 每轮给独立 --user-data-dir 的原因（真实事故）：
 *   共用同一份用户数据时，第一轮留下的单实例锁直接让第二轮启动失败
 *   （Lock file can not be created），于是最该验证的那一轮根本没跑成。
 */
export function buildDiagnosePs1({ appName, modes = DIAG_MODES, markers = DIAG_MARKERS }) {
  const modeTable = modes
    .map((mode, index) => {
      const argList = mode.args.map((a) => `'${a}'`).join(', ')
      const tail = index === modes.length - 1 ? '' : ','
      const expect = mode.expect ?? 'unknown'
      return `  @{ Name = '${mode.name}'; Expect = '${expect}'; Args = @(${argList}) }${tail}`
    })
    .join('\r\n')

  return (
    [
      '# Guncat Work diagnostics. ASCII only (see scripts/launch-scripts.mjs).',
      '# Runs the app once per mode, each with its own --user-data-dir, then reads the',
      '# boot log markers to tell HOW FAR the app got. Every failure looks the same to',
      '# the user (a blank window or a flash); the markers decide which one it is.',
      '#',
      '# Two modes are deliberate controls that are EXPECTED to fail:',
      '#   sandbox-on           reproduces the original crash (keep the sandbox on)',
      '#   white-screen-control the old 3-flag combo that painted nothing',
      "$ErrorActionPreference = 'Continue'",
      'Set-Location -LiteralPath $PSScriptRoot',
      `$exe = Join-Path $PSScriptRoot '${appName}.exe'`,
      `$procName = '${appName}'`,
      "$log = Join-Path $PSScriptRoot 'diag-log.txt'",
      "$bootLog = Join-Path $env:APPDATA 'Guncat Work\\logs\\startup.log'",
      'Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue',
      '',
      'function Write-Log($text) { Add-Content -LiteralPath $log -Value $text -Encoding UTF8 }',
      'function Get-BootLines() {',
      '  if (-not (Test-Path -LiteralPath $bootLog)) { return @() }',
      '  return @(Get-Content -LiteralPath $bootLog -Encoding UTF8 -ErrorAction SilentlyContinue)',
      '}',
      'function Has-Marker($lines, $marker) {',
      '  foreach ($line in $lines) { if ($line.Contains($marker)) { return $true } }',
      '  return $false',
      '}',
      'function Show-Marker($lines, $marker) { if (Has-Marker $lines $marker) { return "YES" } else { return "NO" } }',
      '# The app writes its Chromium log under <user-data-dir>\\logs; fall back to the',
      '# two APPDATA locations in case --user-data-dir was not honoured.',
      'function Get-ChromiumLog($udd) {',
      '  $candidates = @(',
      "    (Join-Path $udd 'logs\\chromium.log'),",
      "    (Join-Path $env:APPDATA 'Guncat Work\\logs\\chromium.log'),",
      "    (Join-Path $env:APPDATA 'Guncat Work-compat\\logs\\chromium.log')",
      '  )',
      '  foreach ($candidate in $candidates) {',
      '    if (Test-Path -LiteralPath $candidate) { return $candidate }',
      '  }',
      '  return ""',
      '}',
      '# One round may consist of several processes: the app relaunches itself once to',
      '# put --no-sandbox on the real command line, then exits. Follow it instead of',
      '# measuring the short-lived parent.',
      '#',
      '# ExitCode note: in Windows PowerShell 5.1, Start-Process -PassThru returns an',
      '# object whose ExitCode stays empty (WaitForExit / Refresh / Wait-Process do not',
      '# help either - only -Wait does, and that has no timeout). The exit code is the',
      '# single most valuable piece of evidence here (-2147483645 = STATUS_BREAKPOINT),',
      '# so the app is started through System.Diagnostics.Process instead.',
      'function Start-App($exePath, $arguments) {',
      '  $psi = New-Object System.Diagnostics.ProcessStartInfo',
      '  $psi.FileName = $exePath',
      '  # Quote only what needs quoting: paths in the product directory contain spaces,',
      '  # while plain switches must stay untouched.',
      '  $psi.Arguments = (($arguments | ForEach-Object { if ($_ -match \'[\\s"]\') { \'"\' + $_ + \'"\' } else { $_ } }) -join \' \')',
      '  $psi.UseShellExecute = $false',
      '  return [System.Diagnostics.Process]::Start($psi)',
      '}',
      'function Wait-ForApp($first, [int]$maxGenerations) {',
      '  $generation = 0',
      '  $current = $first',
      '  $codes = @()',
      '  while ($generation -lt $maxGenerations) {',
      '    $waited = 0',
      '    while (-not $current.HasExited -and $waited -lt 50) { Start-Sleep -Milliseconds 500; $waited++ }',
      '    if (-not $current.HasExited) { break }',
      '    try { $codes += $current.ExitCode } catch { $codes += "unknown" }',
      '    $generation++',
      '    if ($generation -ge $maxGenerations) { break }',
      '    Start-Sleep -Milliseconds 1500',
      '    $next = Get-Process -Name $procName -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $current.Id } | Select-Object -First 1',
      '    if ($null -eq $next) { break }',
      '    Write-Log ("  successor process picked up (pid " + $next.Id + ") - the app relaunched itself to add --no-sandbox")',
      '    $current = $next',
      '  }',
      '  return @{ Process = $current; Codes = $codes }',
      '}',
      '',
      '$modes = @(',
      modeTable,
      ')',
      '',
      'Write-Log \'===== Guncat Work diagnostics =====\'',
      "Write-Log ('time: ' + (Get-Date).ToString('s'))",
      "Write-Log ('os: ' + [System.Environment]::OSVersion.VersionString)",
      "Write-Log ('user: ' + $env:USERNAME)",
      "Write-Log ('elevated-check: ' + [bool]([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))",
      "Write-Log ('modes: ' + $modes.Count + ' (each with its own --user-data-dir)')",
      '',
      '$index = 0',
      'foreach ($mode in $modes) {',
      '  $index++',
      "  $udd = Join-Path $PSScriptRoot ('.udd-' + $index)",
      '  Remove-Item -LiteralPath $udd -Recurse -Force -ErrorAction SilentlyContinue',
      '  Remove-Item -LiteralPath $bootLog -Force -ErrorAction SilentlyContinue',
      '',
      "  Get-Process -Name $procName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue",
      '  Start-Sleep -Milliseconds 800',
      '',
      '  Write-Log \'\'',
      "  Write-Log ('========== [' + $index + '/' + $modes.Count + '] ' + $mode.Name + ' ==========')",
      "  Write-Log ('args: ' + ($mode.Args -join ' '))",
      "  Write-Log ('expected: ' + $mode.Expect)",
      "  Write-Host ('[' + $index + '/' + $modes.Count + '] ' + $mode.Name)",
      '',
      "  $argList = @($mode.Args) + @(('--user-data-dir=' + $udd), '--enable-logging')",
      '',
      '  # The app writes its own Chromium log (--log-file, under <user-data-dir>\\logs),',
      '  # so there is no need to capture stdout/stderr here - and not redirecting keeps',
      '  # the exit code readable, which is what actually matters.',
      '  $proc = Start-App $exe $argList',
      '',
      '  # One round may take several processes: the app relaunches itself once to put',
      '  # --no-sandbox on the real command line, then exits. Follow the successor.',
      '  $outcome = Wait-ForApp $proc 3',
      '  $proc = $outcome.Process',
      "  Write-Log ('processes seen: ' + ($outcome.Codes.Count) + ' exit code(s): ' + ($outcome.Codes -join ', '))",
      '  foreach ($code in $outcome.Codes) {',
      "    if ($code -eq -2147483645) { Write-Log 'NOTE: STATUS_BREAKPOINT - Chromium hit a fatal check (GPU process unusable)' }",
      '  }',
      '  if (-not $proc.HasExited) {',
      "    Write-Log 'STILL RUNNING after the wait - a window is probably up. Closing it.'",
      '    $proc | Stop-Process -Force -ErrorAction SilentlyContinue',
      '    Start-Sleep -Milliseconds 500',
      '  }',
      '',
      '  $lines = Get-BootLines',
      "  $dom = Show-Marker $lines '" + markers.domReady + "'",
      "  $loadDone = Show-Marker $lines '" + markers.finishLoad + "'",
      "  $mounted = Show-Marker $lines '" + markers.mounted + "'",
      "  $painted = Show-Marker $lines '" + markers.painted + "'",
      "  Write-Log ('markers: dom-ready=' + $dom + ' load-done=' + $loadDone + ' react-mounted=' + $mounted + ' frame-painted=' + $painted)",
      "  Write-Log ('sandbox: ' + (Show-Marker $lines '" + markers.sandboxState + "') + ' relaunched-by-app=' + (Show-Marker $lines '" + markers.relaunch + "'))",
      '',
      "  if ($dom -eq 'NO') {",
      "    Write-Log 'VERDICT: the app never reached dom-ready -> the page never loaded. Compare with the chromium log below.'",
      "  } elseif ($mounted -eq 'NO') {",
      "    Write-Log 'VERDICT: page loaded but React never mounted -> the UI bundle did not run. Check [RENDERER_PRELOAD_ERROR] and [REACT_ERROR] lines, and the console lines.'",
      "  } elseif ($painted -eq 'NO') {",
      "    Write-Log 'VERDICT: React mounted but no frame was produced -> the compositor cannot paint (blank window although the DOM is fine).'",
      '  } else {',
      "    Write-Log 'VERDICT: loaded + mounted + painted -> the whole pipeline works in this mode. If it is still blank, the issue is in the interface content, not the plumbing.'",
      '  }',
      '',
      "  if (Has-Marker $lines '" + markers.preloadError + "') { Write-Log 'NOTE: preload failed in this mode (see [RENDERER_PRELOAD_ERROR] in the boot log).' }",
      "  if (Has-Marker $lines '" + markers.reactError + "') { Write-Log 'NOTE: React reported an error in this mode (see [REACT_ERROR] in the boot log).' }",
      "  if (Has-Marker $lines '" + markers.stalled + "') { Write-Log 'NOTE: the renderer-ready watchdog fired in this mode.' }",
      "  if (Has-Marker $lines '" + markers.autoDegrade + "') { Write-Log 'NOTE: the app degraded itself during this round; the log may belong to the restarted process.' }",
      '',
      '  # The Chromium log is where the sandbox/GPU story lives. Look for the exact',
      '  # signature the crash dumps gave us. The apostrophe is doubled for PowerShell.',
      '  $chromium = Get-ChromiumLog $udd',
      '  if ($chromium -ne "") {',
      "    Write-Log ('chromium log: ' + $chromium)",
      "    Copy-Item -LiteralPath $chromium -Destination (Join-Path $PSScriptRoot ('chromium-' + $index + '.log')) -Force -ErrorAction SilentlyContinue",
      "    $gpuDead = Select-String -LiteralPath $chromium -SimpleMatch -Pattern 'GPU process isn''t usable' -ErrorAction SilentlyContinue | Select-Object -First 1",
      "    $gpuLaunch = Select-String -LiteralPath $chromium -SimpleMatch -Pattern 'GPU process launch failed' -ErrorAction SilentlyContinue | Select-Object -First 1",
      '    if ($null -ne $gpuDead) {',
      "      Write-Log 'CONFIRMED: Chromium declared the GPU process unusable and killed the main process -> this mode cannot work.'",
      '    }',
      '    if ($null -ne $gpuLaunch) {',
      "      Write-Log 'CONFIRMED: the GPU process failed to launch in this mode (sandbox / subprocess creation).'",
      '      Write-Log ("  " + $gpuLaunch.Line.Trim())',
      '    }',
      '    if (($null -eq $gpuDead) -and ($null -eq $gpuLaunch)) {',
      "      Write-Log 'the chromium log has no GPU-launch failure line in this mode.'",
      '    }',
      '  } else {',
      "    Write-Log 'NOTE: no chromium log found for this round (the process may have died before logging started).'",
      '  }',
      '',
      '  if (Test-Path -LiteralPath $bootLog) {',
      "    Copy-Item -LiteralPath $bootLog -Destination (Join-Path $PSScriptRoot ('startup-' + $index + '.log')) -Force -ErrorAction SilentlyContinue",
      "    $tail = Get-Content -LiteralPath $bootLog -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -Last 6",
      "    Write-Log 'boot log tail:'",
      "    foreach ($line in $tail) { Write-Log ('  ' + $line) }",
      '  }',
      '}',
      '',
      'Write-Log \'\'',
      "Write-Log '===== done ====='",
      "Write-Log 'Read this as a ladder: the first mode whose VERDICT says mounted+painted is'",
      "Write-Log 'the weakest set of switches that still works on this machine.'",
      "Write-Log 'sandbox-on is the control that reproduces the original crash;'",
      "Write-Log 'white-screen-control is the control that produced a blank window.'",
      'Write-Host \'\'',
      "Write-Host 'Done. Send these files:'",
      "Write-Host ('  diag-log.txt, startup-1..' + $modes.Count + '.log, chromium-1..' + $modes.Count + '.log')",
      "Write-Host ('  and ' + $bootLog)",
      ''
    ].join('\r\n')
  )
}
