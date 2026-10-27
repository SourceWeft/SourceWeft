# Checks a built (and possibly Authenticode-signed) Windows sandbox bundle directory
# (apps/desktop/sandbox-sidecar/dist/bundle) the way only the real files can be checked:
#   * srt-sidecar.exe, rg.exe and srt-win.exe are PE executables of the target's architecture
#     (x86_64-pc-windows-msvc -> 0x8664, aarch64-pc-windows-msvc -> 0xAA64);
#   * the compiled srt-sidecar.exe really embeds the SourceWeft namespace: it is run with the
#     test-only `--print-namespace` flag and must print `sourceweft`. `build.ts` passes
#     `--define __SRT_WIN_NAMESPACE__="sourceweft"` to `bun build --compile`; if a Windows
#     command line ever drops those quotes the build still succeeds and the executable silently
#     carries upstream's `sandbox-runtime` names, so only running it can tell;
#   * srt-win.exe is the namespaced build (it carries the `sourceweft-sandbox` account name);
#   * rg.exe runs (so a signature or a wrong architecture would have been noticed).
# Running the executables needs the runner to be of the target's architecture, which holds for
# every caller (x64 target on an x64 runner, arm64 target on an arm64 runner).
#   pwsh apps/desktop/sandbox-sidecar/scripts/verify-windows-bundle.ps1 <bundle dir> <rust triple>
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$BundleDir,
  [Parameter(Mandatory = $true, Position = 1)][string]$Triple
)

$ErrorActionPreference = 'Stop'

$machines = @{
  'x86_64-pc-windows-msvc'  = 0x8664
  'aarch64-pc-windows-msvc' = 0xAA64
}
if (-not $machines.ContainsKey($Triple)) {
  throw "unsupported Windows bundle triple: $Triple"
}
$want = $machines[$Triple]
$BundleDir = (Resolve-Path -LiteralPath $BundleDir).Path

function Get-PeMachine([string]$Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 0x40 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
    throw "$Path is not a PE executable (missing MZ header)"
  }
  $peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
  if ($peOffset -lt 0 -or $peOffset + 6 -gt $bytes.Length -or
      $bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset + 1] -ne 0x45 -or
      $bytes[$peOffset + 2] -ne 0 -or $bytes[$peOffset + 3] -ne 0) {
    throw "$Path is not a PE executable (missing PE signature)"
  }
  return [BitConverter]::ToUInt16($bytes, $peOffset + 4)
}

foreach ($name in 'srt-sidecar.exe', 'rg.exe', 'srt-win.exe') {
  $path = Join-Path $BundleDir $name
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "missing from the bundle: $name" }
  $machine = Get-PeMachine $path
  if ($machine -ne $want) {
    throw ('{0} must be PE machine 0x{1:X4} for {2}, got 0x{3:X4}' -f $name, $want, $Triple, $machine)
  }
  Write-Host ('{0}: PE machine 0x{1:X4} ({2})' -f $name, $machine, $Triple)
}

# srt-win.exe carries its account name as a plain string; the namespaced build has ours.
# Latin-1 maps every byte to one char, so a plain substring search over the decoded file is exact.
$srtWin = [Text.Encoding]::GetEncoding(28591).GetString([IO.File]::ReadAllBytes((Join-Path $BundleDir 'srt-win.exe')))
$found = $srtWin.Contains('sourceweft-sandbox')
if (-not $found) { throw 'srt-win.exe does not carry the sourceweft-sandbox account name (not the namespaced build)' }
Write-Host 'srt-win.exe: namespaced build (sourceweft-sandbox)'

$sidecar = Join-Path $BundleDir 'srt-sidecar.exe'
$printed = @(& $sidecar --print-namespace)
if ($LASTEXITCODE -ne 0) { throw "srt-sidecar.exe --print-namespace exited with $LASTEXITCODE" }
if ($printed.Count -ne 1 -or ([string]$printed[0]).Trim() -ne 'sourceweft') {
  throw ("srt-sidecar.exe does not embed the sourceweft namespace; --print-namespace printed: " + ($printed -join ' | '))
}
Write-Host 'srt-sidecar.exe: embeds the sourceweft namespace'

$version = @(& (Join-Path $BundleDir 'rg.exe') --version)
if ($LASTEXITCODE -ne 0) { throw "rg.exe --version exited with $LASTEXITCODE" }
Write-Host $version[0]
