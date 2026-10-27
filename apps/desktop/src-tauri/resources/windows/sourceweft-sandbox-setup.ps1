# SourceWeft local sandbox: one-time elevated setup (Windows).
#
# The app runs this script through Start-Process -Verb RunAs, so Windows shows its own UAC
# prompt; the app never sees a password. The script is embedded in the app and passed to
# powershell.exe as -EncodedCommand (nothing is read from a file a user could change before it
# runs), preceded by a few lines the app builds from validated values only:
#
#   $Action     install or uninstall
#   $RunId      a GUID naming this run (a stale result file is ignored by it)
#   $Sha256     install only: 64 hex characters, the SHA-256 that the signed bundle manifest
#               lists for srt-win.exe
#   $BundleB64  install only: the bundle directory, UTF-8, base64 (so nothing in a path can be
#               interpreted by PowerShell)
#
# install:
#   1. Copies srt-win.exe from the bundle into Program Files\SourceWeft\sandbox (administrators
#      write, Users read and execute) under a temporary name.
#   2. Hashes the COPY, inside that directory, and compares it with $Sha256 before anything
#      executes it. A different file is deleted and the script stops (exit 41).
#   3. Renames the copy into place and runs: srt-win.exe install --proxy-port-range 60180-60189
#      That creates the sourceweft-sandbox account and the network rules. It is the namespaced
#      build, so an upstream default install is neither read nor changed. --force is never used:
#      a conflicting install makes srt-win exit 13 and the script reports it.
# uninstall:
#   Runs srt-win.exe uninstall from the staged copy and removes the staged directory.
#
# The sandbox account runs srt-win.exe itself as the second hop of every launch, which is why the
# helper lives in Program Files and not in the per-user app data.
#
# Result: Program Files\SourceWeft\sandbox-setup-result.json holds {runId, exit, message}. Only
# administrators can create files there. Exit codes: 0 done; the codes of srt-win itself pass
# through (12 network rules, 13 conflicting install, 14 account, 17 write-deny stamps, 22 a
# sandbox session is running); of this script: 40 not elevated, 41 hash mismatch, 42 failure of
# this script, 43 bad input. The app words these; the message is only srt-win output or an error.
#
# This file must stay ASCII, free of single quote characters, block comments and here-strings:
# the app removes comment lines and indentation before encoding it, and a test checks all of it.
Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"

$Root = $env:ProgramW6432
if (-not $Root) { $Root = $env:ProgramFiles }
$Base = Join-Path $Root "SourceWeft"
$Dir = Join-Path $Base "sandbox"
$Exe = Join-Path $Dir "srt-win.exe"

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

function Install {
    $Bundle = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($BundleB64))
    $Source = Join-Path $Bundle "srt-win.exe"
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { Finish 43 "" }
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    $Temp = Join-Path $Dir ("srt-win-" + $RunId + ".tmp")
    Copy-Item -LiteralPath $Source -Destination $Temp -Force
    # The check that matters: the copy, now out of reach of non-administrators, is what was
    # signed. Nothing has executed it yet. (The comparison ignores case.)
    if ((Get-FileHash -LiteralPath $Temp -Algorithm SHA256).Hash -ne $Sha256) {
        Remove-Item -LiteralPath $Temp -Force
        Finish 41 ""
    }
    Move-Item -LiteralPath $Temp -Destination $Exe -Force
    RunSrtWin @("install", "--proxy-port-range", "60180-60189")
    Finish 0 "ok"
}

function Uninstall {
    if (Test-Path -LiteralPath $Exe) {
        RunSrtWin @("uninstall")
        Remove-Item -LiteralPath $Dir -Recurse -Force
    }
    Finish 0 "ok"
}

try {
    $Admin = [Security.Principal.WindowsBuiltInRole]::Administrator
    if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole($Admin)) { Finish 40 "" }
    New-Item -ItemType Directory -Force -Path $Base | Out-Null
    if ($Action -eq "install") { Install } elseif ($Action -eq "uninstall") { Uninstall } else { Finish 43 "" }
} catch {
    Finish 42 $_.Exception.Message
}
