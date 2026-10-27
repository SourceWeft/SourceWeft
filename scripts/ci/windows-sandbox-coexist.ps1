# Helper for the `windows-sandbox` job of .github/workflows/desktop-build.yml: the machine-level
# steps around the real-sandbox suite (apps/desktop/src-tauri/tests/windows_sandbox.rs).
#
#   pwsh scripts/ci/windows-sandbox-coexist.ps1 <action> [-UpstreamDir <dir>] [-Version <x.y.z>]
#
# Actions (each is a workflow step; a failing expectation exits non-zero with the reason):
#   preflight         The runner is an elevated administrator and Start-Process -Verb RunAs completes
#                     without a prompt (the premise of the suite's setup tests). Prints facts the
#                     tests depend on: UAC policy, where Node and Git live and who can read them.
#   install-upstream  Installs the UPSTREAM default sandbox-runtime (npm, the exact release the
#                     fork is based on) into -UpstreamDir and runs its vendored srt-win.exe
#                     `install` with every default name (account srt-sandbox, ports 60080-60089).
#                     Calls the executable's `install` directly, not the TypeScript windows-install
#                     command, so no profile read grant is applied (that is the --skip-profile-grant
#                     behaviour: a shared-machine hazard and minutes of ACL work). Records the
#                     status JSON for the later comparison.
#   hosts             Adds the hosts-file entries the hostname tests need and flushes the DNS cache.
#   hide-bash         Renames Git\bin\bash.exe so the host (which looks for exactly that file)
#                     chooses Windows PowerShell, for the second pass of the suite.
#   restore-bash      Undoes hide-bash.
#   assert-coexist    After the suite: both installs are present with different accounts and port
#                     ranges, and the upstream install's status is exactly what it was before.
#   final-uninstall   Removes OUR install with its staged helper's `uninstall`, checks it is gone and
#                     the upstream install is untouched, then removes the upstream install.
#                     (The suite itself already removes ours through the app's real elevated
#                     launcher, in setup_uninstall_returns_to_not_installed_...; this is the
#                     end-of-job state check.)
#   cleanup           Best effort, never fails: uninstall whatever is installed, restore Git Bash,
#                     remove the hosts entries. Runs in an `if: always()` step.
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('preflight', 'install-upstream', 'hosts', 'hide-bash', 'restore-bash', 'assert-coexist', 'final-uninstall', 'cleanup')]
  [string]$Action,
  [string]$UpstreamDir = 'apps/desktop/sandbox-sidecar/dist/upstream-srt',
  [string]$Version = '0.0.81'
)

$ErrorActionPreference = 'Stop'

$OursUser = 'sourceweft-sandbox'
$UpstreamUser = 'srt-sandbox'
$HostsFile = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$HostsLines = @('127.0.0.1 sw-loop.test', '10.0.0.1 sw-private.test')

function Program-Files-Root {
  if ($env:ProgramW6432) { return $env:ProgramW6432 }
  return $env:ProgramFiles
}
function Staged-SrtWin { return Join-Path (Program-Files-Root) 'SourceWeft\sandbox\srt-win.exe' }
function Bash-Exe { return Join-Path (Program-Files-Root) 'Git\bin\bash.exe' }
function Upstream-SrtWin {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  return Join-Path (Resolve-Path -LiteralPath $UpstreamDir).Path "node_modules\@anthropic-ai\sandbox-runtime\vendor\srt-win\$arch\srt-win.exe"
}

function Note([string]$Text) {
  Write-Host $Text
  if ($env:GITHUB_STEP_SUMMARY) { Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $Text }
}
function Fail([string]$Text) {
  Write-Host "::error::$Text"
  if ($env:GITHUB_STEP_SUMMARY) { Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value "**FAILED:** $Text" }
  exit 1
}

# `<exe> <args>` with a check of the exit code; returns the stdout lines.
function Run-Checked([string]$Exe, [string[]]$Arguments, [string]$What) {
  # srt-win and npm write progress to stderr; with 'Stop' that would end the script before the exit
  # code could be looked at.
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = & $Exe @Arguments 2>&1 | ForEach-Object { "$_" }
  $code = $LASTEXITCODE
  $ErrorActionPreference = $saved
  if ($code -ne 0) { Fail "$What exited ${code}: $($output -join ' / ')" }
  return $output
}

# The `status` JSON of an srt-win.exe as a compact, key-ordered-as-printed string.
function Status-Json([string]$Exe) {
  $text = (Run-Checked $Exe @('status') "$Exe status") -join "`n"
  return ($text | ConvertFrom-Json | ConvertTo-Json -Depth 30 -Compress)
}
function Local-User-Exists([string]$Name) {
  return $null -ne (Get-LocalUser -Name $Name -ErrorAction SilentlyContinue)
}

switch ($Action) {
  'preflight' {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $admin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $admin) { Fail 'the job is not running as an administrator, so the elevated setup cannot be exercised' }
    $policy = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
    Note "UAC policy: EnableLUA=$($policy.EnableLUA) ConsentPromptBehaviorAdmin=$($policy.ConsentPromptBehaviorAdmin) PromptOnSecureDesktop=$($policy.PromptOnSecureDesktop)"
    Note "User: $($identity.Name); OS: $([Environment]::OSVersion.VersionString); arch: $env:PROCESSOR_ARCHITECTURE"
    # The launcher the app uses, reduced to its essence: a hidden elevated child that returns an
    # exit code. If this hangs or fails, the setup tests would fail for a reason unrelated to the
    # product, and this step says so.
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $child = Start-Process -FilePath $powershell -Verb RunAs -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', 'exit 7')
    if (-not $child.WaitForExit(120000)) {
      $child.Kill()
      Fail 'Start-Process -Verb RunAs did not complete within 120 s (a UAC prompt is waiting for an answer nobody can give)'
    }
    if ($child.ExitCode -ne 7) { Fail "the elevated child returned $($child.ExitCode), expected 7" }
    Note 'Start-Process -Verb RunAs completes without a prompt (exit code passed through).'

    # Facts the suite's Node-based probes depend on.
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { Fail 'node is not on PATH: the sandbox tests run Node inside the sandbox' }
    $nodeDir = Split-Path -Parent $node.Source
    $insideProfile = $nodeDir.ToLowerInvariant().StartsWith($env:USERPROFILE.ToLowerInvariant() + '\')
    Note "node: $($node.Source) (version $(& $node.Source --version)); inside the user profile: $insideProfile"
    Note "ACL of the Node folder:`n$((icacls $nodeDir) -join "`n")"
    $git = Get-Command git -ErrorAction SilentlyContinue
    Note "git: $(if ($git) { $git.Source } else { 'not installed' }); bash.exe: $(if (Test-Path -LiteralPath (Bash-Exe)) { Bash-Exe } else { 'not installed' })"
    Note "Profile: $env:USERPROFILE; temp: $env:TEMP; PATH entries inside the profile: $((($env:PATH -split ';') | Where-Object { $_ -and $_.ToLowerInvariant().StartsWith($env:USERPROFILE.ToLowerInvariant() + '\') }) -join '; ')"
  }

  'install-upstream' {
    New-Item -ItemType Directory -Force -Path $UpstreamDir | Out-Null
    Run-Checked 'npm.cmd' @('install', '--prefix', $UpstreamDir, "@anthropic-ai/sandbox-runtime@$Version", '--no-audit', '--no-fund', '--ignore-scripts', '--no-save') 'npm install of upstream sandbox-runtime' | Out-Null
    $package = Get-Content -Raw -LiteralPath (Join-Path $UpstreamDir 'node_modules\@anthropic-ai\sandbox-runtime\package.json') | ConvertFrom-Json
    if ($package.version -ne $Version) { Fail "installed sandbox-runtime $($package.version), expected the upstream release $Version" }
    $exe = Upstream-SrtWin
    if (-not (Test-Path -LiteralPath $exe)) { Fail "the upstream package has no vendored srt-win.exe at $exe" }
    # Every default: no --sandbox-user, --sublayer-guid, --proxy-port-range or --force.
    $log = Run-Checked $exe @('install') 'upstream srt-win.exe install'
    Note "upstream install: $($log -join ' / ')"
    $status = Status-Json $exe
    Set-Content -LiteralPath (Join-Path $UpstreamDir 'status-before.json') -Value $status -NoNewline
    $parsed = $status | ConvertFrom-Json
    if ($parsed.user.user.name -ne $UpstreamUser -or -not $parsed.user.user.exists) { Fail "the upstream install does not have the default account ${UpstreamUser}: $status" }
    if (($parsed.wfp.port_range -join '-') -ne '60080-60089') { Fail "the upstream install does not use its default ports: $status" }
    Note "upstream sandbox-runtime $Version installed (account $UpstreamUser, ports 60080-60089)."
  }

  'hosts' {
    $current = Get-Content -LiteralPath $HostsFile -ErrorAction SilentlyContinue
    foreach ($line in $HostsLines) {
      if ($current -notcontains $line) { Add-Content -LiteralPath $HostsFile -Value "`n$line" }
    }
    ipconfig /flushdns | Out-Null
    $loop = [Net.Dns]::GetHostAddresses('sw-loop.test') | ForEach-Object { $_.IPAddressToString }
    $private = [Net.Dns]::GetHostAddresses('sw-private.test') | ForEach-Object { $_.IPAddressToString }
    if ($loop -notcontains '127.0.0.1') { Fail "sw-loop.test resolves to $($loop -join ',') instead of 127.0.0.1" }
    if ($private -notcontains '10.0.0.1') { Fail "sw-private.test resolves to $($private -join ',') instead of 10.0.0.1" }
    Note 'hosts entries in place: sw-loop.test -> 127.0.0.1, sw-private.test -> 10.0.0.1'
  }

  'hide-bash' {
    $bash = Bash-Exe
    if (-not (Test-Path -LiteralPath $bash)) { Fail "no Git Bash at $bash to hide" }
    Rename-Item -LiteralPath $bash -NewName 'bash.exe.sw-hidden'
    Note "hid ${bash}: the host will choose Windows PowerShell."
  }

  'restore-bash' {
    $hidden = (Bash-Exe) + '.sw-hidden'
    if (Test-Path -LiteralPath $hidden) { Rename-Item -LiteralPath $hidden -NewName 'bash.exe' }
    if (-not (Test-Path -LiteralPath (Bash-Exe))) { Fail 'Git Bash could not be restored' }
    Note 'Git Bash restored.'
  }

  'assert-coexist' {
    $ours = Staged-SrtWin
    if (-not (Test-Path -LiteralPath $ours)) { Fail "our staged helper is missing at $ours after the suite (the suite ends with the sandbox installed)" }
    $upstream = Upstream-SrtWin
    foreach ($name in @($OursUser, $UpstreamUser)) {
      if (-not (Local-User-Exists $name)) { Fail "the local account $name is missing" }
    }
    $oursStatus = (Status-Json $ours) | ConvertFrom-Json
    $upstreamStatus = (Status-Json $upstream) | ConvertFrom-Json
    if ($oursStatus.user.user.sid -eq $upstreamStatus.user.user.sid) { Fail 'the two installs share one account SID' }
    if (($oursStatus.wfp.port_range -join '-') -ne '60180-60189') { Fail "our port range is $($oursStatus.wfp.port_range -join '-')" }
    if (($upstreamStatus.wfp.port_range -join '-') -ne '60080-60089') { Fail "the upstream port range is $($upstreamStatus.wfp.port_range -join '-')" }
    $before = Get-Content -Raw -LiteralPath (Join-Path $UpstreamDir 'status-before.json')
    $after = Status-Json $upstream
    if ($before -cne $after) { Fail "the upstream install's status changed while the SourceWeft suite ran:`nbefore: $before`nafter:  $after" }
    Note "coexistence: accounts $OursUser and $UpstreamUser, ports 60180-60189 and 60080-60089; the upstream status is unchanged."
  }

  'final-uninstall' {
    $ours = Staged-SrtWin
    $upstream = Upstream-SrtWin
    $before = Get-Content -Raw -LiteralPath (Join-Path $UpstreamDir 'status-before.json')
    if (Test-Path -LiteralPath $ours) {
      Run-Checked $ours @('uninstall') 'our srt-win.exe uninstall' | Out-Null
      Remove-Item -LiteralPath (Split-Path -Parent $ours) -Recurse -Force
    }
    if (Local-User-Exists $OursUser) { Fail "the account $OursUser is still there after the uninstall" }
    $after = Status-Json $upstream
    if ($before -cne $after) { Fail "uninstalling the SourceWeft sandbox changed the upstream install's status:`nbefore: $before`nafter:  $after" }
    Note "SourceWeft sandbox removed; the upstream install is untouched."
    Run-Checked $upstream @('uninstall') 'upstream srt-win.exe uninstall' | Out-Null
    if (Local-User-Exists $UpstreamUser) { Fail "the account $UpstreamUser is still there after the upstream uninstall" }
    Note 'upstream sandbox-runtime removed.'
  }

  'cleanup' {
    $ErrorActionPreference = 'Continue'
    $hidden = (Bash-Exe) + '.sw-hidden'
    if (Test-Path -LiteralPath $hidden) { Rename-Item -LiteralPath $hidden -NewName 'bash.exe' -ErrorAction Continue }
    $ours = Staged-SrtWin
    if (Test-Path -LiteralPath $ours) {
      & $ours uninstall 2>&1 | Out-Host
      if ($LASTEXITCODE -ne 0) { Write-Host "::warning::cleanup: our uninstall exited $LASTEXITCODE" }
      Remove-Item -LiteralPath (Split-Path -Parent $ours) -Recurse -Force -ErrorAction Continue
    }
    if (Test-Path -LiteralPath $UpstreamDir) {
      $upstream = Join-Path (Resolve-Path -LiteralPath $UpstreamDir).Path "node_modules\@anthropic-ai\sandbox-runtime\vendor\srt-win\$(if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' })\srt-win.exe"
      if ((Test-Path -LiteralPath $upstream) -and (Local-User-Exists $UpstreamUser)) {
        & $upstream uninstall 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { Write-Host "::warning::cleanup: the upstream uninstall exited $LASTEXITCODE" }
      }
    }
    if (Test-Path -LiteralPath $HostsFile) {
      $kept = Get-Content -LiteralPath $HostsFile | Where-Object { $HostsLines -notcontains $_ }
      Set-Content -LiteralPath $HostsFile -Value $kept
    }
    exit 0
  }
}
