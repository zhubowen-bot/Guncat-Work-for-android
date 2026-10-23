// CommandGuard: run_command 的危险判定（纯逻辑，不碰进程，可脱离真实执行做断言）
//
// 为什么需要它：模型写的命令是不可信输入，而「命令」这个工具面一旦被滥用的代价是删掉用户
// 磁盘上的东西 —— 不是回滚一次提交就能了事的。所以借鉴 dsh 的安全模型，把判定分成两档：
//   forbidden（硬禁）：毁灭性、不可逆、且没有任何理由交给智能体做的操作（格式化磁盘、关机、
//     fork 炸弹…）。这一档**不给审批入口**，直接拒绝并说明理由 ——
//     「用户手滑点了允许」本身就是一种必须防住的失败模式。
//   risky（需批准）：有破坏性但常常是正当需求（删文件、装包、git push、curl 下载…）。
//     默认档位下这类命令要走 AskUserBridge 人工批准，其余命令直接执行。
//
// 取向：**宁可多问一次，不可漏判一次**（漏判的代价是用户的数据）；
// 但硬禁表保持克制 —— 只放真正不可逆的系统级操作，否则「什么都禁」等于没有安全。
//
// 三层独立规则，缺一不可（三轮 AI 实测出的二十来类绕过整理出来的结构）：
//   关键词表（FORBIDDEN/RISKY）—— 但要**先看原文，再看还原后的文本**：cmd 的 ^、拆词的引号、
//     POSIX 的反斜杠在执行时都会消失，@ 前缀只是「别回显」，%ComSpec% 就是 cmd.exe 本身，
//     括号里那段是另起一次执行 —— 只看原文等于给每一种间接写法发一张免检票。
//   意图读不出（OPAQUE）—— 解释器内联代码、管道喂给解释器的 stdin、Base64 载荷、命令替换、
//     系统自带下载器、脚本宿主（cscript/wscript/mshta）。这类命令文本里天生就没有危险词，
//     靠关键词永远追不上，所以按「决定权交给了谁」一刀切。
//   位置越界（绝对路径 / .. 上跳 / 环境变量展开出的路径）—— 写法无关，是这三层里最硬的一层。
//
// 还有一条贯穿三层的约定：**「执行哪个文件」与「文件叫什么后缀」是两件事**。
// node/python 能跑 payload.txt，cscript 加 //E: 能把 .txt 当 VBS 跑，cmd 的 call 不认后缀 ——
// 脚本同审若只按后缀筛，改一个扩展名就等于把危险整个搬出了审阅范围（第三轮实测的 P0）。
//
// 归一化只做「去掉伪装」，从不补全或改写语义，所以派生文本只可能**多出**命中；
// 判定用的始终是「原文 ∪ 还原文 ∪ 拆出来的内层命令」，任何一层失配都还有另外两层兜着。

export class GuardVerdict {
  forbidden: boolean = false
  risky: boolean = false
  /** 命中的原因（给人看的短句，审批卡片里直接展示） */
  reasons: string[] = []
}

interface Rule {
  re: RegExp
  why: string
}

export class CommandGuard {
  // 审批粒度档位（会话元数据 commandPermission 的取值；空串按默认档处理）
  //
  // 档位改的是**由谁来判断**，而不是**要不要判断**：ask-risk 交给关键词表 + 人，auto 多一道模型审阅，
  // 只有 full-access 是真的把判断整个关掉。老版本里 'auto' 的含义是「危险命令也不问人」，
  // 那是完全权限而不是自动审批，语义已经搬到 'full-access'（见 SessionManager 的一次性迁移）。
  static readonly PERMISSION_ASK: string = 'ask'          // 每条命令都要人批准
  static readonly PERMISSION_ASK_RISK: string = 'ask-risk' // 默认: 危险命令要人批准
  static readonly PERMISSION_AUTO: string = 'auto'        // 自动审批: 危险命令先过模型, 拦下了才找人
  static readonly PERMISSION_FULL_ACCESS: string = 'full-access' // 完全权限: 不审不问, 只剩硬禁兜底
  static readonly PERMISSIONS: string[] = [
    CommandGuard.PERMISSION_ASK, CommandGuard.PERMISSION_ASK_RISK,
    CommandGuard.PERMISSION_AUTO, CommandGuard.PERMISSION_FULL_ACCESS
  ]

  private static readonly FORBIDDEN: Rule[] = [
    // 带盘符的写法早就有规则，`format C`（不带冒号）与 `format /FS:NTFS D:` 却没有 ——
    // 实测 `format D /q` 一路直通。只认「format 后面跟着单个字母的驱动器符号」，
    // 所以 `npm run format`、`format the diff` 这类日常写法不会被冤枉成格式化磁盘。
    { re: /\bformat\s+(?:\/\S+\s+)*[a-z]\b/i, why: '格式化磁盘' },
    { re: /\bmkfs(\.\w+)?\b/i, why: '格式化磁盘（mkfs）' },
    { re: /\bdiskpart\b/i, why: '磁盘分区操作' },
    { re: /\bdd\b[^\n|;]*\bof=\/dev\//i, why: 'dd 直接写裸设备' },
    { re: /physicaldrive/i, why: '直接写物理磁盘' },
    { re: /\b(?:shutdown|reboot|poweroff)\b/i, why: '关机/重启整台机器' },
    { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/i, why: 'fork 炸弹' },
    { re: /\brm\s+(?:-[^\s]*\s+)*\/(?:\*|\s|$)/i, why: '删除根目录' },
    // 「删主目录」只认主目录**本身**（含 `~/*` 这种整体通配，它由灾难目标层判）。
    // 原来的写法带 `\/` 一支，把 `rm -rf ~/projects` 这种「主目录底下的一个子目录」也说成
    // 「删除用户主目录」—— 硬禁没有审批入口，理由又写错了，属于最坏的一类误判（见 firstDisasterTarget）。
    { re: /\brm\s+(?:-[^\s]*\s+)*(?:~|\$HOME|%USERPROFILE%)(?:\s|[&;|]|$)/i, why: '删除用户主目录' },
    { re: /\bchmod\s+(?:-[^\s]*\s+)*777\s+\//i, why: '把系统目录改成全局可写' },
    { re: /\breg\s+delete\s+"?\s*hklm/i, why: '删除机器级注册表项' },
    { re: /\bbcdedit\b/i, why: '修改系统引导配置' },
    // macOS 上改启动卷的是 bless，跟 bcdedit 干同一件事（原先只登记了「bless 指向 /Volumes」这一种，
    // `bless --setboot /dev/disk1s1` 直通）。指错了分区就是重启起不来，智能体没有正当需求。
    { re: /(?:^|[\s;&|(])bless\b[^\n|;]*(?:--setboot|-setBoot|--boot-info|--quiet\s+--mount)/i,
      why: '改写 macOS 启动卷/引导信息（改坏后机器起不来）' },
    { re: /\bcipher\s+\/w\b/i, why: '擦除磁盘空闲空间' },
    // /R 与 /X 导出 EFS 恢复证书+私钥到文件：等于把「解密这台机器上所有受保护文件」的钥匙
    // 写到一个普通文件里，之后被谁读走都不知道（实测 cipher /x 静默执行）。
    // /E 只是加密，不改数据也不外泄，留在危险档。
    { re: /\bcipher\s+\/(?:r|x)/i, why: '导出 EFS 恢复密钥（等于交出这台机器所有受保护文件的钥匙）' },
    // 卷影副本是「删掉就没了」的那一类：还原点、系统状态备份、USN 日志被清之后，
    // 用户连回滚到自己没注意的那一刻都做不到（实测 vssadmin/wbadmin/fsutil 全不在表里）。
    { re: /\bvssadmin\b[^\n]*delete\s+shadows/i, why: '删除卷影副本（还原点不可恢复）' },
    { re: /\bwbadmin\b[^\n]*\bdelete\b/i, why: '删除系统状态备份/备份目录' },
    { re: /\bfsutil\b[^\n]*(?:setzerodata|deletejournal|deletevolume|volume\s+dismount|usn\s+deletejournal)/i, why: '抹掉文件内容、卷日志或卸载卷' },
    // —— 下面这几族是拿 destructive_command_guard 的规则包逐条比对现有词表后补的实测空洞
    //    （它的 pack 按「同一破坏动作的所有方言写法」组织，而我原先只登记了 POSIX 那一半）。
    //    共同根因：**破坏动作换了 API 名字就等于没登记**。PowerShell 的存储 cmdlet、磁盘工具、
    //    关机 cmdlet、WMI 版卷影删除全部零审批直通。
    { re: /\b(?:Format-Volume|Clear-Disk|Initialize-Disk|Reset-PhysicalDisk|Remove-(?:Partition|Volume|VirtualDisk|StoragePool|PhysicalDisk|SnapShot|IscsiTarget))\b(?![\w-])/i,
      why: '磁盘/卷级销毁（PowerShell 存储 cmdlet）' },
    // 分区表与卷管理工具：写坏一次就整盘不可读，智能体没有任何正当需求要动它们（只读形态一并算进来）。
    { re: /(?:^|[\s;&|(\\/])@?(?:wipefs|fdisk|cfdisk|sfdisk|parted|gdisk|cgdisk|sgdisk|mkswap|newfs|dmsetup|mdadm|lvm|lvremove|vgremove|vgreduce|pvremove|pvcreate|lvreduce|lvresize|lvconvert|vgexport|pvmove)(?:\.exe)?\b/i,
      why: '分区表/逻辑卷管理工具（改坏即整盘不可读）' },
    { re: /\b(?:zpool\s+destroy|zfs\s+(?:destroy|rollback)|diskutil\s+(?:erase\w*|reformat|partitionDisk)|hdiutil\s+erase|btrfs\s+(?:subvolume\s+delete|filesystem\s+(?:rm|delete)|device\s+(?:delete|remove))|logical\w*\s+(?:rmdir|dlvrm))\b/i,
      why: '销毁文件系统卷/镜像（ZFS、APFS、Btrfs 侧的同一件事）' },
    // 关机原先只有 shutdown|reboot|poweroff 三个词：PowerShell 的 cmdlet、systemctl 的另外几个目标、
    // 切运行级别与注销整台机器的写法都不在表里（实测 Stop-Computer、init 0 一路直通）。
    { re: /\b(?:Stop-Computer|Restart-Computer)\b|\b(?:systemctl|service)\s+(?:halt|poweroff|reboot)\b|\b(?:init|telinit)\s+[016]\b/i,
      why: '关机/重启/切换运行级别整台机器' },
    // 「把机器自身的防护关掉」这一整类原先一个字都没有：它删的不是用户的数据，而是**事后能看见什么**，
    // 而且智能体没有任何正当需求要做它（实测 Defender 豁免、防火墙总开关、审计策略清空全部直通）。
    { re: /\bSet-MpPreference\b[^\n|;]*(?:-Disable\w+|EnableControlledFolderAccess\s+Disabled)|\bAdd-MpPreference\b[^\n|;]*-Exclusion\w*|\bDisable(?:AntiSpyware|AntiVirus|RealtimeMonitoring|BehaviorMonitoring|IOAVProtection|OnAccessProtection|ScriptControlledFolderAccess|NetworkInspectionSystemMonitoring)\b/i,
      why: '关闭或豁免 Microsoft Defender 实时防护（把机器防护关掉）' },
    { re: /\bnetsh\s+(?:adv)?firewall\b[^\n|;]*(?:state\s+(?:off|disable)|opmode\s+disable|firewallpolicy\s+allow\s*,\s*allow)|\b(?:Set-NetFirewallProfile|Set-FirewallRule)\b[^\n|;]*-Enabled\s+\$?false|\bSet-Service\b[^\n|;]*(?:WinDefend|wscsvc|SecurityHealthService|mpssvc|SharedAccess|SgrmBroker|UsoSvc|ufas)[^\n|;]*(?:Disabled|Manual)|\bsc\b[^\n|;]*config[^\n|;]*(?:WinDefend|wscsvc|SecurityHealthService|mpssvc|SharedAccess|SgrmBroker)\b[^\n|;]*start=\s*(?:disabled|manual)/i,
      why: '关闭系统防火墙或停用安全服务' },
    // Clear-/Remove-EventLog 换成「清任意日志名」都算销毁现场：原先要求文本里出现 Security/Setup，
    // 结果 `Clear-EventLog -LogName System` 静默执行（实测）。Limit-EventLog 是改保留策略，落危险档。
    { re: /\bauditpol\s+\/(?:clear|set)\b|\bwevtutil\s+(?:cl|el)\s+(?:Security|Setup|ForwardedEvents|Microsoft-Windows-[\w-]+)(?:\s|$|")|\b(?:Clear-EventLog|Remove-EventLog)\b(?![\w-])|\bDisable-ComputerRestore\b/i,
      why: '清空审计/安全日志或关掉系统还原（销毁事后现场）' },
    { re: /\b(?:ntdsutil|secedit\s+\/(?:configure|import|export)|lpkcmdutil)\b|\bwevtutil\s+(?:sl|el)\s+(?:Security|Setup)\b/i,
      why: '改写系统安全策略/目录服务底层设置' },
    // 凭据库导出与 lsass 内存转储：拿到就等于整台机器的登录态，属于「无论如何不该由智能体做」。
    { re: /\breg\s+(?:save|export|load|restore)\s+"?\s*hklm\\(?:sam|security|system|components)\b|\bcomsvcs\.dll\b[^\n|;]*(?:MiniDump|DumpFull)|\b(?:mimikatz|sekurlsa|lsassdump|nanodump|ppldump|safetydump)\b|\b(?:procdump|createdump)\b[^\n|;]*lsass|\b(?:dpapi::\w+|masterkey|backupkey)\b|\bg-sepdi\b|\bninjaodump\b/i,
      why: '导出系统凭据库或转取 lsass 内存（登录态外泄）' },
    // 删卷影原先只认 vssadmin 那一种拼法：WMI/CIM 走的是同一个底层对象（实测两条直通）。
    // 对象名与方法之间常隔着管道（`Get-WmiObject Win32_ShadowCopy | ForEach-Object { $_.Delete() }`），
    // 所以这一段的间隔允许 `|`，只锁同一行、并限长，避免跨语句误伤。
    { re: /\bwmic\b[^\n|;]*shadowcopy[^\n|;]*\bdelete\b|Win32_ShadowCopy[^\n]{0,120}(?:Remove-WmiObject|Remove-CimInstance|\.Delete\s*\(|DeleteInstance)|\b(?:Remove-WmiObject|Remove-CimInstance)\b[^\n|;]*(?:ShadowCopy|RestorePoint|Backup)/i,
      why: '删除卷影副本（还原点不可恢复）' },
    // 同一个 API 换对象名就是另一件事：`wmic path Win32_LogicalDisk delete` 删的是卷本身
    // （实测只落到「wmic 是系统组件」那条危险规则，等于给了审批入口就放行）。
    // 读形态（get/list/where 查询）不在这一条里。
    { re: /\bwmic\b[^\n]*\b(?:logicaldisk|diskpartition|partition|volume|diskdrive|physicalmedia)\b[^\n]*\bdelete\b|Win32_(?:LogicalDisk|DiskPartition|Volume|DiskDrive|PhysicalMedia)\b[^\n]{0,80}(?:\bdelete\b|DeleteInstance|\.Delete\s*\(|Remove-(?:CimInstance|WmiObject))/i,
      why: '经 WMI 删除卷/分区对象（磁盘级销毁的另一种拼法）' },
    // WSL 的发行版根文件系统就是一块 vhdx：--unregister 直接把整块盘删掉，Linux 侧删光了也找不回。
    { re: /\bwsl(?:\.exe)?\s+(?:--unregister|-u\s+--unregister)\b|\bmanage-bde\b[^\n|;]*(?:-\s*off\b|-clearkey|-disableautounlock|-protectors\s+(?:-?delete|-disablekeyprotector)|-?pause)/i,
      why: '销毁 WSL 发行版文件系统或摘除 BitLocker 保护' },
    { re: /\buserdel\b[^\n|;]*\s-r\b|\bdeluser\b[^\n|;]*(?:--remove-home|--remove-all-files)|\bdscl\b[^\n|;]*-delete\s+\/Users\/|\bsysadminctl\b[^\n|;]*-deleteUser/i,
      why: '删除账号并连带删掉其主目录数据' },
    // —— 第十三轮：继续拿 destructive_command_guard 的 system.disk / windows 规则包逐条比对，
    //    补的是「根本不经过文件系统」的那一族：固件/控制器收到一条命令就把整块盘的块映射丢掉或
    //    覆盖掉，没有回收站、没有卷影副本、没有任何恢复工具能救。词表里原先只有 POSIX 的 mkfs/dd，
    //    换一个厂商工具名（blkdiscard / nvme / hdparm / cryptsetup）就等于没登记。
    // 尾部这个 `(?!\.\w)` 是给「文件名」留的路：`node guard-audit/wipe.js` 里的 wipe 只是一段
    // 文件名，不是要运行的 wipe 程序，但前缀字符类为了认 `tools\wipe` 把 `/` 也收了进来，
    // 于是 wipe.js / sdelete.py 这类**源码文件**会被判成「物理介质级擦除」直接硬禁（没有审批入口，
    // 用户连申诉的机会都没有 —— 硬禁误判比漏判更伤人）。`.exe` 由前一段显式吃掉，不受影响。
    { re: /(?:^|[\s;&|(\\/])@?(?:blkdiscard|nwipe|sg_format|sdelete|sdelete64|wipe|scrub)(?:\.exe)?\b(?!\.\w)/i,
      why: '物理介质级擦除（整块盘或空闲空间被覆盖，不可恢复）' },
    { re: /\bcryptsetup\b[^\n|;]*(?:luksFormat|luksErase|luksRemoveKey|luksKillSlot|\berase\b|\bremove\b)/i,
      why: '销毁 LUKS 加密卷头/密钥（卷内数据永久读不回）' },
    { re: /\bhdparm\b[^\n|;]*(?:--security-erase|--security-erase-enhanced|--make-bad-sector|--write-sector)/i,
      why: 'ATA 固件级安全擦除（整块盘不可恢复）' },
    { re: /\bnvme(?:\.exe)?\b[^\n|;]*\b(?:format|sanitize|delete-ns|write-zeroes)\b/i,
      why: 'NVMe 命名空间格式化/消毒（整块盘不可恢复）' },
    { re: /\bbadblocks\b[^\n|;]*\s-[a-zA-Z]*w/i,
      why: 'badblocks 写模式覆盖整块盘' },
    { re: /\b(?:tmutil\s+(?:deletelocalsnapshots|disablelocal|delete)|asr\s+(?:restore|delete)|hdiutil\s+erase)/i,
      why: '销毁 macOS 卷/快照/本地备份（不可恢复）' }
  ]

  private static readonly RISKY: Rule[] = [
    { re: /\b(?:rm|del|erase|rd|rmdir\d?|deltree|shred|unlink)\b/i, why: '删除文件/目录' },
    // 「动词后面跟的是什么」不能只认 `-` 开头：Windows 的开关是 `/y`、`/s`，
    // 按 `-` 登记就等于「同一个命令换个符号写法就免检」（实测 move /y 全程无卡，静默改名覆盖）。
    { re: /\b(?:mv|move)\b\s+[-\/\w."']/i, why: '移动/改名文件' },
    { re: /Remove-Item|Clear-Content|Clear-RecycleBin|Remove-ItemProperty|Remove-PSItem/i, why: 'PowerShell 删除' },
    // 覆盖写（不是新建）会让原内容不可恢复，与 del/mv 同一档；New-Item 这种「凭空建一个」不算。
    { re: /\b(?:Set-Content|Out-File|Add-Content)\b/i, why: 'PowerShell 覆盖写文件' },
    // Remove-Item 的官方别名是 ri/rmi，只收 rm/del/erase/rd 会漏掉它们（实测：ri -Recurse -Force 静默删整棵树）
    { re: /\b(?:powershell|pwsh)\b[^\n]*?\b(?:ri|rmi|rm|del|erase|rd|rmdir|ac|sc|si)\b/i, why: 'PowerShell 删除/改写别名' },
    // 走 .NET / 反射的写法不叫「del」也不叫「Remove-Item」，关键词表对它完全无感
    // （实测：@powershell -c "[IO.File]::WriteAllText(...)" 真实写出又删掉了一个文件）。
    { re: /\[(?:IO|System\.IO)\.(?:File|Directory|FileStream|Compression|Path)\]::|\[Scriptblock\]::Create|\bAdd-Type\b|\bNew-Object\b|\[Reflection\./i,
      why: '用 .NET/反射 API 读写文件或执行代码（危险动作不写在关键词里）' },
    { re: /\b(?:git|svn)\b[^\n|;]*(?:clean|reset\s+--hard|checkout|restore|filter-branch|push|rebase|ci|commit)/i, why: '版本库改写或对外推送' },
    // git 会把 `-c` 的配置值交给 sh 执行：`git -c core.fsmonitor="echo x > f" status` 实测真的写出了
    // 文件，而 `git status` 本身被判为安全——被拦住的两个变体只是因为载荷里恰好有 cmd/rm 这些词，
    // 说明拦的是关键词，不是「把程序名塞进配置」这个动作本身。同类注入面：--config-env、
    // npm --script-shell、tar --use-compress-program、git --exec-path/--ssh。
    { re: /\bgit\b[^\n|;]*\s-c\s+\S+=|\bgit\b[^\n|;]*\s--config(?:-env)?[=\s]/i,
      why: 'git 配置注入（-c / --config-env 的值会被 git 交给 shell 执行）' },
    // 只认「写进去一个值」的形态：`git config --get core.editor` 是读，不该打扰（键名后面没有值就不算写）。
    { re: /\bgit\b\s+config\b[^\n]*(?:fsmonitor|pager|editor|sshCommand|gitProxy|helper|hooksPath|alias\.)\s+\S/i,
      why: '写入会被 git 执行的配置项（之后任何一条普通 git 命令都会跑它）' },
    { re: /--(?:script-shell|use-compress-program|upload-pack|exec-path|editor|pager|signing-key)(?:[=\s]|$)/i,
      why: '把要运行的程序写进参数（命令行本身看不出真正跑的是什么）' },
    { re: /\b(?:setx|reg|schtasks|crontab|systemctl|service)\b/i, why: '改系统配置/计划任务/服务' },
    // 开机自启/系统启动项是教科书级的持久化：改完之后每次登录都会跑别人的代码。
    // `reg add` 本身只被上面那条泛化命中，这里给出**为什么**这条比普通改配置更要紧。
    // 开机自启这一条原先要求 `Run\` 带尾斜杠，而真实写法是 `reg add "HKLM\...\Run" /v Up /d evil.exe`
    // —— 斜杠后面接的是引号或空格，于是整个持久化门类静默直通（实测）。改成词边界。
    { re: /\breg\s+(?:add|import)\b[^\n|;]*(?:\\Run(?:Once)?\b|Appinit_Dlls|Winlogon\\(?:Shell|Userinit)|Image File Execution|\\Services\\|\\BootExecute|ShellExtensions\\IconOverlayIdentifiers)/i,
      why: '写入开机自启/系统启动项（持久化，之后每次登录都会执行）' },
    { re: /\b(?:Unregister|Register|Set|New|Remove|Enable|Disable)-ScheduledTask\b|\bschtasks\b[^\n|;]*\/(?:delete|change)\b|\bcrontab\s+-r\b|\blaunchctl\s+(?:unload|remove|bootout|disable|enable|submit)\b/i,
      why: '删除或改写计划任务/系统服务任务（crontab -r 会清掉这个用户的全部计划任务）' },
    // 账号与认证状态：删组/删用户/清空密码都不喊 del，关键词表看不见。
    { re: /\b(?:useradd|usermod|groupadd|groupdel|groupmod|deluser|adduser|chpasswd|grpck|pwconv)\b|\b(?:New|Remove|Rename|Set|Add|Disable|Enable)-Local(?:User|Group|GroupMember)\b|\bpsremoteuser\b|\bnet\s+localgroup\b[^\n|;]*\/delete/i,
      why: '改本地账号/组或批量改密码' },
    // sc 是服务控制命令的正式名字，net stop 有规则而它没有（实测：sc stop 静默执行）。
    // 只认「动词在后面」的调用形态，避免把 sc 这个词从路径或文件名里捞出来。
    { re: /(?:^|[\s;&|(/])sc(?:\.exe)?\s+(?:stop|start|delete|create|config|control|failure|description|pause|resume|qa|query)\b/i, why: '改系统服务（sc）' },
    { re: /\bnet\s+(?:user|localgroup|share|start|stop|config)\b|\bnetsh\b/i, why: '改账号/共享/网络配置' },
    { re: /\b(?:taskkill|killall|pkill)\b|Stop-Process|kill\s+-9/i, why: '杀进程' },
    { re: /\b(?:chmod|chown|icacls|takeown|cacls|runas|sudo|doas)\b/i, why: '改权限或以他人身份运行' },
    { re: /\b(?:npm|pnpm|yarn|bun|pip|pip3|gem|cargo)\b[^\n|;]*(?:-g|--global|install|uninstall|link)\b|\b(?:npx|choco|winget|brew)\b/i, why: '安装或运行外部包（会写到工作区之外）' },
    // npx 的别名家族：`npm exec`、`npm x`、`pnpm exec`、`pnpm dlx`、`yarn exec`、`yarn dlx`、
    // `bun x`、`bunx`、`pnpx` 做的是同一件事 —— 从 registry 取一个包并立刻把它跑起来，代码既不在
    // 命令行里，也没进脚本同审。上面那条只登记了 `npx` 这个**名字**，于是同一件事换个拼法就拿到
    // 免检票（实测 npx 判危险，而 npm exec / npm x / pnpm exec / pnpm dlx / yarn dlx / bun x / bunx
    // 七种写法全部零审批直通）。这是「命令名 vs 语义」的漏判，与 /y 和 -y 那条同源。
    { re: /\b(?:npm|pnpm|yarn|bun)\s+(?:exec|dlx|x)\b|\b(?:bunx|pnpx)\b/i,
      why: '从 registry 下载并直接执行包（npx 的别名：npm exec / pnpm dlx / bun x …）' },
    { re: /\b(?:curl|wget|Invoke-WebRequest|iwr)\b/i, why: '从网络下载' },
    { re: /\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\|\s*(?:powershell|pwsh|iex)\b|Invoke-Expression/i, why: '把网络内容直接管道给 shell 执行' },
    { re: /\b(?:docker|podman|kubectl)\b/i, why: '操作容器/集群' },
    { re: /\b(?:chkdsk|defrag)\b/i, why: '磁盘维护' },
    // /MOVE 与 /MIR 一样会删东西（搬走=源目录里没了），只是关键词表原先只盯了后两个。
    { re: /\brobocopy\b[^\n]*(?:\/MIR|\/PURGE|\/MOV)/i, why: '镜像同步（会删目标目录的差异文件）' },
    // 破坏文件不一定要说「del」。改名、拿空设备覆盖、静默复制过去，效果与删一次同样不可恢复
    // （实测 ren/type nul >/copy nul/copy /y/replace 全程无卡）。
    { re: /(?:^|[\s;&|(/])(?:ren|rename)(?:\.exe)?\s+[-\/\w."']/i, why: '移动/改名文件' },
    { re: /\b(?:type|more)\s+nul\s*>/i, why: '用空设备覆盖写文件（原内容不可恢复）' },
    { re: /\bcopy\s+nul\b/i, why: '清空或覆盖已存在的文件' },
    // 静默覆盖开关认全四种写法：cmd 那一侧是 /y，工具链那一侧是 -y / --force / --overwrite
    // （实测 xcopy /y 拦住、xcopy -y 放行，同一语义两个结果）。
    { re: /\b(?:copy|xcopy)\b[^\n]*(?:\/y\b|-y\b|--force\b|--overwrite\b)/i, why: '覆盖已存在的文件（静默不提示）' },
    { re: /(?:^|[\s;&|])replace\s+\S/i, why: '替换文件（覆盖目标同名文件）' },
    { re: /\bmklink\b|SymbolicLink|HardLink|Junction/i, why: '创建链接（可把读写引到工作区之外）' },
    // POSIX 那一侧的「参数即能力」：find 自带删除器与执行器，动词表对它完全无感。
    // cp/truncate/ln/chattr 走命令位判定（见 POSITIONAL_RISKY），因为它们同时是很常见的参数内容。
    { re: /\bfind\b[^\n]*(?:-delete|-exec(?:dir)?|-ok(?:dir)?)/i, why: 'find 自带删除器/执行器（-delete、-exec）' },
    // 解包归档不叫「覆盖」，但它就是把一批同名文件换成归档里的那份（实测 tar -xf 全程无卡，
    // 目标文件从 74 B 变回 21 B）。建档（-c）与列表（-t / unzip -l）不在这一档。
    // 开关前不带横杠的老式写法是同一件事（`tar xzf app.tar.gz` 实测静默执行），所以 `x…f`
    // 这一族也算解包；`tar cf out.tar x` 不会因此被误判（那个 token 不以 x 开头）。
    { re: /\b(?:tar|bsdtar|gtar)\b[^\n]*(?:\s-[a-zA-Z]*x[a-zA-Z]*\b|\bx[a-z]{0,6}f\b|--extract\b|--overwrite\b)/i,
      why: '解包归档（同名文件被静默覆盖成归档里的版本）' },
    { re: /\bunzip\b(?!\s+(?:-[a-z]*l|-Z)\b)|\b7z(?:r|a|z)?\s+[xe]\b|\bwinrar\b|\bexpand\b[^\n]*\.cab\b/i,
      why: '解包归档（同名文件被静默覆盖成归档里的版本）' },
    { re: /\battrib\s+[-+][rhasld]/i, why: '改文件属性（隐藏/系统/只读）' },
    // 卷影、备份、文件系统底层管理：读帮助文档不算破坏，但这些命令的其它动词全是系统级的。
    { re: /\b(?:vssadmin|wbadmin|fsutil)\b/i, why: '卷影副本/系统备份/文件系统底层管理' },
    // 事件日志清掉就没有现场了，属于「删掉就没了」那一类（实测 wevtutil cl 一路走到程序内部才因为
    // 通道名不存在而失败）。只认破坏性的动词：gl/el/epl 这类读与导出照旧不打扰。
    { re: /\bwevtutil\b[^\n]*(?:\scl\b|--clear-log|clear-log|\sset-log\b|\sset-config\b|delete-log)/i,
      why: '清空或改写 Windows 事件日志（审计现场不可恢复）' },
    // /R、/X 导出 EFS 恢复密钥已经进了硬禁；这里只留 /E：加密本身不改数据也不外泄，
    // 但会让用户之后读不到自己的文件，仍值得一次审批。
    { re: /\bcipher\s+\/e/i, why: '用 EFS 加密文件（之后没有对应证书就读不回来）' },
    // 文件类型关联是教科书级的持久化手法：改完之后双击 .txt 跑的就是别人的程序。
    { re: /(?:^|[\s;&|(/])(?:assoc|ftype)\b/i, why: '改文件类型关联（劫持打开方式）' },
    { re: /(?:^|[;&|]\s*)(?:set(?![\w-])|env\b|printenv\b|Get-ChildItem\s+env:)/i, why: '导出全部环境变量' },
    { re: /(?:\.ssh\b|id_rsa|known_hosts|\.aws\b|credentials\.aws|\.npmrc|\.netrc|lsass|\.env\b|\.git-credentials|config\/gh\/hosts\.yml|\.docker\/config\.json|\.kube\/config|cookies\.sqlite|Login Data|keychain|secrets\.json|oauth\.token)/i, why: '触及凭据/密钥文件' },
    // —— 下面这几族同样是「破坏动作没有对应动词」的补登记，只是量级不到系统级：
    //    数据、备份、云上资源、版本库历史被清掉之后，人还能救回一部分，所以归危险档而不是硬禁。
    { re: /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA|USER|VIEW|MATERIALIZED|COLLATION|TEMPORARY)|TRUNCATE\s+(?:TABLE|SCHEMA)|FLUSHALL|FLUSHDB|db\.dropDatabase\s*\(|DELETE\s+FROM\s+[\w."]+\s*(?:;|"|'|$)|DROP\s+KEY|\bDELETE\s+\w+\s+FROM)/i,
      why: '删除数据库/缓存里的内容（表、schema、整个键空间）' },
    { re: /\b(?:terraform|pulumi|cdk|crossplane)\b[^\n|;]*(?:destroy|apply[^\n|;]*-destroy)|\b(?:aws|az|gcloud|gsutil|doctl|scaleway-cli|ovh-cli|s3cmd|hcloud)\b[^\n|;]*\b(?:delete|destroy|terminate|purge|prune|rm|deregister|deprovision)\b(?![^\n|;]*(?:--help\b|\s-h\b))|\brclone\s+(?:purge|delete[frs]?|rm|trim|clean)\b|\b(?:helm)\s+(?:uninstall|delete|rollback)\b|\bargocd\s+app\s+delete\b|\bkubectl\s+(?:delete|drain|cordon|rollout\s+undo)\b/i,
      why: '销毁或回滚外部基础设施/集群资源（远端那侧的状态本地撤不回）' },
    { re: /\b(?:restic|borg|kopia|duplicity|burp|rdiff-backup|velero|pg_backrest|duply|rsnapshot)\b[^\n|;]*(?:\b(?:delete|forget|prune|purge|remove|destroy|expire|dropcache)\b|--prune)/i,
      why: '删除或修剪备份仓库里的快照（备份没了就没有第二次机会）' },
    // git 里「问一句就能跑」和「跑完救不回来」是两件事：reflog 过期与对象修剪会把悬空提交彻底清掉。
    { re: /\bgit\b[^\n|;]*\b(?:reflog\s+expire|gc\b[^\n|;]*--prune|filter-repo|lfs\s+prune|stash\s+(?:drop|clear)|branch\s+-D|tag\s+-d|remote\s+(?:remove|rename|set-url)|worktree\s+remove|update-ref\s+-d|replace\s+\S|push\b[^\n|;]*(?:--force\b|-f\b|--delete\b|--mirror))/i,
      why: '不可恢复的 git 操作（清历史/删分支或工作树/强推覆盖远端）' },
    // `git clean` 的破坏力全在开关里：`-x` 连 .gitignore 里的构建产物一起删，工作区里没备份的那份就没了。
    { re: /\bgit\b\s+clean\b[^\n|;]*-[a-z]*[fx]|git\b\s+clean\b[^\n|;]*--force/i,
      why: 'git clean 删除工作区里未跟踪的文件（-x 连构建产物一起删）' },
    { re: /\bgit\b[^\n|;]*\bapply\b[^\n|;]|\bgit\b[^\n|;]*\bmaintenance\s+(?:start|register)\b|\bgit\b\s+config\b[^\n]*--(?:unset|delete|remove-section)/i,
      why: '用补丁改写工作区文件，或删掉 git 配置项' },
    { re: /(?:^|[\s;/>=])\.(?:git|svn|hg)[\\/](?:HEAD|refs|objects|config|index|hooks|logs)(?:$|[\s/;\\])/i,
      why: '读写版本库内部数据（本地历史与配置被改后无从恢复）' },
    { re: /\b(?:setfacl|chacl|getfacl|setcap|getcap|chflags|xattr|fsutil\s+resource)\b/i,
      why: '改 ACL/扩展属性/能力位（可让文件对所有人可写或带上提权位）' },
    // 网卡与 DNS 配置：`ifconfig eth0 down` 断的是这台机器的网络，`resolvconf -u` 改写解析器配置，
    // `nmcli networking off` 是同一件事的 NetworkManager 写法，都与 iptables/`ip route` 同一量级 ——
    // 后果是「这台机器联系不上了」，不是删了谁的文档。
    { re: /\b(?:iptables|ip6tables|ebtables|ufw|nftables|firewalld)\b|\bip\s+(?:route|link|addr|neigh|tcp_metrics)\b|\broute\s+(?:add|delete|change)\b|\bnetworksetup\b|\bnft\b[^\n|;]*(?:add|delete|flush|inject)|\bifconfig\b[^\n|;]*(?:\sdown\b|\sadd\b|\sdel\b|promisc|netmask|hwether)|\b(?:resolvconf|resolvconfig|nmcli\s+(?:connection|device|radio|networking)|ipset|route6d?)\b/i,
      why: '改防火墙规则/路由/网卡或 DNS 解析状态' },
    { re: /\b(?:modprobe|rmmod|insmod|kexec|lsmod)\b|\bsysctl\s+-[wx]\b|\bstrace\s+-p\b|\bulimit\s+-[HS]\b/i,
      why: '装卸内核模块或改内核参数' },
    { re: /\b(?:Set|New|Resize|Add|Remove|Optimize|Repair)-Partition\b|\b(?:Set-Disk|Optimize-Volume|Repair-Volume|Mount-DiskImage|Dismount-DiskImage|Add-AppxPackage|Remove-AppxPackage|Set-StoragePool|Update-StoragePool)\b|\bdiskutil\s+(?:mount|unmount|repair|verify|renameDisk|clone)\b|\bzfs\s+(?:set|create|clone|promote|rename|mount)\b/i,
      why: '改分区/挂载点或增卸系统组件' },
    // 容器的危险不只在「操作了容器」：特权模式与宿主 bind mount 会让容器里的进程直接摸到整台机器，
    // 工作区边界这一层管不到那一侧（实测 `docker run --privileged -v /:/host` 全程无卡）。
    { re: /\b(?:docker|podman|nerdctl)\b[^\n|;]*(?:--privileged|--pid=host|--ipc=host|--uts=host|--cgroupns=host|--security-opt=(?:apparmor|seccomp)=unconfined|--cap-add=(?:ALL|SYS_ADMIN|NET_ADMIN|SYS_PTRACE)|--entrypoint=(?:[a-zA-Z]:[\\/]|\/))/i,
      why: '绕过容器隔离（特权模式、host 命名空间或危险 capability）' },
    { re: /\b(?:docker|podman|nerdctl|kubectl|docker-compose)\b[^\n|;]*\s(?:-v\b|--volume\b|--mount\b|--hostpath\b)[^\n|;]*(?:[a-zA-Z]:[\\/]|\/(?:etc|usr|bin|var|root|home|sys|dev|boot|lib|opt|mnt|media|Users|private)[\/:\s]|\/:)/i,
      why: '把宿主机的系统目录挂进容器（工作区边界在容器那一侧失效）' },
    { re: /\b(?:dotnet\s+ef|prisma|alembic|flyway|liquibase|knex|typeorm)\b|\bmanage\.py\s+migrate\b|\brails\s+db:(?:migrate|rollback|reset|drop)\b|\|\s*(?:mysql|psql|sqlcmd|sqlite3|redis-cli|mongo(?:sh)?)\b/i,
      why: '执行数据库迁移，或把 SQL 灌进数据库客户端' },
    { re: /\b(?:npm|pnpm|yarn|bun)\s+(?:publish|unpublish|deprecate|owner\s+add|dist-tag)\b|\b(?:twine|gem|cargo)\s+(?:publish|push|yank)\b/i,
      why: '对外发布或撤回包（发布出去的版本收不回来）' },
    { re: /\brsync\b[^\n|;]*--delete[a-z-]*|\bdd\b[^\n|;]*\bof=|(?:^|[\s;&|(])install\s+[-\w]*m\s*[0-7]{3,4}|(?:^|[\s;&|(])install\b[^\n|;]*\s\/usr\/(?:local\/)?(?:bin|sbin|lib)/i,
      why: '镜像同步删除目标侧差异，或用 dd/install 直接写系统路径' },
    { re: /\bhistory\s+-[cw]\b|\bjournalctl\s+(?:--rotate|--vacuum[-\w]*|-q\s+-k)\b|\bdmesg\s+-C?\b|\b(?:Clear-RecycleBin|Reset-StartupPreference)\b|\bLimit-EventLog\b/i,
      why: '清空 shell 历史或系统日志（现场不可恢复）' },
    // WMI/CIM 是「破坏动作藏在方法名与对象名里」的那一类：`Get-CimInstance Win32_ShadowCopy |
    // Remove-CimInstance` 删的是卷影副本（勒索软件的标准前戏），而命令行里一个危险词都没有。
    { re: /\b(?:Invoke-WmiMethod|Invoke-CimMethod|Set-WmiInstance|New-CimInstance|Register-CimProvider|Remove-(?:CimInstance|WmiObject))\b|\bGet-(?:WmiObject|CimInstance)\b[^\n|;]*\|\s*(?:Remove-WmiObject|Remove-CimInstance|ForEach-Object)/i,
      why: '经 WMI/CIM 调用系统方法（破坏动作藏在方法名里，关键词表看不见）' },
    { re: /\bdefaults\s+write\b|(?:^|[\s;&|(])bless\s+[^\n|;]*\/Volumes|\bsoftwareupdate\b[^\n|;]*-(?:install|remove|ignore)/i,
      why: '改 macOS 系统偏好/引导卷或增卸系统更新' },
    { re: /-W\s+hidden|-WindowStyle\s+Hidden|-ExecutionPolicy\s+Bypass|\bCreateNoWindow\s*=\s*\$?true|(?:^|[\s;&|])-Hidden\b/i,
      why: '隐藏窗口执行（刻意不给用户看见）' },
    // —— 第十三轮：git 的「丢数据」不只在 reset --hard / clean。删分支、强制切分支、read-tree -u、
    //    丢掉 reflog、deinit 子模块，每一种都不喊 rm，却都把未提交/未合并的那份内容变成不可达对象；
    //    参考项目的 core.git 把它们逐条登记成 high/critical，我们原先只认 -D 这一种写法。
    { re: /\bgit\b(?![^\n|;]*--no-delete)[^\n|;]*\bbranch\b[^\n|;]*(?:\s-[a-zA-Z]*[dD]\b|\s--delete\b)/i,
      why: '删除 git 分支（未合并的提交与本地引用会丢）' },
    // -M/-C 与 -m/-c 只差大小写，而 /i 分不开：这里刻意去掉 i，只认真正会覆盖已有分支的
    // 强制重命名/强制复制，`git branch -m old new` 这种日常改名照旧静默。
    { re: /\bgit\b[^\n|;]*\bbranch\b[^\n|;]*\s-[a-zA-Z]*(?:M|C)\b/,
      why: '强制覆盖/复制 git 分支（目标分支原有引用会被替换）' },
    { re: /\bgit\b[^\n|;]*(?:\bswitch\b[^\n|;]*(?:--discard-changes|--force|\s-[a-zA-Z]*f\b)|\bread-tree\b[^\n|;]*(?:--reset|\s-[a-zA-Z]*u\b)|\breset\b[^\n|;]*--merge\b|\bcheckout\b[^\n|;]*(?:--force|\s-[a-zA-Z]*f\b)|\brm\b[^\n|;]*(?:--force|\s-[a-zA-Z]*f\b)|\breflog\s+delete\b|\bsubmodule\s+deinit\b|\blfs\s+(?:migrate|uninstall)\b)/i,
      why: '丢弃工作区/历史数据的 git 操作（强制切换、read-tree、删子模块、丢 reflog）' },
    // 系统包管理器把「装/卸」写到了工作区之外：它改的是整台机器的依赖图，卸错一个组件
    // （libc、sudo、ssh）之后连修都没法修。原先只登记了 npm/pip 这一族语言包管理器。
    { re: /\b(?:apt|apt-get|dnf|yum|zypper|pacman|apk|snap|flatpak|conda|mamba|dpkg|rpm)\b[^\n|;]*(?:\b(?:install|remove|erase|purge|autoremove|uninstall|upgrade|dist-upgrade|full-upgrade)\b|\s-[a-zA-Z]*[rReE][a-zA-Z]*\b)/i,
      why: '系统包管理器安装/卸载/升级（写到工作区之外，可能带走系统组件）' },
    { re: /\b(?:poetry|uv|dotnet|nuget|composer|bundle|mix|stack|cabal|gem)\b[^\n|;]*(?:\b(?:uninstall|remove|delete|yank)\b)|\b(?:poetry|nuget|gem|cargo)\b[^\n|;]*\b(?:publish|push)\b/i,
      why: '卸载项目/系统依赖或对外发布包（依赖图变了，发布出去收不回）' },
    // 密钥管理器：删一条 secret、禁用 secrets engine、把策略删掉，拿到的不是「文件没了」而是
    // 「之后所有依赖它的服务都起不来」，而旧值不会留下任何副本。op/doppler/vault 原先完全不在表里。
    { re: /\bvault\b[^\n|;]*(?:\bkv\s+(?:put|patch|delete|destroy|metadata\s+delete)\b|\bsecrets\s+disable\b|\bauth\s+disable\b|\bpolicy\s+delete\b|\blease\s+revoke\b|\bdelete\b)/i,
      why: '删除/覆盖密钥管理器里的秘密（旧值拿不回来）' },
    { re: /\b(?:op|doppler)\b[^\n|;]*\b(?:item|document|vault|user|group|secrets|configs|projects)\b[^\n|;]*\b(?:delete|remove|archive)\b/i,
      why: '删除密钥管理器里的条目/配置（旧值拿不回来）' },
    { re: /\b(?:aws\s+secretsmanager|gcloud\s+secrets|az\s+keyvault\s+secret)\b[^\n|;]*(?:delete|destroy|update|put|set|purge|remove)/i,
      why: '删除或覆盖云端密钥（旧值拿不回来）' },
    // GitHub / 云平台上的「删除」在本地没有任何痕迹：删仓库、删 release、把仓库改私有/公开、
    // 删 SSH key，都是一条命令之后远端就换了状态。参考项目的 platform.* 与 cloud.* 规则包按
    // 子命令登记，而我们的通用 delete 规则只认得 terraform/aws 那一条主干。
    { re: /\bgh\b\s+(?:repo\s+(?:delete|archive|edit\b[^\n|;]*--visibility)|\brelease\s+(?:delete|delete-asset)|\bgist\s+delete|\bissue\s+delete|\bssh-key\s+delete|\bapi\b[^\n|;]*-X\s*DELETE)(?![^\n|;]*(?:--help\b|\s-h\b))/i,
      why: '删除/公开化 GitHub 上的远端资源（仓库、release、部署密钥）' },
    { re: /\b(?:az\s+account\s+(?:clear|cancel|subscription\s+cancel|management-group\s+(?:delete|subscription\s+remove)|alias\s+delete|lock\s+delete)|az\s+devops\b[^\n|;]*\b(?:remove|reset)\b|databricks\b[^\n|;]*\bdelete\b|railway\b[^\n|;]*\b(?:delete|down|detach|variable\s+set)\b|\brailway\b[^\n|;]*\s--set\b|circleci\b[^\n|;]*\b(?:delete|remove-secret)\b|gitlab-runner\b[^\n|;]*\bunregister\b|wrangler\b[^\n|;]*\bdelete\b|aws\s+s3\s+rb\b|aws\s+sns\s+unsubscribe\b)/i,
      why: '删除云端账号/仓库/资源（远端状态本地撤不回）' },
    { re: /\b(?:kafka-[a-z-]+|rabbitmqctl|rabbitmqadmin|nats)\b[^\n|;]*(?:--delete\b|--remove\b|--delete-config\b|\bdelete\w*\b|\bpurge\b|\bclear_permissions\b)|\bkafka-delete-records\b/i,
      why: '删除消息队列里的 topic/队列/消费组（堆积的数据直接没了）' },
    // 备份与同步的破坏力全在「目标侧多出来的文件会被删掉」：rclone sync 默认就是镜像删除，
    // borg compact 会把旧段彻底合并掉，rsync/tar 的 --remove-* 则在成功之后删源。
    { re: /\brclone\b[^\n|;]*\b(?:sync|deletefile|rmdir|move|purge|delete)\b(?![^\n|;]*--dry-run)/i,
      why: '云盘镜像/删除（目标侧与源不一致的文件会被删掉）' },
    { re: /\bborg\b[^\n|;]*\b(?:compact|prune|delete|rdelete)\b|\brestic\b[^\n|;]*(?:--prune|\bforget\b)/i,
      why: '压缩/删除备份仓库里的快照（备份没了就没有第二次机会）' },
    { re: /\b(?:rsync|tar|bsdtar|gtar)\b[^\n|;]*(?:--remove-source-files|--remove-files)\b/i,
      why: '归档/同步完成后删掉源文件（源侧数据没了）' },
    // Windows 的系统组件卸载与恢复环境改写：移除更新/驱动/可选功能之后，系统表面还能用，
    // 但想装回去需要联网与匹配的源；reagentc /disable 则直接让「重置/修复」入口消失。
    { re: /\b(?:dism(?:\.exe)?\b[^\n|;]*\/(?:remove-package|remove-capability|disable-feature|apply-image|apply-unattend)|\bdism(?:\.exe)?\b[^\n|;]*\/cleanup-image[^\n|;]*\/startcomponentcleanup|\bwusa(?:\.exe)?\b[^\n|;]*\/uninstall|\bpnputil(?:\.exe)?\b[^\n|;]*\/(?:delete-driver|remove-device)|\b(?:Remove-WindowsCapability|Remove-WindowsPackage|Uninstall-WindowsFeature|Disable-WindowsOptionalFeature|Remove-SmbShare|Remove-PSDrive|Clear-ItemProperty|Clear-Item|Remove-VM|Remove-VMSnapshot|Set-ExecutionPolicy)\b|\breagentc\b[^\n|;]*\/disable)/i,
      why: '卸载系统组件/驱动/更新或改写恢复环境（移除后难装回）' },
    // 参考项目把 DirectoryInfo.Delete($true) 单列成 critical：它是 PowerShell 里「递归删除整棵树」
    // 最短的写法，既没有 Remove-Item 这个词，也不经过回收站。
    { re: /\.Delete\s*\(\s*\$?true\s*\)/i,
      why: '.NET 递归删除目录树（不进回收站，无法恢复）' }
  ]

  // 「文本里没有危险词」不等于「执行时无害」。这一档不看关键词，只看**这条命令把决定权交给了谁**：
  // 解释器的内层代码、Base64 载荷、命令替换、系统自带下载器 —— 真实意图不在文本里，
  // 上面的关键词表对它们必然失配（实测：powershell -enc、node -e、python -c、run.bat 全部免审批直通）。
  // 所以像工作区越界那样单独立一条独立规则层：判定读不出这条命令到底做什么，就按危险处理。
  private static readonly OPAQUE: Rule[] = [
    { re: /(?:^|[\s;&|(/\\])(?:cmd|command)(?:\.exe|\.com)?\s*\/[ck]/i, why: '让 cmd 再解释一层命令（内层可以用 ^ 拆词）' },
    { re: /(?:^|[\s;&|(])(?:powershell|pwsh)(?:\.exe)?\s/i, why: '交给 PowerShell 解释执行（别名与内联代码读不出真实意图）' },
    // 管道右边是解释器时，执行的是**上游那段文本**：命令行里既没有解释器的开关，也没有动作，
    // 关键词表无从下手（实测：echo ([IO.File]::Delete(…)) | @powershell - 静默删掉了文件）。
    { re: /\|\s*(?:sudo\s+)?@?\s*(?:cmd|command)(?:\.exe|\.com)?\b|\|\s*(?:sudo\s+)?@?\s*(?:node|python\d?|perl|ruby|php|lua|deno|bun)(?:\.exe)?\b/i, why: '把上游内容当代码交给解释器执行' },
    // stdin 重定向是「同一件事的另一种写法」：`-` 后面跟的不是结束符而是 `<` 时，代码同样来自
    // 那个文件（实测 `python - < payload.txt` 原来因为只认 `$|;&|` 而整条放行）。
    { re: /\b(?:cmd|command|powershell|pwsh|sh|bash|zsh|dash|ksh|node|python\d?|perl|ruby|php|lua)\s+-\s*(?:$|[;&|<])/i, why: '解释器从标准输入读代码执行（内容不在命令行里）' },
    // cmd 不带 /c 时会把**重定向进来的每一行**当成命令执行；它是脚本同审完全覆盖不到的一条门：
    // payload.txt 的后缀不在 SCRIPT_EXT_RE 里，脚本内容一个字都不会被读，而命令行里既没有
    // del/rm 也没有解释器（实测 `cmd < payload.txt`、`cmd /d /s /c < payload.txt` 零审批直通，
    // 文件里写什么就执行什么）。
    // 同一条规律适用于所有「没有脚本操作数时从 stdin 读代码」的解释器：`python < payload.txt`、
    // `node < payload.txt`、`sh < payload.txt` 都是跑文件里的内容（实测原来全部放行）。
    // 只认「宿主与 `<` 之间只有开关」的形态：`python script.py < data.json` 这种把 stdin 当数据
    // 的正常写法有脚本操作数挡在中间，不会被误伤。
    { re: /(?:^|[\s;&|(])(?:cmd|command|sh|bash|zsh|dash|ksh|python\d?|py|pypy|node|iojs|deno|bun|perl|ruby|php|lua|tclsh)(?:\.exe|\.com)?(?:\s+(?:\/[a-z]|-{1,2}[\w=.-]*|-))*\s*</i,
      why: '解释器从重定向进来的文件读代码执行（文件内容不在命令行里）' },
    // `for ... do %i` 是 cmd 里「把循环变量的值当命令执行」的标准写法：命令行里既没有危险词，
    // 被跑起来的那段代码也不在命令里（实测 `do %i`、`do @%i`、`do call %i` 三种写法全部零审批直通）。
    // 原先这条规则要求 `for /f`，而 `/f` 只是「从文件/命令输出迭代」那一种形态 —— 少了它照样能跑：
    //   `for %i in (*) do @%i`    遍历目录里每个匹配项逐个执行（通配形态连脚本同审都碰不到，
    //                             scriptRefs 刻意排除了 glob，于是目录里有几个可执行文件就跑几个）
    //   `for %i in (name) do call %i`  把 name 交给 PATHEXT 补后缀再执行
    //   `for /r . %i in (*.bat) do %i` 递归形态
    // 实测 `for %i in (*.bat) do @%i` 与 `for %i in (only) do call %i` 都零审批跑出了文件里的内容。
    // 只认「循环变量本身就位于命令位」的形态，`do echo %i` 这类正常用法不打扰。
    { re: /\bfor\b[^\n]*?\bdo\s+\(?\s*@?(?:call\s+)?["']?%{1,2}[A-Za-z]/i,
      why: '把循环变量的值当命令执行（for 的循环变量位于命令位：文件名/通配的结果会被跑起来）' },
    // POSIX 那一侧是同一个语义的另一种拼法：`for f in *; do "$f"; done`、`while read l; do $l; done`。
    // 命令位上一个变量名，跑的是这个变量的值 —— 与 `for %i ... do %i` 完全一样，读不出真正执行的是什么。
    // 只认「do 后面紧跟一个裸变量（可带引号、可带 ./ 前缀）」的形态，`do echo $f` 这类照旧放行。
    { re: /\bdo\s+(["']?)(?:\.\/)?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\1(?=\s*(?:;|$|\n))/,
      why: '把循环变量的值当命令执行（循环变量位于命令位：文件名/通配的结果会被跑起来）' },
    { re: /\b(?:sh|bash|zsh|dash|ksh)(?:\.exe)?\b[^\n|;&]*?\s-\w*c\b/i, why: '交给 shell 内联执行一段代码' },
    { re: /\b(?:node|iojs|deno|bun)(?:\.exe)?\b[^\n|;&]*?\s-(?:e|p)\b|\b(?:node|iojs|deno|bun)(?:\.exe)?\b[^\n|;&]*?\s--(?:eval|print)\b/i, why: '交给 JS 运行时内联执行代码' },
    { re: /\b(?:python|python\d|pypy|py)(?:\.exe)?\b[^\n|;&]*?\s-(?:c|m)\b/i, why: '交给 Python 内联执行代码' },
    { re: /\b(?:perl|ruby|php|lua|tclsh|awk|gawk)(?:\.exe)?\b[^\n|;&]*?\s-\w*[er]\b|\bawk\b[^\n|;]*system\s*\(/i, why: '交给脚本语言内联执行代码' },
    { re: /\bsed\b\s+(?:--?\w+\s+)*-\w*i\b|\bsed\b\s+--in-place/i, why: 'sed 原地改写文件' },
    { re: /\bjava(?:w)?\s+(?:-\w+\s+)*-jar\b/i, why: '执行 jar 包（二进制内容审阅不了）' },
    // TS 不进脚本同审的后缀表（源码里满是小写 fetch/注释里的 rmSync，一读就误报），
    // 所以直接把「跑 TS 的入口」一刀切：这些命令做的就是把一段我们没读过的代码交给解释器。
    { re: /\bdeno\s+run|(?:^|[\s;&|])(?:ts-node|tsx)\s/i, why: '直接执行 TypeScript 脚本（内容不在命令里）' },
    { re: /-{1,2}enc\w*\b|frombase64string|tobase64string|\bbase64\s+(?:-d|--decode)\b|\becho\s+[a-z0-9+/=]{24,}\s*\|/i, why: 'Base64 或编码载荷（解码后才知道要执行什么）' },
    { re: /\b(?:certutil|bitsadmin|mshta|rundll32|regsvr32|msiexec|wmic)\b/i, why: '系统组件下载/执行（常被用来绕过安全策略）' },
    // 上面这一行的另一半：这些系统组件**不做下载**，只负责「把工作区里那个二进制/描述文件加载起来跑」。
    // installutil/regsvcs/regasm 会执行程序集里的安装代码，cmstp 按 .inf 里写的命令与 DLL 执行，
    // odbcconf 的 {REGSVR dll} 就是「注册一个 DLL」（等于执行它的 DllRegisterServer），
    // pcalua/xwizard/msdt/mavinject/ieexec/register-cimprovider 直接起进程或注入。
    // 与 rundll32/regsvr32 完全是同一档：载荷是二进制，审阅没东西可读，命令行里也没有危险词
    // （实测：下面每一种写法原先全部零审批直通）。
    // 锚点带上 @ 前缀与路径分隔符 —— `@installutil x.dll`、`tools\installutil.exe x.dll`
    // 在 cmd 里与裸写同义，而 unobfuscate 的 @ 名单里没有这些名字。
    { re: /(?:^|[\s;&|(\\/])@?(?:installutil|regsvcs|regasm|cmstp|odbcconf|pcalua|xwizard|msdt|mavinject|ieexec|register-cimprovider)(?:\.exe)?\b/i,
      why: '系统组件加载/执行外部二进制（.dll/.inf 一类载荷，内容审阅不了）' },
    // dotnet 的 build/test/run 与 npm run 同类（跑工作区里自己的工程），不打扰；
    // 但 `dotnet exec x.dll` / `dotnet x.dll` 是把一个**二进制程序集**直接跑起来，没有任何可审的文本。
    { re: /(?:^|[\s;&|(])@?dotnet(?:\.exe)?\s+(?:exec\s+\S+|\S+\.(?:dll|exe)\b)/i,
      why: '用 .NET 运行时直接执行二进制程序集（内容审阅不了）' },
    // WSL 是把整条命令交给另一套环境（Linux）执行：那边的 find -delete、cp、tee、truncate
    // 一个都不在我这张表里（实测 wsl find probes -name canary.txt -delete 真的删了文件，
    // 而 wsl -u root 直接是 root 权限）。不解析它后面的 argv，命中即按危险处理。
    { re: /(?:^|[\s;&|(/])wsl(?:config)?(?:\.exe)?\b/i, why: '交给 WSL 里的 Linux 环境执行（词表管不到那一侧做什么）' },
    // 外部执行/传输通道（ssh/scp/nc/telnet/adb）按命令位判，见 POSITIONAL_RISKY ——
    // 它们同时也是路径、包名与参数里常见的词，子串匹配会把 `echo scp x` 这类写法一起拦掉。
    // Windows 脚本宿主：它唯一的作用是「把那个文件当代码跑」，而跑什么全在文件里。
    // 更要紧的是后缀说了不算 —— cscript/wscript 加 //E:vbscript 能把 payload.txt 当 VBS 执行，
    // 而脚本同审是按后缀决定读不读内容的，于是这条通道三道防线一个都不过（实测删了文件、读了 win.ini）。
    // 锚点同样要认 @ 前缀与路径分隔符（`@cscript x.vbs`、`tools\cscript.exe x.vbs`）：@ 只是「别回显」，
    // 语法位置与裸写完全一样，而 unobfuscate 的 @ 剥离名单里没有这两个名字（实测 `@cscript x.vbs` 整条免检）。
    { re: /(?:^|[\s;&|(\\/])@?(?:cscript|wscript)(?:\.exe)?\b/i, why: '交给 Windows 脚本宿主执行脚本文件（内容不在命令行里）' },
    { re: /\/\/E\s*[:=]|vbscript:|language\s*=\s*["']?(?:vbs|jscript)/i, why: '指定脚本引擎执行代码（//E: 、vbscript: 一类）' },
    { re: /\biex\b|\bstart-process\b|\bnew-object\b[^\n|;]*shell/i, why: 'PowerShell 执行原语' },
    { re: /\$\(|`[^`\n]+`/, why: '命令替换（$(…) 或反引号）：文本里看到的不是最终执行的那一段' },
    { re: /%\w+:[~^=]|\$\{[A-Za-z_][A-Za-z0-9_]*[:@!\\/]/, why: '变量切片展开（用字符串拼出命令名）' },
    // macOS 的脚本宿主：osascript 的 -e 与脚本文件里跑的都是命令行读不出来的代码，
    // `do shell script` 更是直接在 shell 层执行一条命令（实测 osascript 两种写法零审批直通）。
    { re: /(?:^|[\s;&|(\\/])@?(?:osascript|osacompile|automator)\b|\bdo\s+shell\s+script\b/i,
      why: '交给 AppleScript 宿主执行（内层代码或它 do shell script 的那条命令不在命令行里）' },
    { re: /\bdeno\s+(?:eval|repl)\b|\bexpect\b[^\n|;]*\s-c\b|\bwish\b[^\n|;]*\s-c\b/i,
      why: '交给交互式脚本解释器执行一段代码' },
    // cmd 的 /v:on 打开延迟变量扩展：`!CMD!` 在执行那一刻才换成命令，命令行文本里没有那条命令。
    { re: /\/[vV]\s*:\s*[oO][nN]\b/i, why: '开启 cmd 延迟变量扩展（!VAR! 运行时才展开成命令）' }
  ]

  // 脚本文件里做的是「编程」而不是「敲命令」，删除与外发走的是语言 API，上面那些 shell 关键词看不见。
  // 只盯「shell 那一层同样要批准」的动作：删文件、改名、联网、上跳/越界（越界由路径规则管）。
  // 写文件不进这张表 —— write_file 工具本来就不需要批准，脚本里 fs.writeFileSync 不该更严；
  // 起子进程也不进（构建脚本天天 spawn 工具链）：它内层的命令行仍然被上面两张表扫过。
  // 但**拼出来的**那一段不在文本里（实测 execSync('d'+'el audit'+bs+'decoy.txt') 静默删了文件），
  // 所以只按「参数是不是单段字面量」切一刀：读不出跑的是什么，就按危险处理。
  private static readonly CODE: Rule[] = [
    { re: /\b(?:rmSync|unlinkSync|rmdirSync|truncateSync)\s*\(|\brimraf\b/i, why: 'JS 删除文件' },
    { re: /\b(?:fs|require\s*\(\s*['"]fs['"]\s*\))\s*\.\s*(?:promises\s*\.\s*)?(?:rm|rmdir|unlink|rename|truncate)\s*\(|\b\w+\.(?:unlink|rmdir)\s*\(|\bos\.replace\s*\(/i,
      why: 'JS/Python 删除或改名文件（异步 API 形态）' },
    { re: /\bshutil\.(?:rmtree|move)\s*\(|os\.(?:remove|unlink|rename|kill)\s*\(/i, why: 'Python 删除/移动文件' },
    { re: /\b(?:File|Files)\.(?:delete|Delete)\s*\(|\bremoveDirectory\b/i, why: '删除目录或文件' },
    { re: /\b(?:net\.Socket|createConnection|URLSession)\b|XmlHttpRequest|\bfetch\s*\(\s*['"]https?:/i, why: '脚本自己联网外发' },
    // VB/WSH 脚本里的破坏动作不叫 del：FSO 的 DeleteFile 删文件，CreateObject("Wscript.Shell")
    // 起一个 cmd —— 关键词表对这些完全无感，只有读了内容才看得见。
    { re: /CreateObject\s*\(\s*["']?(?:Wscript|Shell|Scripting|Msxml2|Adodb)|ActiveXObject\s*\(\s*["']?(?:Wscript|Shell|Scripting|Msxml2|Adodb)/i, why: '脚本经 WSH/COM 对象操作文件或起进程' },
    { re: /\bDelete(?:File|Folder)\b|\bKillFile\b/i, why: '脚本删除文件（FSO/API）' },
    // 脚本里内嵌一段编码载荷，运行时才解出来 —— 文本里既没有命令也没有危险词。
    // 原先只登记了命令行那一侧的写法（-enc / FromBase64String / base64 -d），脚本 API 这一侧完全没管：
    // Buffer.from('…','base64').toString() / atob('…') 解码出来的命令，交给 execSync 就是一个
    // 「发一条命令就能执行的任意代码」，而脚本同审看不出任何东西（实测零审批执行了载荷里的命令，
    // 并写出了一个标记文件）。
    { re: /\bBuffer\.from\s*\([^()\n]*,\s*['"](?:base64|hex|latin1|binary|ucs2|utf16le)['"]|\batob\s*\(|\bbase64\.b64decode\b|\bbinascii\.unhexlify\b|\bbytes\.fromhex\b|\bcodecs\.decode\s*\([^)]*['"]base64['"]/i,
      why: '脚本在运行时解码内嵌载荷（base64/hex），真正要执行的内容不在文本里' },
    // 参数不是一段**完整的字面量**（变量、拼接、模板串、Buffer.from/atob 解码出来的值）——
    // 真正跑什么不在文本里。原先只认「第一个字符是标识符且紧跟 + , )」，于是
    // execSync(Buffer.from('…','base64').toString()) 正好从这个缝里漏了过去：参数以 Buffer 开头、
    // 后面跟的是 `.`，两个分支都对不上（实测零审批执行了载荷里的命令）。现在改成「除了字面量一概不放过」，
    // 列表/数组字面量（subprocess.run(['git','status'])）仍然放行 —— 那种写法内容是读得出来的。
    { re: /\b(?:execSync|execFileSync|execFile|spawnSync|spawn|Popen|subprocess\.\w+|os\.system|os\.popen|child_process\.exec)\s*\(\s*(?![`'"[])/i,
      why: '把拼出来/解码出来的字符串交给子进程执行（真正运行的命令读不出）' },
    { re: /\b(?:execSync|execFileSync|execFile|spawnSync|spawn|Popen|subprocess\.\w+|os\.system|os\.popen)\s*\(\s*['"][^'"\n]{0,200}['"]\s*[+&]/i,
      why: '把拼出来/解码出来的字符串交给子进程执行（真正运行的命令读不出）' },
    { re: /\beval\s*\(|\bnew\s+Function\s*\(|(?:^|[^\w.])Execute(?:Global)?\s*\(/i, why: '执行一段动态拼出来的代码（eval 一类）' }
  ]

  /**
   * 工作区内的绝对路径不算「越界」，所以把根目录一起传进来比对。
   * Windows 分隔符与大小写都不敏感，先归一再前缀比较。
   */
  private static normalizePath(text: string): string {
    return text.replace(/\\/g, '/').toLowerCase()
  }

  // 命令里出现的绝对路径 token: 盘符路径, 或系统级 POSIX/Windows 目录开头的路径
  private static readonly ABS_PATH_RE: RegExp =
    /(?:[a-zA-Z]:[\\/]|[\\/](?:etc|usr|var|opt|bin|sbin|boot|sys|dev|home|root|tmp|mnt|media|Users|Program Files(?:\s?\(x86\))?|ProgramData|Windows)[\\/])/g

  // UNC / 网络路径：`\\server\share`、`//server/share`、`\\?\C:\…`、`\\?\UNC\server\share`。
  // 它们既没有盘符也不带 `..`，而 ABS_PATH_RE 只认得第二段恰好叫 Windows/Users 这类系统目录的写法 ——
  // 于是 `\\127.0.0.1\c$\Users`（本机 C 盘的管理共享，等于整块磁盘）与 `//server/share`
  // 一直零审批直通（实测）。token 至少要 host + 分隔符 + share 三段，`\\n` 这种转义串不会被误判。
  private static readonly UNC_TOKEN_RE: RegExp =
    /^(?:\\{2,}|\/{2,})[^\\/\s"'`;|&<>()]+[\\/][^\\/\s"'`;|&<>()]+/

  /**
   * 判定一条命令。root 传当前工作区根目录（用于豁免「就在工作区里干活」的绝对路径），
   * 传空串表示不做豁免。
   */
  static assess(command: string, root: string = ''): GuardVerdict {
    return CommandGuard.scan(command, root, false)
  }

  /**
   * 判定一段**脚本源码**（命令引用的 .ps1/.bat/.js/.py 之类的内容）。
   * 与 assess 同一套尺子，额外再过一遍语言 API —— 脚本里的 `fs.rmSync` 不像 shell 的 `rm`，
   * 但删起文件来一模一样。
   *
   * 文件比命令行长得多，所以不能沿用「超过 4000 字符就拒审」：那等于让任何一份正常的构建脚本
   * 都跑不起来，而把破坏写成 4100 字符照样免检。改成**按行分片逐片审**（片与片之间取并集，
   * 只会多出命中），大小另由 CommandService 的字节上限管住。
   */
  static assessScript(text: string, root: string = ''): GuardVerdict {
    if (text.trim().length <= CommandGuard.MAX_SCAN) {
      return CommandGuard.scan(text, root, true)
    }
    let merged: GuardVerdict = new GuardVerdict()
    let chunks: string[] = CommandGuard.lineChunks(text, CommandGuard.MAX_SCAN)
    for (let i: number = 0; i < chunks.length; i++) {
      if (chunks[i].trim() === '') {
        continue
      }
      let part: GuardVerdict = CommandGuard.scan(chunks[i], root, true)
      if (part.forbidden) {
        merged.forbidden = true
      }
      for (let j: number = 0; j < part.reasons.length; j++) {
        CommandGuard.pushReason(merged, part.reasons[j])
      }
      merged.risky = merged.risky || part.risky
    }
    return merged
  }

  private static readonly MAX_SCAN: number = 4000

  /** 按行切成不超过 size 的片段；单行本身超长时硬切（压缩过的 JS 也是一行的形态） */
  private static lineChunks(text: string, size: number): string[] {
    let out: string[] = []
    let lines: string[] = text.split(/\r?\n/)
    let buf: string = ''
    for (let i: number = 0; i < lines.length; i++) {
      let line: string = lines[i]
      while (line.length > size) {
        if (buf !== '') {
          out.push(buf)
          buf = ''
        }
        out.push(line.substring(0, size))
        line = line.substring(size)
      }
      if (buf.length + line.length + 1 > size) {
        if (buf !== '') {
          out.push(buf)
        }
        buf = line
      } else {
        buf = buf === '' ? line : buf + '\n' + line
      }
    }
    if (buf !== '') {
      out.push(buf)
    }
    return out
  }

  private static scan(text: string, root: string, script: boolean): GuardVerdict {
    let verdict: GuardVerdict = new GuardVerdict()
    let trimmed: string = text.trim()
    if (trimmed === '') {
      verdict.forbidden = true
      verdict.reasons.push('命令为空')
      return verdict
    }
    if (trimmed.length > CommandGuard.MAX_SCAN) {
      verdict.forbidden = true
      verdict.reasons.push('命令过长（超过 ' + CommandGuard.MAX_SCAN.toString() + ' 字符），无法逐字审阅')
      return verdict
    }
    // 原文与「还原转义后的文本」都过一遍：cmd 的 ^、拆词的引号、POSIX 的反斜杠在执行时会消失，
    // 只看原文就等于让 shut^down、de^l、form^at 用一个字符绕过硬禁表（实测缺口，见 unobfuscate）。
    // 再把括号/反引号包裹的内层命令单独拎出来 —— 段首锚定的规则看不见 for /f 里的解释器。
    let norm: string = CommandGuard.unobfuscate(trimmed)
    let folded: string = CommandGuard.foldConstants(trimmed)
    let sources: string[] = [trimmed, norm, folded]
    if (folded !== trimmed) {
      sources.push(CommandGuard.unobfuscate(folded))
    }
    sources = sources.concat(CommandGuard.extractInnerCommands(trimmed))
    // 关键词表也要看一份「只去 ^ 与引号、反斜杠原样留着」的文本：unobfuscate 按 POSIX 规则把
    // `\S` 当转义吃掉，`reg save HKLM\SAM` 还原后成了 `HKLMSAM` —— 于是 `r^eg save HKLM\SAM`
    // 这种「^ 拆词 + Windows 路径」的写法在原文与还原文里各缺一半，两层都看不见（实测）。
    // 并集只会多出命中，所以补这一份不会洗掉任何东西。
    for (let u: number = 0; u < sources.length; u++) {
      let kept: string = CommandGuard.pathUnescape(sources[u])
      if (sources.indexOf(kept) === -1) {
        sources.push(kept)
      }
    }
    // 边界检查与灾难目标层必须和关键词表看**同一批文本**：`type C:^\Windows^\win.ini` 执行时就是
    // C:\Windows\win.ini，而这类检查若只读原文（trimmed），「要还原一次才看得出来去哪」的写法
    // 就把整层跳了过去（实测：四种 ^ 转义写法全部零审批直通）。
    // 关键词表那条路早就用的是原文 ∪ 还原文 ∪ 折叠文，边界层没跟上就是一处结构性缺口。
    // 注意这里不能直接用 unobfuscate 的结果：它按 POSIX 规则把 `\W` 当转义吃掉，
    // Windows 路径在它那里会变成 `C:Windows\win.ini`（实测），所以边界层要的是
    // pathUnescape 那一份 —— 只去 cmd 的 ^ 与引号，反斜杠原样留着。
    let boundary: string[] = [trimmed]
    for (let b: number = 0; b < sources.length; b++) {
      let one: string = CommandGuard.pathUnescape(sources[b])
      if (boundary.indexOf(one) === -1) {
        boundary.push(one)
      }
    }
    let forbidden: string[] = CommandGuard.matchedAll(sources, CommandGuard.FORBIDDEN)
    let risky: string[] = CommandGuard.matchedAll(sources, CommandGuard.RISKY)
      .concat(CommandGuard.matchedAll(sources, CommandGuard.OPAQUE))
    // 命令位判定：`format` 这类「程序名本身就是毁灭操作」的词，只看它是不是那段真正要运行的程序 ——
    // 词表只能认 `format C:` 的盘符形态，而卷标（`format MYLABEL /Q /Y`）与 `format /?` 都会真的把
    // format.exe 跑起来；反过来，把 format 这个词无条件硬禁会误伤 `npm run format`、`git log --format=%h`。
    let progs: string[] = CommandGuard.commandPrograms(sources)
    let rawProgs: string[] = CommandGuard.commandPrograms([trimmed])
    forbidden = forbidden.concat(CommandGuard.matchedPrograms(progs, CommandGuard.POSITIONAL_FORBIDDEN))
    risky = risky.concat(CommandGuard.matchedPrograms(progs, CommandGuard.POSITIONAL_RISKY))
    // 语言 API 只作危险项：脚本里写文件是常态，硬禁表留给真正不可逆的系统级操作。
    // 但只用**还留着引号**的那几份文本判：unobfuscate 会把引号去掉，execFileSync('node')
    // 去掉引号就成了 execFileSync(node)，看起来像「参数是变量」，把正常构建脚本全冤枉了。
    if (script) {
      let quoted: string[] = [trimmed, folded].concat(CommandGuard.extractInnerCommands(trimmed))
      risky = risky.concat(CommandGuard.matchedAll(quoted, CommandGuard.CODE))
    }
    // 灾难目标判定：动作落在「整棵树的根 / 某个人的主目录 / 一级系统目录 / 关键系统文件」上，
    // 与 `rm -rf /` 同一口径不给审批入口。动词表只认得 POSIX 那一半写法，
    // `del /q /s C:\*`、`rd /s /q C:\`、`Remove-Item $env:USERPROFILE\* -Recurse` 一直只判成「删文件」
    // 弹一张卡（在完全权限档下连卡都不弹）—— 见 firstDisasterTarget 的说明。
    let disaster: string = CommandGuard.firstOverSources(boundary,
      (t: string): string => CommandGuard.firstDisasterTarget(t))
    let disasterWhy: string = disaster === '' ? '' :
      CommandGuard.DISASTER_WHY_PREFIX + disaster
    if (disasterWhy !== '') {
      forbidden = forbidden.concat([disasterWhy])
    }
    // 只在还原文/内层命令里出现的命中，说明写命令的人绕了一段路 —— 档位按追加后的结果定
    // （形如 shut^down 的写法必须照样落进硬禁表，不能降级成「问一句就跑」），并额外说明原因。
    let rawForbidden: string[] = CommandGuard.matched(trimmed, CommandGuard.FORBIDDEN)
      .concat(CommandGuard.matchedPrograms(rawProgs, CommandGuard.POSITIONAL_FORBIDDEN))
    let rawDisaster: string = CommandGuard.firstDisasterTarget(trimmed)
    if (rawDisaster !== '') {
      rawForbidden = rawForbidden.concat([CommandGuard.DISASTER_WHY_PREFIX + rawDisaster])
    }
    let rawRisky: string[] = CommandGuard.matched(trimmed, CommandGuard.RISKY)
      .concat(CommandGuard.matched(trimmed, CommandGuard.OPAQUE))
      .concat(CommandGuard.matchedPrograms(rawProgs, CommandGuard.POSITIONAL_RISKY))
    if (script) {
      rawRisky = rawRisky.concat(CommandGuard.matched(trimmed, CommandGuard.CODE))
    }
    let obfuscated: boolean = CommandGuard.onlyMissing(forbidden, rawForbidden).length > 0 ||
      CommandGuard.onlyMissing(risky, rawRisky).length > 0
    for (let i: number = 0; i < forbidden.length; i++) {
      verdict.forbidden = true
      CommandGuard.pushReason(verdict, forbidden[i])
    }
    if (verdict.forbidden) {
      if (obfuscated) {
        CommandGuard.pushReason(verdict, CommandGuard.OBFUSCATED_WHY)
      }
      return verdict
    }
    for (let j: number = 0; j < risky.length; j++) {
      verdict.risky = true
      CommandGuard.pushReason(verdict, risky[j])
    }
    if (obfuscated) {
      verdict.risky = true
      CommandGuard.pushReason(verdict, CommandGuard.OBFUSCATED_WHY)
    }
    let outside: string = CommandGuard.firstOverSources(boundary,
      (t: string): string => CommandGuard.firstPathOutsideWorkspace(t, root))
    if (outside !== '') {
      verdict.risky = true
      CommandGuard.pushReason(verdict, '触及工作区之外的路径 ' + outside)
    }
    // 绝对路径那套正则看不见「相对上跳」：dir .. / echo x > ..\y.txt 同样是出圈，
    // 同一个越界效果不能因为写法不同就一路绿灯（实测缺口，见 firstUpTraversal 的说明）。
    let up: string = CommandGuard.firstOverSources(boundary,
      (t: string): string => CommandGuard.firstUpTraversal(t))
    if (up !== '') {
      verdict.risky = true
      CommandGuard.pushReason(verdict, '命令里有 .. 上跳，读写位置在工作区之外：' + up)
    }
    // UNC 路径是「工作区边界」上另一条没被覆盖的路：它没有盘符、没有 ..，ABS_PATH_RE 也认不全。
    // `dir \\127.0.0.1\c$\Users` 读的是本机整块 C 盘，`copy \\server\share\x .` 是往外拿数据 ——
    // 与绝对路径同一条边界，判定也归到同一档（工作区根本身在 UNC 共享上时不误伤）。
    let unc: string = CommandGuard.firstOverSources(boundary,
      (t: string): string => CommandGuard.firstUncPathOutside(t, root))
    if (unc !== '') {
      verdict.risky = true
      CommandGuard.pushReason(verdict, '命令里的 UNC/网络路径在工作区之外：' + unc)
    }
    // 第三种「绝对路径」写法：cmd/PowerShell 里以单个反斜杠开头的是**盘根**（`\data\a.txt`
    // 就是 `C:\data\a.txt`）。它没有盘符、没有 ..，而 ABS_PATH_RE 只认得第二段叫 Windows/Users
    // 这类系统目录的写法 —— 于是 `type \data\a.txt`、`copy \a.txt .`、`echo x > \a.txt`
    // 一直零审批直通（实测）。
    let rootPath: string = CommandGuard.firstOverSources(boundary,
      (t: string): string => CommandGuard.firstRootPathOutside(t, root))
    if (rootPath !== '') {
      verdict.risky = true
      CommandGuard.pushReason(verdict, '命令里的盘根路径在工作区之外：' + rootPath)
    }
    // 字面路径规则只认 `C:\` 与 `..`，而 cmd 里 `%TEMP%\x`、PowerShell 里 `$env:TEMP + '\x'`
    // 展开后同样出圈（实测：type %SystemRoot%\win.ini 读系统文件全程静默）。
    let envOut: string = CommandGuard.firstOverSources(boundary,
      (t: string): string => CommandGuard.firstEnvPathOutside(t))
    if (envOut !== '') {
      verdict.risky = true
      CommandGuard.pushReason(verdict, '命令里的环境变量路径展开后在工作区之外：' + envOut)
    }
    // 解释器执行「后缀不在脚本同审表里」的文件：把载荷写成 payload.txt，node/python 照样当代码跑，
    // 而同审是按后缀决定读不读的 —— 这一段要执行的代码我们既没读也不会读，只能按危险处理。
    let payload: string = ''
    for (let s: number = 0; s < sources.length && payload === ''; s++) {
      payload = CommandGuard.firstExecDataOperand(sources[s])
    }
    if (payload !== '') {
      verdict.risky = true
      CommandGuard.pushReason(verdict, '解释器执行的载荷后缀不是代码文件，内容审阅不了：' + payload)
    }
    // 脚本同审读的是**执行前**的文件内容。同一条命令完全可以先把脚本改写成载荷、再把它跑起来：
    // `type payload.txt > run.bat && call run.bat` 里命令文本没有任何危险词，run.bat 在审阅那一刻
    // 还是干净旧内容，判完才被覆盖 —— 实测这条命令零审批跑出了 payload.txt 里的 del
    // （payload.txt 后缀不在同审表里，一个字都不会被读）。
    // 写普通数据文件不需要批准（与 write_file 同一口径），所以这里只盯「重定向的目标是脚本」。
    let scriptWrite: string = CommandGuard.firstOverSources(sources,
      (t: string): string => CommandGuard.firstScriptWriteTarget(t))
    if (scriptWrite !== '') {
      verdict.risky = true
      CommandGuard.pushReason(verdict, '命令把输出重定向进脚本文件 ' + scriptWrite +
        '（同审读到的是改写前的旧内容，先改写再执行等于没审）')
    }
    // 重定向只是「写文件」的一种写法。copy/xcopy/move/tee/tftp 做的是同一件事：
    // 把载荷换成那个脚本的内容，再在**同一条命令**里把它跑起来 —— 同审读到的同样是改写前的旧内容。
    // 实测 `copy payload.txt run.bat && call run.bat` 零审批跑出了 payload 里的内容。
    let scriptCopy: string = CommandGuard.firstOverSources(sources,
      (t: string): string => CommandGuard.firstScriptCopyTarget(t))
    if (scriptCopy !== '') {
      verdict.risky = true
      CommandGuard.pushReason(verdict, '命令用 copy/move/xcopy/tee 一类写入型命令改写了脚本文件 ' +
        scriptCopy + '（同审读到的是改写前的旧内容，先改写再执行等于没审）')
    }
    // `~` / `$HOME` 在 cmd 里只是一个字符，在 Git-bash / WSL / PowerShell 里就是主目录 ——
    // 字面路径规则对这种「由 shell 决定指向哪」的写法完全无感（实测 wsl ls ~ 静默列出主目录）。
    let home: string = CommandGuard.firstHomeOperand(sources)
    if (home !== '') {
      verdict.risky = true
      CommandGuard.pushReason(verdict, '命令里的 ~ / $HOME 展开后是用户主目录，在工作区之外：' + home)
    }
    return verdict
  }

  private static readonly OBFUSCATED_WHY: string =
    '命令被间接写法遮过（转义拆词 / @ 前缀 / 环境变量 / 括号包裹），还原后才发现危险'

  // 还原 shell 的转义、拆词、间接调用与变量写法。只做「把字符去掉 / 换成等价写法」，
  // 所以结果只会**多出**命中，不会让原本判危险的命令变干净 —— 判定用的始终是「原文 ∪ 还原文」。
  private static unobfuscate(text: string): string {
    let out: string = text
    out = CommandGuard.expandEnvRefs(text)
    out = out.replace(/\^\^/g, ' ')          // cmd: ^^ 是字面意义的 ^，先隔离开
    out = out.replace(/\^([^\s])/g, '$1')    // cmd: ^x 执行时就是 x（shell:true 走的就是 cmd）
    // `^` 后面跟空白时它转义的是那个空格本身（`save^ HKLM` 执行时就是 `save HKLM`）：
    // 原先只处理 `^` 后跟非空白，于是词与词之间多插一个 ^ 就能把 `reg save` 拆成匹配不上的样子。
    out = out.replace(/\^(?=\s)/g, '')
    out = out.replace(/\\([A-Za-z_])/g, '$1') // POSIX: \x 执行时就是 x
    out = out.replace(/["']/g, '')           // 拆词: d"e"l 执行时就是 del
    // cmd 的 @ 前缀只是「别回显这一行」，语法位置与不带 @ 完全一样（实测：@cmd /c、@powershell -c
    // 因为解释器规则锚在段首而整条免审批直通）。剥掉它，@ 开头的写法与裸写法走同一条判定。
    out = out.replace(/(^|[;&|(\s]\s*)@(cmd|command|powershell|pwsh|sh|bash|zsh|node|python|dotnet)\b/gi,
      '$1$2')
    return out
  }

  // 相邻字符串字面量被连接符拼在一起：'d' + 'el'、"a" & "b"（JS/PS 用 +，VBS 用 &）
  private static readonly CONCAT_RE: RegExp =
    /(['"])([^'"\n]{0,160})\1\s*[+&]\s*(['"])([^'"\n]{0,160})\3/g
  // 赋值为字符串字面量的变量：const bs = '\\'、set X=del、dim y "rd"
  private static readonly CONST_ASSIGN_RE: RegExp =
    /(?:var|let|const|set|dim|\blocal\b)?\s*([A-Za-z_$][\w$]{0,40})\s*=\s*(['"])([^'"\n]{0,160})\2/g

  /**
   * 常量折叠：把「拆开写的危险词」还原成一个词。
   *
   * 为什么要它：关键字表读的是文本，而 `'d'+'el audit'+bs+'decoy.txt'` 里根本没有 del 这个词
   * —— 实测这样静默删掉了文件。脚本正文里做字符串拼接是天经地义的，所以不是「见拼接就拦」，
   * 而是能算出来的先算出来，再交给原来那三层判定。
   * 折叠结果只作为**额外**的一份文本参与判定（原文照样过），所以它只可能多出命中，不会洗掉任何东西。
   */
  private static foldConstants(text: string): string {
    let out: string = CommandGuard.expandCharCodes(text)
    for (let round: number = 0; round < 4; round++) {
      let prev: string = out
      out = out.replace(CommandGuard.CONCAT_RE,
        (_m: string, q1: string, a: string, _q2: string, b: string): string => q1 + a + b + q1)
      out = CommandGuard.substituteConsts(out)
      if (out === prev || out.length > 16000) {
        break
      }
    }
    return out
  }

  // String.fromCharCode(100,101,108)、Chr(100)、[char]100 —— 用码点写出关键词的写法
  private static expandCharCodes(text: string): string {
    let out: string = text.replace(/\bString\.fromCharCode\s*\(\s*(\d{1,4}(?:\s*,\s*\d{1,4}){0,31})\s*\)/g,
      (_m: string, csv: string): string => "'" + CommandGuard.codesToChars(csv) + "'")
    out = out.replace(/\b(?:ChrW|Chr|Character)\s*\(\s*(\d{1,4})\s*\)/g,
      (_m: string, csv: string): string => "'" + CommandGuard.codesToChars(csv) + "'")
    out = out.replace(/\[char\]\s*\{?\s*(\d{1,4})\s*\}?/g,
      (_m: string, csv: string): string => "'" + CommandGuard.codesToChars(csv) + "'")
    return out
  }

  // 只还原可打印 ASCII：折叠是为了让关键词浮出来，控制字符对判定没有意义
  private static codesToChars(csv: string): string {
    let parts: string[] = csv.split(',')
    let out: string = ''
    for (let i: number = 0; i < parts.length; i++) {
      let code: number = parseInt(parts[i], 10)
      if (code >= 32 && code <= 126) {
        out += String.fromCharCode(code)
      }
    }
    return out
  }

  /** 把「变量 = 一段字符串字面量」的变量名换成它的值（同一份文本内，只看字面量赋值） */
  private static substituteConsts(text: string): string {
    let out: string = text
    let re: RegExp = new RegExp(CommandGuard.CONST_ASSIGN_RE.source, 'g')
    let match: RegExpExecArray | null = re.exec(text)
    let count: number = 0
    while (match !== null && count < 12) {
      let name: string = match[1]
      let value: string = match[3]
      count++
      if (value !== '' && name !== value) {
        // 不能用 \b：PowerShell 的 $cmd 里 `$` 本身就是非词字符，词边界反而匹配不上
        out = out.replace(new RegExp('(^|[^\\w$])' + name.replace(/\$/g, '\\$') + '($|[^\\w$])', 'g'),
          (_m: string, head: string, tail: string): string => head + value + tail)
      }
      match = re.exec(text)
    }
    return out
  }

  // 系统自带解释器的环境变量写法换成实际路径 —— 换出来的都是工作区外的绝对路径，
  // 所以这一步只会让「再解释一层」这一类命中浮出来，不会洗掉任何东西。
  // （变量指到哪个目录由 firstEnvPathOutside 单独管，它按名字判断，不需要真的展开路径。）
  private static expandEnvRefs(text: string): string {
    let out: string = text
    // %ComSpec% 就是 cmd.exe 本身（实测：%ComSpec% /c 免审批直通）；%SystemRoot%/%Windir% 是 Windows 目录
    out = out.replace(/%ComSpec%/gi, 'C:/Windows/System32/cmd.exe')
    out = out.replace(/%(?:SystemRoot|Windir)%/gi, 'C:/Windows')
    out = out.replace(/\$\{?env:ComSpec\}?/gi, 'C:/Windows/System32/cmd.exe')
    // PowerShell 里 $env:X 拼出来的字符串读不出值，换成 cmd 的名字让管道/解释器规则按同一把尺子判
    out = out.replace(/\$\{?env:\w+\}?\s*(?:\+\s*)?['"]?\s*-{1,2}c\b/gi, 'cmd -c')
    // 把剩下的 %NAME% 引用改成裸名，好让切片规则（%\w+:）之外的写法也有名字可查
    out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, ' $1')
    return out
  }

  private static matched(text: string, rules: Rule[]): string[] {
    let hits: string[] = []
    for (let i: number = 0; i < rules.length; i++) {
      if (rules[i].re.test(text) && hits.indexOf(rules[i].why) === -1) {
        hits.push(rules[i].why)
      }
    }
    return hits
  }

  /** 对若干份等价文本（原文 / 还原 / 拆出来的内层命令）取命中并集 */
  private static matchedAll(texts: string[], rules: Rule[]): string[] {
    let hits: string[] = []
    for (let i: number = 0; i < texts.length; i++) {
      let found: string[] = CommandGuard.matched(texts[i], rules)
      for (let j: number = 0; j < found.length; j++) {
        if (hits.indexOf(found[j]) === -1) {
          hits.push(found[j])
        }
      }
    }
    return hits
  }

  // 括号与反引号里的内容：cmd 的 for /f ... in ('…')、POSIX 的 `…` 都是「另起一段执行」。
  // 解释器规则锚在段首，包一层就看不见（实测：for /f %a in ('powershell -c …') 免审批直通），
  // 所以把内层单独拎出来走同一套判定，而不是把锚点放宽到任意位置（那会误伤带路径的文件名）。
  private static readonly INNER_GROUP_RE: RegExp = /\(([^()\n]{1,240})\)|`([^`\n]{1,240})`/g
  private static readonly MAX_INNER: number = 6

  private static extractInnerCommands(text: string): string[] {
    let out: string[] = []
    let re: RegExp = new RegExp(CommandGuard.INNER_GROUP_RE.source, 'g')
    let match: RegExpExecArray | null = re.exec(text)
    while (match !== null && out.length < CommandGuard.MAX_INNER) {
      let inner: string = (match[1] !== undefined ? match[1] : match[2]).trim()
      // cmd 的循环变量（%a / %%a）换成空，免得把 `%a` 当成变量引用；单引号包的整体也算一段
      inner = inner.replace(/%%?[A-Za-z]\b/g, ' ').trim()
      if (inner !== '') {
        out.push(inner)
      }
      match = re.exec(text)
    }
    return out
  }

  // 已知必然落在工作区之外的环境变量名（临时目录、系统目录、用户目录那一类）。
  private static readonly ENV_OUTSIDE_NAMES: RegExp =
    /^(?:temp|tmp|systemroot|windir|comspec|userprofile|homepath|homeDrive|allusersprofile|public|appdata|localappdata|programdata|programfiles(?:\(?x86\)?)?|programfilesx86|systemdrive|os|cmdcmdline|windowsdirectory|homeshare)$/i

  // %NAME%\… 或 $env:NAME（含 PowerShell 的 $env:X + '\y' 拼接）——名字查得出就按越界处理，
  // 查不出但后面紧跟分隔符的也按越界：值我们读不出来，就不能假定它还在工作区里。
  private static readonly ENV_TOKEN_RE: RegExp =
    /%([A-Za-z_][A-Za-z0-9_]{1,})%|\$\{?env:([A-Za-z_][A-Za-z0-9_]*)\}?/gi
  // 允许夹在变量引用与分隔符之间的字符：PowerShell 用 `$env:X + '\y'` 拼路径，引号与加号都在中间
  private static readonly ENV_SEPARATORS: string = " \t'\"+"

  private static onlyMissing(candidates: string[], known: string[]): string[] {
    let fresh: string[] = []
    for (let i: number = 0; i < candidates.length; i++) {
      if (known.indexOf(candidates[i]) === -1 && fresh.indexOf(candidates[i]) === -1) {
        fresh.push(candidates[i])
      }
    }
    return fresh
  }

  /**
   * 这条命令需不需要一个**裁决**。谁裁由档位决定：
   *   ask / ask-risk → 人；auto → 模型先审（审不过再找人，见 ApprovalReviewService）；
   *   full-access → 没有裁决这一步（硬禁表在更前面，与档位无关）。
   * 注意 auto 与 ask-risk 在这里同值 —— 两者都要为危险命令找一个判官，差别在判官是谁。
   */
  static needsApproval(verdict: GuardVerdict, permission: string): boolean {
    if (permission === CommandGuard.PERMISSION_FULL_ACCESS) {
      return false
    }
    if (permission === CommandGuard.PERMISSION_ASK) {
      return true
    }
    return verdict.risky
  }

  /** 危险命令是否先交给模型审阅（只有 'auto' 档走这条路） */
  static usesModelReview(permission: string): boolean {
    return permission === CommandGuard.PERMISSION_AUTO
  }

  /** 会话档位取值（旧数据/未设置都是空串 → 默认档「危险需批准」） */
  static normalizePermission(permission: string): string {
    return CommandGuard.PERMISSIONS.indexOf(permission) !== -1 ? permission :
      CommandGuard.PERMISSION_ASK_RISK
  }

  static forbiddenReason(verdict: GuardVerdict): string {
    return verdict.forbidden ? verdict.reasons.join('、') : ''
  }

  /**
   * 六张规则表按档口交出去，**只给验证脚本用**（scripts/guard-corpus.mjs 的覆盖自检）。
   *
   * 为什么要开这个口子：规则表是手写正则的堆叠，「加了一条永远命中不了的规则」和
   * 「语料里从没跑到某条规则」都是静默的 —— 前者给人假的安心感，后者让人以为改坏了。
   * 把表交给套件点名，每条规则的 why 至少要被一条用例命中，命中不了就报出来。
   * 生产链路一处也不读它。
   */
  static ruleTables(): Record<string, Rule[]> {
    let out: Record<string, Rule[]> = {}
    out['FORBIDDEN'] = CommandGuard.FORBIDDEN
    out['RISKY'] = CommandGuard.RISKY
    out['OPAQUE'] = CommandGuard.OPAQUE
    out['CODE'] = CommandGuard.CODE
    out['POSITIONAL_FORBIDDEN'] = CommandGuard.POSITIONAL_FORBIDDEN
    out['POSITIONAL_RISKY'] = CommandGuard.POSITIONAL_RISKY
    return out
  }

  private static pushReason(verdict: GuardVerdict, why: string): void {
    if (verdict.reasons.indexOf(why) === -1) {
      verdict.reasons.push(why)
    }
  }

  /**
   * 边界检查专用的「去掉伪装」：只去掉 cmd 的 ^ 转义与引号，**反斜杠原样留着**。
   *
   * 为什么不复用 unobfuscate：它按 POSIX 规则把 `\x` 当转义吃掉，`C:\Windows\win.ini`
   * 于是变成 `C:Windows\win.ini`，盘符规则再也认不出来（实测：加完边界复检仍然直通）。
   * 两份文本各司其职 —— 关键词表要的是 POSIX 视角，边界层要的是 Windows 视角。
   */
  private static pathUnescape(text: string): string {
    let out: string = text.replace(/\^\^/g, ' ')
    out = out.replace(/\^([^\s])/g, '$1')
    out = out.replace(/\^(?=\s)/g, '')
    out = out.replace(/["']/g, '')
    return out
  }

  /**
   * 在「原文 ∪ 还原文 ∪ 折叠文 ∪ 内层命令」上跑同一条边界检查，取第一个命中。
   * 边界（盘符绝对路径 / .. 上跳 / UNC / 盘根 / 环境变量路径）原先各自只读原文，
   * 于是 `C:^\Windows^\win.ini` 这类「还原一次才看得出要去哪」的写法整条直通 ——
   * 关键词表早就在这几份文本上取并集了，边界层必须用同一把尺子。
   */
  private static firstOverSources(sources: string[],
    probe: (text: string) => string): string {
    for (let i: number = 0; i < sources.length; i++) {
      let hit: string = probe(sources[i])
      if (hit !== '') {
        return hit
      }
    }
    return ''
  }

  /**
   * ===== 灾难目标判定层 =====
   *
   * 为什么单独立一层，而不是往关键词表里再加几个词：`rm -rf /` 之所以不给审批，**不是因为 rm
   * 这个词**，而是因为目标是整棵树的根。同一件事换一套方言写法，动词表就完全无感 ——
   * 实测 `del /q /s C:\*`、`rd /s /q C:\`、`Remove-Item C:\ -Recurse -Force`、
   * `del /q %USERPROFILE%\*`、`Remove-Item $env:USERPROFILE\* -Recurse` 全部只被判成「删除文件」
   * 弹一张卡，而在完全权限档下连卡都不弹；词表只有 POSIX 那一半，等于给另外两种写法发了免检票。
   * 这一层问的是**动作落在哪个目标上**：根、主目录、一级系统目录本身（或其整体通配）、
   * 关键系统文件/裸设备 —— 命中即硬禁，与 `rm -rf /` 同一口径。
   */
  // 命中理由的前缀：审批卡与拒绝文案都要写明「动作落在了哪个目标上」
  private static readonly DISASTER_WHY_PREFIX: string =
    '删除或清空的目标是系统根目录/主目录/关键系统文件：'
  // 删除类动作词（含 PowerShell 官方别名 ri/rmi 与 cmd 的 del/rd/erase/deltree）
  private static readonly DISASTER_DELETE_RE: RegExp =
    /^(?:rm|rmdir|del|erase|rd|deltree|unlink|shred|remove-item|ri|rmi|sremove)$/i
  // 清零/覆盖类动作词：目标原内容不可恢复，与删掉它等价
  private static readonly DISASTER_WRITE_RE: RegExp =
    /^(?:truncate|clear-content|set-content|out-file|add-content|dd|shred)$/i
  // 搬运类动作词：只有**最后一个**操作数是落地位置，前面的是被搬走的东西。
  // 全按目标判会把 `xcopy C:\Windows\System32\drivers\etc\hosts backup\`（改之前先备份）判成删系统文件。
  private static readonly DISASTER_MOVE_RE: RegExp =
    /^(?:copy|cp|xcopy|move|mv|rename|ren|tee|robocopy|install)$/i
  // 「目录树的第一层」：删掉整层就没有第二次机会（tmp/var/tmp 刻意不在里面 —— 它们本就是可丢弃的）
  private static readonly TOP_DIRS: string[] = [
    'bin', 'boot', 'dev', 'etc', 'home', 'lib', 'lib32', 'lib64', 'media', 'mnt', 'opt',
    'proc', 'root', 'run', 'sbin', 'srv', 'sys', 'usr', 'var',
    'windows', 'users', 'program files', 'program files (x86)', 'programdata', 'perflogs',
    'recovery', 'inetpub', 'system volume information', 'documents and settings',
    'applications', 'library', 'system', 'volumes', 'private'
  ]
  // 「就是某个人的主目录」的几种写法。%USERPROFILE% 与 userprofile 两个形态都要收：
  // 前者是原文，后者是 expandEnvRefs 把 %NAME% 换成裸名之后的形态。
  private static readonly HOME_FORM_RE: RegExp =
    /^(?:~|\$home|\$\{home\}|%home%|home$|\$profile|\$env:profile|\$env:userprofile|\$env:homepath|%userprofile%|userprofile|homepath|mydocuments|documents)$/i
  // 「第一段就是某个人的主目录」的写法（HOME_FORM_RE 管整条路径等于主目录，这里管路径的开头）：
  // users / home 这种「共享目录」形态要带绝对路径前提，见下面 rooted 的说明。
  private static readonly HOME_ROOT_RE: RegExp =
    /^(?:~|\$\{?(?:home|profile|userprofile|homepath|appdata|localappdata)\}?|\$env:\w*(?:profile|home|appdata|tmp)\w*|%[\w%]*(?:profile|home|appdata|tmp)[\w%]*|users|home|documents and settings)$/i
  // 主目录里那层「装这个人自己的文件」的目录：删掉它们等于删掉主目录的一部分，量级相同
  private static readonly USER_DATA_RE: RegExp =
    /^(?:documents|mydocuments|desktop|downloads|pictures|photos|videos|music|favorites|links|screenshots|contacts|calendar|notes|library|appdata|onedrive|google drive|iclouddrive)$/i
  // 关键系统文件与裸设备：**它们里面的东西**也一并算（删掉一个 account hive 就起了不来系统）
  private static readonly PROTECTED_TARGET_RE: RegExp =
    /^(?:\/(?:etc\/(?:passwd|shadow|group|gshadow|passwd-|shadow-|user-list|sudoers|crypttab|fstab|resolv\.conf|hostname|profile|pam\.conf|ld\.so\.conf|ssh\/host\w*|ssh\/sshd_config|pam\.d\/|security\/|default\/(?:useradd|grub)|systemd\/|init\.d\/|rc\d\.d\/)|bin\/(?:sh|bash|su|sudo|login|mount)|lib(?:32|64)?\/(?:ld-|libc\.|systemd)|dev\/(?:sd|hd|nvme|vd|xvd|md|dm-|loop|mapper|disk|aoe)\S*|proc\/sys(?:\/|$)|sys(?:\/|$)|boot(?:\/|$|img)|kernel[^/]*|vmlinuz\S*|initrd\S*|private\/etc\/(?:passwd|shadow|group|master\.passwd)|library\/keychains(?:\/|$)|system\/(?:library|kernel|usr)(?:\/|$))|(?:[a-z]:)?\/windows\/(?:system32(?:\/(?:config|drivers|winevt|catroot|spool|sysprep|wbem|group_policy|inetsrv)?(?:\/|$)|\/(?:cmd|services|lsass|wininit|userinit|csrss|smss|explorer|svchost)\.exe)?|boot(?:\/|$)|sysnative\/|winsxs(?:\/|$)|inf(?:\/|$)|system\.ini|win\.ini|explorer\.exe)|(?:[a-z]:)\/(?:boot(?:\/|$)|windows\/system32(?:\/|$))|(?:[a-z]:)?\/\$recycle\.bin(?:\/|$))/i

  /**
   * 把一个「看起来像路径」的 token 归一成目标形态：'' = 不构成灾难，root/home/sys/protected = 构成。
   *
   * 归一动作全部是**去掉伪装**（引号、@ 前缀、`name=` 前缀、`\` 与 `//`、大小写、尾部的整体通配），
   * 从不补全语义，所以判定用「原文 ∪ 还原文」的任何一份都只会多出命中。
   */
  private static disasterTargetKind(token: string): string {
    let raw: string = token.replace(CommandGuard.TOKEN_EDGE_RE, '').replace(/^['"]+|['"]+$/g, '')
    let eq: number = raw.lastIndexOf('=')
    if (eq >= 0 && /[\\/]/.test(raw.substring(eq + 1))) {
      raw = raw.substring(eq + 1)
    }
    if (raw === '' || !CommandGuard.looksLikePath(raw)) {
      return ''
    }
    let norm: string = raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase()
    // `C:\a\..\Windows\System32` 就是 `C:\Windows\System32`：不折这一段，「绕一层再进系统目录」
    // 就是一条免检路（实测 del /s /q C:\a\..\Windows\System32\* 只判成「删文件」）。
    // 只消 `名字/..` 这一种形状，`../` 开头的相对上跳原样留着 —— 它由边界层单独报，
    // 理由是「工作区之外」，比这里含糊的「系统目录」更贴近用户看得见的后果。
    while (/[^/]+\/\.\.(?:\/|$)/.test(norm)) {
      norm = norm.replace(/(?:^|\/)[^/]+\/\.\.(?=\/|$)/g, '')
    }
    norm = norm.replace(/^\.\//, '')
    norm = norm.replace(/\/{2,}/g, '/')
    // `\\127.0.0.1\c$\Windows\…` 与 `\\localhost\C$\…` 走的是**本机**管理共享：换的是一个写法，
    // 删的是同一块盘。不剥掉 host + share 两段，这一层就只能按「本地绝对路径」判，
    // 于是「从 UNC 入口删系统目录」绕开（实测 \\127.0.0.1\c$\Windows 只报了工作区越界）。
    // 只认本机那几个 host 名 —— 真正的远端共享不归这一层管，由边界层按「工作区之外」报。
    let local: RegExpExecArray | null =
      /^\/(?:127\.0\.0\.1|localhost|\[[0-9a-f:]+\]|\.|\?)(?:\/[^/]*(?:\$|:))?\/(.*)$/i.exec(norm)
    if (local !== null) {
      norm = '/' + local[1]
    }
    let absolute: boolean = norm.charAt(0) === '/' || /^[a-z]:/.test(norm)
    if (CommandGuard.PROTECTED_TARGET_RE.test(norm)) {
      return 'protected'
    }
    let drive: string = ''
    let dm: RegExpExecArray | null = /^([a-z]):/.exec(norm)
    if (dm !== null) {
      drive = dm[1]
      norm = norm.substring(2)
    }
    if (norm.charAt(0) === '/') {
      norm = norm.substring(1)
    }
    norm = norm.replace(/\/+$/, '')
    let segs: string[] = norm === '' ? [] : norm.split('/')
    // 尾部的「整体通配」段（*、*.*、*.log）不改变目标所在层级：C:\Users\me\*.* 删的就是 me 的主目录
    while (segs.length > 0 && segs[segs.length - 1].indexOf('*') !== -1) {
      segs.pop()
    }
    let path: string = segs.join('/')
    if (path === '') {
      return absolute || drive !== '' ? 'root' : ''
    }
    if (CommandGuard.HOME_FORM_RE.test(path)) {
      return 'home'
    }
    // 后面三种形态都要按「从哪里往下数」才成立，相对写法一律不算：项目里叫 `users/`、
    // `Documents/` 的目录天天都在（`rm -rf users/me` 删的是仓库里的两个文件夹，不是某个人的家）。
    let rooted: boolean = absolute || drive !== '' ||
      /^[~$%]/.test(segs[0])
    if (!rooted) {
      return ''
    }
    if (segs.length === 1 && CommandGuard.TOP_DIRS.indexOf(path) !== -1) {
      return 'sys'
    }
    // /home/<某人> 与 C:\Users\<某人>：某个用户的整个主目录
    if (segs.length === 2 && (segs[0] === 'home' || segs[0] === 'users') &&
      segs[1].indexOf('.') === -1) {
      return 'home'
    }
    // 主目录**里面**那层用户数据目录本身（~/Documents、%APPDATA%、C:\Users\me\Desktop）：
    // 里面是这个人攒的文件，删掉与删主目录同一量级。刻意限制深度（主目录形态下最多两级、
    // users/<某人>/X 形态下最多三级），否则 `rm -rf D:\repo\Documents` 这种「项目里叫
    // Documents 的目录」会被一路硬禁 —— 硬禁没有审批入口，误判的代价比漏判更高。
    if (segs.length >= 2 &&
      segs.length <= (/^(?:users|home|documents and settings)$/.test(segs[0]) ? 3 : 2) &&
      CommandGuard.HOME_ROOT_RE.test(segs[0]) &&
      CommandGuard.USER_DATA_RE.test(segs[segs.length - 1])) {
      return 'home'
    }
    return ''
  }

  /** 这个 token 像不像「路径形态的操作数」（纯词、开关、数字一概不判，免得把 `del = 0` 当成删根） */
  private static looksLikePath(token: string): boolean {
    let t: string = token.replace(CommandGuard.TOKEN_EDGE_RE, '')
    if (t === '' || CommandGuard.LEADING_SWITCH_RE.test(t) || /^\d+$/.test(t) ||
      t === '=' || t === '==') {
      return false
    }
    return /[\\/]/.test(t) || t.charAt(0) === '~' || t.charAt(0) === '$' || t.charAt(0) === '%' ||
      /^[a-z]:/i.test(t) || t.indexOf('=') !== -1
  }

  /**
   * 找出命令里第一个「灾难目标」：先看**重定向写入的目标**（`> /etc/passwd` 与删掉它等价），
   * 再看删除/清零类动词的操作数。返回命中的写法（进审批卡与拒绝理由），没有则空串。
   */
  private static firstDisasterTarget(text: string): string {
    let re: RegExp = new RegExp(CommandGuard.REDIRECT_TARGET_RE.source, 'g')
    let match: RegExpExecArray | null = re.exec(text)
    while (match !== null) {
      let kind: string = CommandGuard.disasterTargetKind(match[1])
      if (kind !== '') {
        return match[1]
      }
      match = re.exec(text)
    }
    let segments: string[] = text.split(CommandGuard.SEGMENT_SPLIT_RE)
    for (let s: number = 0; s < segments.length; s++) {
      let toks: string[] = segments[s].trim().split(/\s+/)
      let verb: number = -1
      let verbBase: string = ''
      for (let k: number = 0; k < toks.length; k++) {
        let raw: string = toks[k].replace(CommandGuard.TOKEN_EDGE_RE, '')
        let base: string = raw.substring(Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')) + 1)
        base = base.replace(/\.(?:exe|com)$/i, '')
        if (CommandGuard.DISASTER_DELETE_RE.test(base) || CommandGuard.DISASTER_WRITE_RE.test(base) ||
          CommandGuard.DISASTER_MOVE_RE.test(base)) {
          verb = k
          verbBase = base
          break
        }
      }
      if (verb < 0) {
        continue
      }
      // copy/move 一族的落地位置是**最后一个**操作数，前面那些是被搬走的东西：
      // 全按目标判会把 `xcopy C:\Windows\System32\drivers\etc\hosts backup\hosts.bak`
      // （改系统文件之前先备份一份）这条正当写法判成「删系统文件」。
      let at: number = CommandGuard.DISASTER_MOVE_RE.test(verbBase) ? toks.length - 1 : verb + 1
      for (let k: number = at; k < toks.length; k++) {
        let cand: string = toks[k].replace(CommandGuard.TOKEN_EDGE_RE, '')
        if (!CommandGuard.looksLikePath(cand)) {
          continue
        }
        if (CommandGuard.disasterTargetKind(cand) !== '') {
          return cand
        }
      }
    }
    return ''
  }

  // 盘根路径：cmd / PowerShell 里以**单个**反斜杠开头的写法是「当前盘根」，`\data\a.txt`
  // 就是 `C:\data\a.txt`。前缀刻意不收引号与字母数字 —— 脚本里的 `'\n\t'`、正则里的 `\d`
  // 都长这样，收进来等于把每一份带换行字面量的脚本都判成越界。
  private static readonly ROOT_PATH_RE: RegExp =
    /(?:^|[\s=,;|&(<])(\\[A-Za-z0-9_.$-][^\s"'`;|&<>()]*)/g

  // 转义序列的第一段：\n \t \r \0 \a \b \f \v \x \u \N —— 这些不是路径段
  private static readonly ESCAPE_HEAD_RE: RegExp = /^[ntr0abfvuxUN]{1,2}$/

  // 「第一段 + 还有后续分隔符」（\data\a.txt）或「名字.扩展名」（\a.txt）：只认这两种形状，
  // 单个 `\x` 与孤零零的 `\` 不在此列（它们更像转义或误敲，判了只会打扰用户）。
  private static readonly ROOT_SHAPE_A_RE: RegExp = /^\\[^\\/]+[\\/]/
  private static readonly ROOT_SHAPE_B_RE: RegExp = /^\\[^\\/]+\.[A-Za-z0-9]{1,6}$/

  /**
   * 找出命令里第一个指向工作区之外的「盘根」路径；没有则返回空串。
   *
   * 为什么单独立一条：工作区边界原先只认四种写法（盘符 / `..` / UNC / 环境变量），
   * 而 `\data\a.txt` 一条都不沾 —— 它没有盘符、没有上跳，ABS_PATH_RE 又只认得第二段恰好叫
   * Windows/Users 这类系统目录的形态。实测 `type \data\a.txt`、`copy \a.txt .`、
   * `echo x > \a.txt`、`dir \` 全部零审批直通，而它们读写的是**盘根**，与工作区毫无关系。
   * 盘根落在哪一块盘由进程 cwd（即工作区）所在的盘决定，所以拿 root 的盘符去拼再比前缀，
   * 工作区就在盘根下时不会误伤。
   */
  private static firstRootPathOutside(text: string, root: string): string {
    let drive: string = ''
    let head: RegExpExecArray | null = /^([a-zA-Z]):[\\/]/.exec(root)
    if (head !== null) {
      drive = head[1].toLowerCase() + ':'
    }
    let normRoot: string = CommandGuard.normalizePath(root).replace(/\/+$/, '')
    let re: RegExp = new RegExp(CommandGuard.ROOT_PATH_RE.source, 'g')
    let match: RegExpExecArray | null = re.exec(text)
    while (match !== null) {
      let token: string = match[1]
      // UNC（\\server\share）由 firstUncPathOutside 管，这里不重复报
      if (token.indexOf('\\\\') === 0 ||
        (!CommandGuard.ROOT_SHAPE_A_RE.test(token) && !CommandGuard.ROOT_SHAPE_B_RE.test(token))) {
        match = re.exec(text)
        continue
      }
      let first: string = token.replace(/^\\+/, '').split(/[\\/]/)[0]
      if (CommandGuard.ESCAPE_HEAD_RE.test(first)) {
        match = re.exec(text)
        continue
      }
      if (normRoot === '') {
        return token
      }
      let norm: string = CommandGuard.normalizePath(drive + token).replace(/\/+$/, '')
      if (norm !== normRoot && norm.indexOf(normRoot + '/') !== 0) {
        return token
      }
      match = re.exec(text)
    }
    return ''
  }

  // 找出命令里第一个「不在工作区内」的绝对路径；没有则返回空串
  private static firstPathOutsideWorkspace(text: string, root: string): string {
    // 归一后的根目录不带尾斜杠: 比较时按「等于根目录」或「根目录/ 开头」两种情况算在内
    let normRoot: string = root === '' ? '' :
      CommandGuard.normalizePath(root).replace(/\/+$/, '')
    let re: RegExp = new RegExp(CommandGuard.ABS_PATH_RE.source, 'gi')
    let tokenRe: RegExp = /[^\s"'`;|&)<>]+/g
    let match: RegExpExecArray | null = re.exec(text)
    while (match !== null) {
      // 盘符/系统目录那段必须落在 token 边界上才算绝对路径：`https://x/a.zip` 里的 `s://` 是 URL
      // 的冒号，`src/etc/passwd` 里的 `/etc/` 是相对路径的一段 —— 都不是绝对路径，
      // 报出去等于给每一条带 URL 的命令都添一条「触及工作区之外的路径」。
      let prev: string = match.index === 0 ? '' : text.charAt(match.index - 1)
      if (/[A-Za-z0-9]/.test(prev)) {
        re.lastIndex = match.index + 1
        match = re.exec(text)
        continue
      }
      // 从命中的起点开始吃一整段路径 token
      let start: number = match.index
      tokenRe.lastIndex = start
      let tokenMatch: RegExpExecArray | null = tokenRe.exec(text)
      let token: string = tokenMatch !== null ? tokenMatch[0] : match[0]
      if (normRoot === '') {
        return token
      }
      let normToken: string = CommandGuard.normalizePath(token).replace(/\/+$/, '')
      if (normToken === normRoot || normToken.startsWith(normRoot + '/')) {
        match = re.exec(text)
        continue
      }
      return token
    }
    return ''
  }

  // 一个命令行 token：空白与引号、重定向、管道、括号都做分隔（引号会把 token 切开，
  // 正好是我们想要的 —— "..\x" 里的 .. 一样得上跳）
  private static readonly TOKEN_RE: RegExp = /[^\s"'`;|&)<>]+/g

  // 「..」要真的是一段路径的开头才算上跳：前面是 token 开头或 \ / = 之一，后面是结尾或分隔符。
  // 这样 HEAD~1..HEAD、1..5、v1..v2 一类区间写法不会被冤枉，而 --prefix=../outside
  // 这种把越界挂在参数上的写法也跑不掉。
  private static readonly UP_SEGMENT_RE: RegExp = /(?:^|[\\/=])\.\.(?=$|[\\/])/

  /** 找出命令里第一个「展开后必然出圈」的环境变量引用；没有则返回空串 */
  private static firstEnvPathOutside(text: string): string {
    let re: RegExp = new RegExp(CommandGuard.ENV_TOKEN_RE.source, 'gi')
    let match: RegExpExecArray | null = re.exec(text)
    while (match !== null) {
      let name: string = match[1] !== undefined ? match[1] : match[2]
      let rest: string = text.substring(match.index + match[0].length)
      let at: number = 0
      while (at < rest.length && CommandGuard.ENV_SEPARATORS.indexOf(rest.charAt(at)) !== -1) {
        at++
      }
      let asPath: boolean = rest.charAt(at) === '\\' || rest.charAt(at) === '/'
      // 认得出名字的（临时目录、系统目录、用户目录）本来就全在工作区之外，`dir %TEMP%` 不带分隔符也是越界；
      // 认不出名字的只在「明显被当路径用」时才算，且长度小于 3 的一律放过 —— cmd 的循环变量
      // （%f、%CD% 这类）就在工作区里，不能因为一个反斜杠打扰用户。
      if (CommandGuard.ENV_OUTSIDE_NAMES.test(name) || (asPath && name.length >= 3)) {
        return match[0]
      }
      match = re.exec(text)
    }
    return ''
  }

  /**
   * 找出命令里第一个含「.. 上跳段」的 token；没有则返回空串。
   *
   * 为什么单独立一条：工作区是命令唯一的活动范围，但 shell 里的相对路径不受任何约束 ——
   * `dir ..`、`echo x > ..\y.txt` 直接读写了工作区的父目录，而绝对路径正则（ABS_PATH_RE）
   * 只认「带盘符或系统目录开头」的写法，对这类上跳完全无感。实测过一次静默越界：
   * 同一条 `dir .. /b` 无审批直接列出了父目录，而 `type C:\Windows\win.ini` 却被拦下问人。
   */
  private static firstUpTraversal(text: string): string {
    let re: RegExp = new RegExp(CommandGuard.TOKEN_RE.source, 'g')
    let match: RegExpExecArray | null = re.exec(text)
    while (match !== null) {
      if (CommandGuard.UP_SEGMENT_RE.test(match[0])) {
        return match[0]
      }
      match = re.exec(text)
    }
    return ''
  }

  /**
   * 找出命令里第一个指向工作区之外的 UNC/网络路径；没有则返回空串。
   *
   * 为什么单独一条：工作区边界原先只认「盘符绝对路径」「.. 上跳」「环境变量路径」三种写法，
   * 而 SMB 路径一条都不沾 —— `\\server\share` 没有盘符，`\\localhost\c$\Users` 的第二段是共享名
   * 而不是系统目录名，所以 `dir \\127.0.0.1\c$\Users` 连绝对路径规则都不会碰它。影响是整台机器：
   * `\\localhost\c$` 就是本机 C 盘的管理共享，读写它等于绕过整个工作区约束；对远端共享则是外发通道。
   * 与绝对路径同档（risky）：正当的跨共享操作仍然可以经审批放行。
   *
   * 工作区自己就在网络共享上时不误伤：把 `\\?\` / `\\.\` 扩展前缀归一掉之后按前缀比较。
   */
  private static firstUncPathOutside(text: string, root: string): string {
    let normRoot: string = CommandGuard.normalizePath(root).replace(/\/+$/, '').replace(/^\/\/\?\//, '')
    let re: RegExp = new RegExp(CommandGuard.TOKEN_RE.source, 'g')
    let match: RegExpExecArray | null = re.exec(text)
    while (match !== null) {
      // 引号与 @ 只是伪装，token 边界已经把前后引号切开了
      let token: string = match[0].replace(CommandGuard.TOKEN_EDGE_RE, '')
      // `--out=\\server\share` 这种把路径挂在参数上的写法：UNC 前缀前面还有一段 `name=`。
      // 取最后一个 = 之后的部分再判，URL（https://…）不以此开头，不会被当成 UNC。
      let candidate: string = token
      let eq: number = candidate.lastIndexOf('=')
      if (eq >= 0 && eq + 1 < candidate.length) {
        candidate = candidate.substring(eq + 1)
      }
      // 脚本源码里的 UNC 会写成 `\\\\server\\share`（每个分隔符都被转义成两个），
      // 判定前先把连续分隔符折成一个，否则「宿主 + 分隔符 + 共享名」这条结构在脚本里永远对不上。
      let probe: string = candidate
      if (/^(?:\\\\|\/\/)/.test(probe)) {
        let sep: string = probe.charAt(1)
        probe = sep + sep + probe.replace(/^[\\/]+/, '').replace(/[\\/]+/g, sep)
      }
      if (CommandGuard.UNC_TOKEN_RE.test(probe)) {
        let norm: string = CommandGuard.normalizePath(candidate).replace(/^\/\/\?\//, '')
        if (normRoot === '' || (norm !== normRoot && norm.indexOf(normRoot + '/') !== 0)) {
          return token
        }
      }
      match = re.exec(text)
    }
    return ''
  }

  // 命令里可能被「执行」的脚本后缀。只收到能被 shell/解释器直接跑起来的那些：
  // .json/.md/.txt 这类数据文件不算，否则读任何配置文件都要打扰用户。
  private static readonly SCRIPT_EXT_RE: RegExp =
    /\.(?:ps1|psm1|bat|cmd|sh|bash|zsh|vbs|js|mjs|cjs|py|pyw|rb|pl|lua|ahk|wsf)$/i

  // 通配形态的「文件名」不是一个具体文件，读不了内容，也不该据此打扰用户
  private static readonly GLOB_RE: RegExp = /[*?[\]]/

  // 解释器与脚本宿主：它们的第一个位置参数就是「要跑的那段代码」。
  // call 也在内 —— cmd 的 call 同样不管后缀，把 .txt 当批处理逐行执行。
  private static readonly EXEC_HOST_TOKEN_RE: RegExp =
    /^(?:node|iojs|deno|bun|python\d?|pypy|py|ruby|perl|php|lua|tclsh|sh|bash|zsh|dash|ksh|cscript|wscript|mshta|call)$/i

  // 数据文件后缀（内容审阅够不着、又确实能被上面那些解释器当代码执行的那一批）
  private static readonly DATA_EXT_RE: RegExp =
    /\.(?:txt|dat|log|tmp|bak|old|new|bin|ini|cfg|conf|csv|tsv|json|jsonl|md|markdown|html?|xml|ya?ml|pdf|zip|gz|tar|7z|png|jpe?g|gif|svg|docx?|xlsx?|pptx?)$/i

  // 参数开关（-c、/y、//E:vbscript、--foo=bar）。路径不会长这样，所以不用当心 /tmp/x.sh 被当成开关。
  private static readonly SWITCH_TOKEN_RE: RegExp = /^[-/][\w:/=.+-]*$/i

  // 「按命令里出现的文件字面量决定执行什么」的宿主。它们一旦出现在命令里，同审就要去读那个文件，
  // 无论它叫什么后缀（见 scriptRefs）—— cscript 能把 payload.txt 当 VBS 跑，//E: 就是它自己声明的引擎。
  private static readonly SCRIPT_HOST_RE: RegExp =
    /(?:^|[\s;&|(\\/])@?(?:cscript|wscript|mshta)(?:\.exe)?\b|\/\/E\s*[:=]|vbscript:/i

  // 宿主的文件操作数：带后缀、不是开关、不是宿主自己
  private static readonly HOST_OPERAND_RE: RegExp = /^[^\d\-/\\][\w.~+@:/\\-]*\.[A-Za-z][A-Za-z0-9]{0,4}$/i
  private static readonly HOST_SELF_RE: RegExp = /^(?:cscript|wscript|mshta)\.(?:exe|com)$/i

  // 命令位上「程序名本身就是危险动作」的那批词，判定不看参数形态。
  // 只放词表覆盖不到的：diskpart/bcdedit/mkfs 这些词本身没有别的含义，子串匹配就够；
  // format 不行 —— 它同时是 `npm run format`、`--format=%h` 里的普通词，必须按位置判。
  private static readonly POSITIONAL_FORBIDDEN: Rule[] = [
    { re: /(?:^|[\\/])format(?:\.com|\.exe)?$/, why: '格式化磁盘' },
    // 注销与停机在 Windows 上是几个普通词（logoff/halt），子串匹配会误伤路径与脚本正文，
    // 按命令位判才既堵得住 `logoff`、又放过 `echo logoff x`（关机硬禁原先只认 shutdown|reboot|poweroff）。
    { re: /(?:^|[\\/])(?:logoff|halt|tsskill|bootrec|stop-computer|restart-computer)(?:\.exe)?$/, why: '关机/重启/注销整台机器' }
  ]
  private static readonly POSITIONAL_RISKY: Rule[] = [
    { re: /(?:^|[\\/])cp(?:\.exe)?$/, why: '覆盖写文件（cp 默认不提示）' },
    // robocopy 与 cp 同一档：覆盖是它的**默认行为**，不需要任何开关，而且它为脚本设计、
    // 永不像 copy/move 那样问「Overwrite?」——没有 TTY 时那两个会挂住，它直接把目标目录里的
    // 同名文件换掉（实测零参数 robocopy 源 目标 全程无卡，目标从 53B 变 33B）。
    // 按命令位判而不是按开关判：补登记 /MIR 那类开关堵不住默认行为。
    { re: /(?:^|[\\/])robocopy(?:\.exe)?$/, why: '复制到指定目录（默认静默覆盖同名文件，且不会询问）' },
    { re: /(?:^|[\\/])install(?:\.exe)?$/, why: '安装/覆盖到指定路径' },
    { re: /(?:^|[\\/])truncate(?:\.exe)?$/, why: '清空文件内容' },
    { re: /(?:^|[\\/])ln(?:\.exe)?$/, why: '创建链接（可把读写引到工作区之外）' },
    { re: /(?:^|[\\/])chattr(?:\.exe)?$/, why: '改文件不可变属性位' },
    { re: /(?:^|[\\/])(?:ssh|scp|sftp|nc|ncat|netcat|telnet|rlogin|rsh|adb)$/, why: '外部执行/传输通道（远端那侧做什么读不出）' },
    // 这几个词同时是很常见的变量名/文件名（mount 在前端代码里天天出现），所以只按命令位判：
    // `component.mount()`、`--mount type=bind` 都不算，而真正被运行的 mount/umount 一律要问一句。
    { re: /(?:^|[\\/])(?:mount|umount|swapon|swapoff|losetup|zloop?|pm-utils)$/, why: '改挂载点或交换区（能让目录内容整体不可见）' },
    { re: /(?:^|[\\/])(?:chroot|nsenter|unshare|procdump|createdump|passwd|chpasswd|groupmems)$/, why: '切根/进他人命名空间执行，或改口令、转储进程内存' }
  ]

  private static readonly SEGMENT_SPLIT_RE: RegExp = /&&|\|\||[;&|\n]/
  // 包一层的壳：它自己不是「要运行的那条」，真正危险的是它后面的命令位
  private static readonly WRAPPER_RE: RegExp =
    /^(?:cmd|command|powershell|pwsh|bash|sh|zsh|dash|ksh|wsl|start|sudo|nohup|runas|time|env)(?:\.exe|\.com)?$/i
  // cmd 的单字母开关（/c、/q）与 POSIX 长开关（--exec、-n）；`/etc/passwd` 这种路径不算开关
  private static readonly LEADING_SWITCH_RE: RegExp = /^\/[a-z](?![\w.\\/-])|^-{1,2}[\w-]+$/i
  private static readonly TOKEN_EDGE_RE: RegExp = /^[@'"`]+|['"`]+$/g

  /**
   * 把一个 token 还原成「cmd 真正会执行的那个词」：去掉 cmd 的 ^ 转义与拆词用的引号。
   *
   * 为什么每个「按词比对」的地方都要过它：关键词表早就按「原文 ∪ 还原文」判了，
   * 但**裸名脚本同审**（bareScriptTokens）与命令位判定（commandPrograms）原先只看原文，
   * 于是 `ca^ll clean` 这样的写法两头都对不上 —— `ca^ll` 不是任何已知的壳、也不是合法的裸名，
   * 循环当场 break，后面那个 `clean`（PATHEXT 补成 clean.bat 再执行）连一次内容审阅都没触发。
   * 实测：把 `del` 写进 clean.bat，`call clean` 会走同审，`ca^ll clean` 则零审批直接执行。
   * 同一个缺口对 `co^py a b`、`nod^e payload.txt` 一样成立，所以统一在这里还原一次。
   */
  static plainToken(raw: string): string {
    return raw.replace(CommandGuard.TOKEN_EDGE_RE, '').replace(/\^/g, '').replace(/["'`]/g, '')
  }

  /**
   * 取每一段「命令位」上真正要被运行的那个程序（小写、去 @ 与引号、跳过开关与包一层的壳）。
   * 只取每段的第一个非开关程序名，参数位一概不收 —— 这是「程序名 vs 参数内容」的区分，
   * 词表级子串匹配做不到（`echo del x`、`npm run format` 都在参数位）。
   */
  private static commandPrograms(texts: string[]): string[] {
    let out: string[] = []
    for (let t: number = 0; t < texts.length; t++) {
      let segments: string[] = texts[t].split(CommandGuard.SEGMENT_SPLIT_RE)
      for (let i: number = 0; i < segments.length; i++) {
        let toks: string[] = segments[i].trim().split(/\s+/)
        for (let k: number = 0; k < toks.length; k++) {
          // 命令位上的词先还原伪装：`form^at`、`de^l`、`ca^ll` 执行时就是 format/del/call，
          // 只看原文等于让程序名这一层被一个 ^ 绕过去（与 bareScriptTokens 同一个缺口）。
          let raw: string = CommandGuard.plainToken(toks[k]).toLowerCase()
          if (raw === '' || CommandGuard.LEADING_SWITCH_RE.test(raw)) {
            continue
          }
          if (CommandGuard.WRAPPER_RE.test(raw)) {
            continue
          }
          // 后面紧跟赋值号的是「变量名」不是「要运行的程序」：脚本同审读的是代码，
          // Python 里 `cp = shutil.copy(...)` 这种一行不该被当成 cp 命令。
          let next: string = k + 1 < toks.length ? toks[k + 1].replace(CommandGuard.TOKEN_EDGE_RE, '') : ''
          if (next === '=' || next === '==' || next === '=>') {
            break
          }
          if (out.indexOf(raw) === -1) {
            out.push(raw)
          }
          break
        }
      }
    }
    return out
  }

  /** 命令位程序名过一遍规则表，返回命中的理由 */
  private static matchedPrograms(programs: string[], rules: Rule[]): string[] {
    let hits: string[] = []
    for (let i: number = 0; i < programs.length; i++) {
      for (let j: number = 0; j < rules.length; j++) {
        if (rules[j].re.test(programs[i]) && hits.indexOf(rules[j].why) === -1) {
          hits.push(rules[j].why)
        }
      }
    }
    return hits
  }

  // `~`、`~/x`、`$HOME`、`${HOME}/x` —— 由 shell 决定指向哪的写法，展开后必然是用户主目录
  private static readonly HOME_TOKEN_RE: RegExp =
    /^~(?:[/\\][^\s"'`;|&<>()]*)?$|^\$HOME(?:[/\\][^\s"'`;|&<>()]*)?$|^\$\{HOME\}(?:[/\\][^\s"'`;|&<>()]*)?$/i

  /** 找出命令里第一个 ~ / $HOME 形态的操作数；没有则返回空串 */
  private static firstHomeOperand(texts: string[]): string {
    for (let t: number = 0; t < texts.length; t++) {
      let re: RegExp = new RegExp(CommandGuard.TOKEN_RE.source, 'g')
      let match: RegExpExecArray | null = re.exec(texts[t])
      while (match !== null) {
        // 前面的 @ 与引号只是伪装（unobfuscate 已去引号，这里连原文一起判）
        let token: string = match[0].replace(CommandGuard.TOKEN_EDGE_RE, '')
        if (CommandGuard.HOME_TOKEN_RE.test(token)) {
          return match[0]
        }
        match = re.exec(texts[t])
      }
    }
    return ''
  }

  /**
   * 找出「被解释器执行的、后缀不是代码文件」的那个操作数；没有则返回空串。
   *
   * 只看**第一个**位置参数：`python parse.py data.json` 里 data.json 是脚本自己的输入，
   * 天天有人这么写，不该打扰用户；而 `node payload.txt` 的第一个位置参数就是代码本身。
   */
  private static firstExecDataOperand(text: string): string {
    let parts: string[] = text.split(/[\s;&|<>()"'`]+/)
    for (let i: number = 0; i < parts.length; i++) {
      let base: string = parts[i]
      let slash: number = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'))
      if (slash >= 0) {
        base = base.substring(slash + 1)
      }
      if (!CommandGuard.EXEC_HOST_TOKEN_RE.test(CommandGuard.plainToken(base))) {
        continue
      }
      for (let j: number = i + 1; j < parts.length; j++) {
        let arg: string = parts[j]
        if (arg === '' || CommandGuard.SWITCH_TOKEN_RE.test(arg)) {
          continue
        }
        // 只看这一个位置参数：数据后缀就是载荷，否则这个宿主干净，继续找下一个宿主
        if (CommandGuard.DATA_EXT_RE.test(arg)) {
          return arg
        }
        break
      }
    }
    return ''
  }

  // 写重定向的目标：`> x` / `>> x` / `> "x"` / `1>x`；`2>&1` 这类不当路径用（目标以 & 开头，token 类里已排除）
  private static readonly REDIRECT_TARGET_RE: RegExp =
    />>?\s*("[^"\n]*"|'[^'\n]*'|[^\s"'`;|&<>()]+)/g

  /**
   * 找出命令里第一个「被重定向写入的脚本文件」；没有则返回空串。
   *
   * 为什么单独立一条：脚本同审（CommandService.auditScripts）必须在命令跑起来**之前**读文件，
   * 而写文件本身不在危险表里（与 write_file 同一口径）。两者合在一起就是一条免检通道：
   * `type payload.txt > run.bat && call run.bat` —— 同审看到的是 run.bat 的旧内容（干净），
   * 命令跑起来先把它换成 payload.txt（不在同审后缀表里，一个字都不会被读），再 call 它。
   * 实测这条命令零审批执行了 payload.txt 里的 del。
   *
   * 只认脚本后缀（与 SCRIPT_EXT_RE 同一把尺子）：`dir > listing.txt`、`git diff > patch.diff`
   * 这些日常写法不该被打扰；而「把内容写进 .bat/.ps1/.py/.js」本身就是「接下来要执行的一段代码」，
   * 值得人看一眼。
   */
  // 「把内容写进目标文件」的那批程序：它们的**最后一个操作数**就是被覆盖/新建的文件，
  // 与重定向是同一件事的另一种写法。实测 `copy payload.txt run.bat && call run.bat` 零审批跑出了
  // payload 里的内容（同审读到的是 copy 之前的干净旧脚本）—— 上一轮只堵了 `>`，这条平行路径没堵。
  private static readonly WRITE_VERB_RE: RegExp =
    /^(?:copy|xcopy|move|mv|ren|rename|tee|tftp|expand|replace|robocopy|cp|install|rsync)$/i

  /**
   * 找出「被写入型命令覆盖/新建的脚本文件」；没有则返回空串。
   *
   * 判据落在**动词 + 它的操作数**上：`copy 源 目标`、`xcopy 源 目标`、`move 源 目标`、
   * `tee 文件`、`tftp … GET 目标` —— 只要某个操作数带脚本后缀（与 SCRIPT_EXT_RE 同一把尺子）就命中，
   * 因为无论是拷贝还是被覆盖，这条命令都在**改一个接下来可能被执行的脚本**。
   * 从后往前找（目标通常在最后），`copy a.txt b.txt`、`robocopy src dist` 这类照旧不打扰。
   */
  private static firstScriptCopyTarget(text: string): string {
    let segments: string[] = text.split(CommandGuard.SEGMENT_SPLIT_RE)
    for (let s: number = 0; s < segments.length; s++) {
      let toks: string[] = segments[s].trim().split(/\s+/)
      let verb: string = ''
      let operands: string[] = []
      for (let k: number = 0; k < toks.length; k++) {
        let raw: string = toks[k].replace(CommandGuard.TOKEN_EDGE_RE, '')
        // 输入重定向（`tee run.js < payload.txt`）后面的都是数据源，不是被写的目标
        if (raw.indexOf('>') !== -1 || raw.indexOf('<') !== -1) {
          if (verb !== '') {
            break
          }
          continue
        }
        if (raw === '' || CommandGuard.LEADING_SWITCH_RE.test(raw)) {
          continue
        }
        let base: string = raw
        let slash: number = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'))
        if (slash >= 0) {
          base = base.substring(slash + 1)
        }
        base = base.replace(/\.(?:exe|com)$/i, '')
        // 动词同样要还原伪装：`co^py payload.txt run.bat` 与 `copy …` 是同一件事
        base = CommandGuard.plainToken(base)
        if (verb === '') {
          if (!CommandGuard.WRITE_VERB_RE.test(base)) {
            break
          }
          verb = base.toLowerCase()
          continue
        }
        operands.push(raw)
      }
      if (verb === '') {
        continue
      }
      for (let o: number = operands.length - 1; o >= 0; o--) {
        if (CommandGuard.SCRIPT_EXT_RE.test(operands[o])) {
          return operands[o]
        }
      }
    }
    return ''
  }

  private static firstScriptWriteTarget(text: string): string {
    let re: RegExp = new RegExp(CommandGuard.REDIRECT_TARGET_RE.source, 'g')
    let match: RegExpExecArray | null = re.exec(text)
    while (match !== null) {
      let target: string = match[1].replace(/^["']+|["']+$/g, '')
      if (CommandGuard.SCRIPT_EXT_RE.test(target)) {
        return target
      }
      match = re.exec(text)
    }
    return ''
  }

  /**
   * 一个 token 像不像「没有扩展名的脚本名」。
   * 判据刻意只落在**最后一段**上：目录名带点是常态（`.smoke/bt/clean`、`v1.2/bin/tool`），
   * 而「最后一段带扩展名」才说明它指向的是一个有类型的具体文件（a.txt、parse.py 交给 scriptRefs）。
   */
  private static isBareScriptName(name: string): boolean {
    if (name === '' || name.length > 120 || !/^[A-Za-z0-9_.\\/-]+$/.test(name)) {
      return false
    }
    let segs: string[] = name.split(/[\\/]/)
    let last: string = segs[segs.length - 1]
    return /^[A-Za-z0-9_-]+$/.test(last)
  }

  // 包一层的壳：它自己不是「要跑的那个」，真正的脚本名在它后面（call clean / start build / cmd /c clean）
  private static readonly SCRIPT_WRAPPER_RE: RegExp =
    /^(?:cmd|command|powershell|pwsh|bash|sh|zsh|dash|ksh|call|start|exec|sudo|doas|nohup|runas|time|env|wsl|chcp)$/i

  /**
   * 取出命令里**可能**是「裸名脚本」的那些 token。
   *
   * 为什么需要它：cmd 的 PATHEXT 会在裸名后面补 .bat/.cmd/.ps1… 再执行，而 scriptRefs 只按后缀筛。
   * 于是把破坏写进 `tools\clean.bat`、再用 `call tools\clean` 调起来，整个脚本同审被跳过 ——
   * 命令行里一个危险词都没有，脚本内容一个字都没读（实测 setup / call setup / call tools\clean /
   * start setup 四种写法全部零审批直通）。
   *
   * 这里只做文本侧判断（哪些 token 可能是那个裸名），文件到底在不在由 CommandService 查 ——
   * 纯文本层不知道 cwd 下有没有 clean.bat，也不该猜；猜的结果是每条命令都多一问。
   */
  static bareScriptTokens(command: string): string[] {
    let out: string[] = []
    let segments: string[] = command.split(CommandGuard.SEGMENT_SPLIT_RE)
    for (let s: number = 0; s < segments.length; s++) {
      let toks: string[] = segments[s].trim().split(/\s+/)
      for (let i: number = 0; i < toks.length; i++) {
        // 这一层必须看到「真正被敲下去的那个词」：`ca^ll clean` 执行时就是 `call clean`，
        // 只按原文比会把 `ca^ll` 当成未知程序名然后 break —— 后面的 `clean` 永远进不了同审。
        // 实测（本轮）把 `del` 写进 clean.bat 后：`call clean` 会走同审，`ca^ll clean` 零审批执行。
        let plain: string = CommandGuard.plainToken(toks[i])
        if (plain === '' || CommandGuard.LEADING_SWITCH_RE.test(plain) || /^\d+$/.test(plain)) {
          continue
        }
        let bare: string = plain.replace(/\.(?:exe|com)$/i, '')
        // 包一层的壳与它自己的开关都跳过，接着往后面找真正的名字
        if (CommandGuard.SCRIPT_WRAPPER_RE.test(bare)) {
          continue
        }
        let name: string = plain.replace(/^\.\//, '').replace(/^\.\\/, '')
        if (CommandGuard.isBareScriptName(name) && out.indexOf(name) === -1 && out.length < 8) {
          out.push(name)
        }
        break
      }
    }
    return out
  }

  /**
   * 取出命令里需要「同审内容」的文件。
   * 判定只看命令文本，而 `run.bat` / `node cleanup.js` 的危险全在文件里 —— 这里把文件名交出去，
   * 由 CommandService 读进内容过同一套判定（见 assessScript）。
   *
   * 两条入口：常见脚本后缀（不看命令是什么），以及**脚本宿主的文件操作数**（不看后缀）。
   * 后者必须有：cscript/wscript 把 payload.txt 当代码跑一点意见都没有，只按后缀筛等于
   * 「改个扩展名就把危险藏好」（实测这样删掉了文件、读到了 C:\Windows\win.ini）。
   *
   * 通配形态（`*.js`、`src/?.py`）不收：那指向的是一批文件而不是某一个具体脚本，
   * 否则 `find . -name "*.js"` 这类日常写法会被当成「引用了一个读不到的脚本」而去打扰用户。
   */
  static scriptRefs(command: string): string[] {
    let parts: string[] = []
    // 带引号的整段先取出来（"My Scripts\clean up.ps1" 是一个文件，不是两个 token），
    // 再把这段引号从文本里挖掉，剩下的才按空白切 token —— 否则引号内的半个路径会被当成第二个脚本。
    let rest: string = ''
    let cursor: number = 0
    let quotedRe: RegExp = /"([^"\n]+)"/g
    let match: RegExpExecArray | null = quotedRe.exec(command)
    while (match !== null) {
      parts.push(match[1])
      rest += command.substring(cursor, match.index) + ' '
      cursor = match.index + match[0].length
      match = quotedRe.exec(command)
    }
    rest += command.substring(cursor)
    let bareRe: RegExp = /[^\s"'`;|&<>()]+/g
    match = bareRe.exec(rest)
    while (match !== null) {
      parts.push(match[0])
      match = bareRe.exec(rest)
    }
    let refs: string[] = []
    let byHost: boolean = CommandGuard.SCRIPT_HOST_RE.test(command)
    for (let i: number = 0; i < parts.length && refs.length < 8; i++) {
      let part: string = parts[i].trim().replace(/^['"]+|['"]+$/g, '')
      if (part.length === 0 || part.length > 260 || refs.indexOf(part) !== -1) {
        continue
      }
      if (CommandGuard.GLOB_RE.test(part)) {
        continue
      }
      let review: boolean = CommandGuard.SCRIPT_EXT_RE.test(part)
      if (!review && byHost && !CommandGuard.HOST_SELF_RE.test(part) &&
        CommandGuard.HOST_OPERAND_RE.test(part)) {
        review = true
      }
      if (review) {
        refs.push(part)
      }
    }
    return refs
  }
}
