# SourceWeft local sandbox: one-time elevated setup (Windows).
#
# The app runs this script through Start-Process -Verb RunAs, so Windows shows its own UAC
# prompt; the app never sees a password. The script is embedded in the app and passed to
# powershell.exe as -EncodedCommand (nothing is read from a file a user could change before it
# runs), preceded by a few lines the app builds from validated values only:
#
#   $Action          install or uninstall
#   $RunId           a GUID naming this run (a stale result file is ignored by it)
#   $ProgramFilesB64 the Program Files directory the app got from Windows, UTF-8, base64. The
#                    script asks Windows itself and stops when the two differ (exit 44).
#   $Sha256          64 hex characters, or empty: the SHA-256 that srt-win.exe must have. It is
#                    the value pinned inside the app (sandbox-sidecar/srt-win-pin.json), NOT a
#                    value from the extracted runtime, whose manifest any process of the user can
#                    rewrite.
#   $BundleB64       the runtime directory that holds srt-win.exe, UTF-8, base64 (so nothing in a
#                    path can be interpreted by PowerShell), or empty
#
# Where things are is never taken from environment variables (a process of the same user can set
# them for the app): Program Files comes from the .NET known-folder call, and the directories
# the script creates and uses are checked before anything is put in them (exit 45): not a
# reparse point, owned by an administrator account, and not writable through any entry that
# grants write access to anyone else.
#
# install:
#   1. Copies srt-win.exe from the runtime into Program Files\SourceWeft\sandbox (administrators
#      write, Users read and execute) under a temporary name.
#   2. Hashes the COPY, inside that directory, and compares it with $Sha256 before anything
#      executes it. A different file is deleted and the script stops (exit 41).
#   3. Renames the copy into place and runs: srt-win.exe install --proxy-port-range 60180-60189
#      That creates the sourceweft-sandbox account and the network rules. It is the namespaced
#      build, so an upstream default install is neither read nor changed. --force is never used:
#      a conflicting install makes srt-win exit 13 and the script reports it.
# uninstall:
#   Runs srt-win.exe uninstall from the staged copy and removes the staged directory. When the
#   staged copy is missing it stages the pinned, hash-checked file from the runtime (given in
#   $BundleB64) and uses that. With neither, it succeeds only if there is nothing to remove (no
#   sandbox account); a sandbox account that cannot be removed is exit 46, never a silent success.
#
# The sandbox account runs srt-win.exe itself as the second hop of every launch, which is why the
# helper lives in Program Files and not in the per-user app data.
#
# Result: Program Files\SourceWeft\sandbox-setup-result.json holds {runId, exit, message}. Only
# administrators can create files there. Exit codes: 0 done; the codes of srt-win itself pass
# through (12 network rules, 13 conflicting install, 14 account, 17 write-deny stamps, 22 a
# sandbox session is running); of this script: 40 not elevated, 41 hash mismatch, 42 failure of
# this script, 43 bad input, 44 Program Files differs from what the app expected, 45 a directory
# that is not protected, 46 a sandbox account that cannot be removed without its helper. The app
# words these; the message is only srt-win output or an error.
#
# This file must stay ASCII, free of single quote characters, block comments and here-strings:
# the app removes comment lines and indentation before encoding it, and a test checks all of it.
Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

$Root = [Environment]::GetFolderPath("ProgramFiles")
$Base = Join-Path $Root "SourceWeft"
$Dir = Join-Path $Base "sandbox"
$Exe = Join-Path $Dir "srt-win.exe"
$Trusted = @("S-1-5-18", "S-1-5-32-544", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", "S-1-3-0")

# Writes the result file (best effort) and ends the process with $Code.
function Finish([int]$Code, [string]$Message) {
    try {
        $Json = ConvertTo-Json -Compress -InputObject @{ runId = $RunId; exit = $Code; message = $Message }
        [IO.File]::WriteAllText((Join-Path $Base "sandbox-setup-result.json"), $Json, (New-Object Text.UTF8Encoding($false)))
    } catch { }
    exit $Code
}

# Runs srt-win.exe and ends the script with its exit code and error output (the last 600
# characters) unless it succeeded. Error output is turned into plain text line by line; stopping
# on it would hide the exit code.
function RunSrtWin([string[]]$Arguments) {
    $ErrorActionPreference = "Continue"
    $Text = (& $Exe @Arguments 2>&1 | ForEach-Object { "$_" }) -join " "
    if ($Text.Length -gt 600) { $Text = $Text.Substring($Text.Length - 600) }
    if ($LASTEXITCODE -ne 0) { Finish $LASTEXITCODE $Text }
}

# Ends the script (exit 45) unless $Path is a real directory, not a reparse point, owned by
# SYSTEM, the administrators or TrustedInstaller, with no allow entry for anyone else that grants
# any right to write, delete, change permissions or take ownership.
function AssertProtected([string]$Path) {
    $Item = Get-Item -LiteralPath $Path -Force
    if (-not $Item.PSIsContainer -or (([int]$Item.Attributes) -band 1024) -ne 0) { Finish 45 "not a plain directory: $Path" }
    $Acl = Get-Acl -LiteralPath $Path
    $Owner = $Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($Trusted -notcontains $Owner) { Finish 45 "owner of $Path is $Owner" }
    foreach ($Rule in $Acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        $Who = $Rule.IdentityReference.Value
        if ($Rule.AccessControlType -eq "Allow" -and ($Trusted -notcontains $Who) -and (([int]$Rule.FileSystemRights) -band 0x500D0156) -ne 0) {
            Finish 45 "$Who can change $Path"
        }
    }
}

# The srt-win.exe in the runtime directory, or $null when no directory was given or it has none.
function BundleSource {
    if (-not $BundleB64) { return $null }
    $Path = Join-Path ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($BundleB64))) "srt-win.exe"
    if (Test-Path -LiteralPath $Path -PathType Leaf) { return $Path }
    return $null
}

# Puts $Source into the staging directory as srt-win.exe, once its copy there has the pinned hash.
function Stage([string]$Source) {
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    AssertProtected $Dir
    $Temp = Join-Path $Dir ("srt-win-" + $RunId + ".tmp")
    Copy-Item -LiteralPath $Source -Destination $Temp -Force
    # The check that matters: the copy, now out of reach of non-administrators, is what was
    # pinned. Nothing has executed it yet. (The comparison ignores case.)
    if ((Get-FileHash -LiteralPath $Temp -Algorithm SHA256).Hash -ne $Sha256) {
        Remove-Item -LiteralPath $Temp -Force
        Finish 41 ""
    }
    Move-Item -LiteralPath $Temp -Destination $Exe -Force
}

function Install {
    $Source = BundleSource
    if (-not $Source) { Finish 43 "" }
    Stage $Source
    RunSrtWin @("install", "--proxy-port-range", "60180-60189")
    Finish 0 "ok"
}

function Uninstall {
    if (Test-Path -LiteralPath $Dir) { AssertProtected $Dir }
    if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) {
        $Source = BundleSource
        if ($Source) {
            Stage $Source
        } elseif (Get-LocalUser -Name "sourceweft-sandbox" -ErrorAction SilentlyContinue) {
            Finish 46 ""
        }
    }
    if (Test-Path -LiteralPath $Exe -PathType Leaf) { RunSrtWin @("uninstall") }
    if (Test-Path -LiteralPath $Dir) { Remove-Item -LiteralPath $Dir -Recurse -Force }
    if (Test-Path -LiteralPath $Dir) { Finish 42 "The staged folder could not be removed." }
    Finish 0 "ok"
}

try {
    $Admin = [Security.Principal.WindowsBuiltInRole]::Administrator
    if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole($Admin)) { Finish 40 "" }
    $Expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ProgramFilesB64))
    if (-not [Environment]::Is64BitProcess -or $Root.TrimEnd("\") -ne $Expected) { Finish 44 "Windows reports $Root, the app expected $Expected" }
    New-Item -ItemType Directory -Force -Path $Base | Out-Null
    AssertProtected $Base
    if ($Action -eq "install") { Install } elseif ($Action -eq "uninstall") { Uninstall } else { Finish 43 "" }
} catch {
    Finish 42 $_.Exception.Message
}
