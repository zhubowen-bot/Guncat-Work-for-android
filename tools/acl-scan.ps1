$ErrorActionPreference = 'SilentlyContinue'
$lock = [hashtable]::Synchronized(@{})
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SidUtil {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool ConvertStringSidToSidW(string StringSid, out IntPtr Sid);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern bool IsValidSid(IntPtr pSid);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern int GetSidLength(IntPtr pSid);
  [DllImport("kernel32.dll")]
  public static extern IntPtr LocalFree(IntPtr h);
}
"@ -ErrorAction SilentlyContinue

function Resolve-SidName([string]$sid) {
  try {
    $acct = (New-Object System.Security.Principal.SecurityIdentifier($sid)).Translate([System.Security.Principal.NTAccount])
    return $acct.Value
  } catch { return $null }
}

$targets = @(
  "$env:APPDATA\Guncat Work",
  "$env:APPDATA",
  "$env:LOCALAPPDATA\CrashDumps",
  "C:\Users\a1519\Documents\Guncat-Work-for-web\release\Guncat Work-0.1.0",
  "$env:LOCALAPPDATA\Programs\DeepSeek Harness"
)

$orphans = @{}
$allSids = @{}

foreach ($t in $targets) {
  if (-not (Test-Path -LiteralPath $t)) { Write-Output "MISSING: $t"; continue }
  $items = @(Get-Item -LiteralPath $t -Force)
  $items += @(Get-ChildItem -LiteralPath $t -Recurse -Force)
  foreach ($it in $items) {
    $acl = Get-Acl -LiteralPath $it.FullName -ErrorAction SilentlyContinue
    if (-not $acl) { continue }
    foreach ($ace in $acl.Access) {
      $sid = $ace.IdentityReference.Value
      if ($sid -notmatch '^S-\d-\d+(-\d+)+$') { continue }
      if (-not $allSids.ContainsKey($sid)) {
        $name = Resolve-SidName $sid
        $allSids[$sid] = $name
        if ($null -eq $name) {
          Write-Output "ORPHAN SID: $sid  (cannot translate)  owner-process-user=$env:USERNAME"
        }
      }
      if ($null -eq $allSids[$sid]) {
        if (-not $orphans.ContainsKey($sid)) { $orphans[$sid] = New-Object System.Collections.ArrayList }
        [void]$orphans[$sid].Add($it.FullName)
      }
    }
  }
}

Write-Output ""
Write-Output "=== distinct SIDs seen (targets) and resolution ==="
foreach ($k in ($allSids.Keys | Sort-Object)) {
  $v = $allSids[$k]
  Write-Output ("{0,-52} -> {1}" -f $k, $(if ($null -eq $v) { '*** UNRESOLVED (ORPHAN) ***' } else { $v }))
}

Write-Output ""
Write-Output "=== orphan SID usage ==="
if ($orphans.Count -eq 0) { Write-Output "none found in scanned targets" }
foreach ($k in $orphans.Keys) {
  Write-Output "SID $k on $($orphans[$k].Count) items; first 15:"
  $orphans[$k] | Select-Object -First 15 | ForEach-Object { Write-Output "    $_" }
}
