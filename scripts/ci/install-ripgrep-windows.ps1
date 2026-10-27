# Downloads the pinned official Windows ripgrep release listed in ripgrep-release.json (the
# per-triple `windows` block) into <dir>, checks its SHA-256 before extracting, extracts only
# rg.exe, asserts it is a PE executable of the requested architecture and prints its path.
# The sandbox bundle ships this exact binary, so the Windows bundle legs use it rather than an
# unpinned package-manager ripgrep.
#   pwsh scripts/ci/install-ripgrep-windows.ps1 <dir> <rust-triple>
# where <rust-triple> is x86_64-pc-windows-msvc or aarch64-pc-windows-msvc. Only the rg.exe path
# goes to the success stream (capture it with `$rg = & ./install-ripgrep-windows.ps1 ...`);
# diagnostics go to the host.
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Dir,
  [Parameter(Mandatory = $true, Position = 1)][string]$Triple
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Windows PowerShell 5.1 downloads crawl with a progress bar

# PE COFF machine types.
$machines = @{
  'x86_64-pc-windows-msvc'  = 0x8664
  'aarch64-pc-windows-msvc' = 0xAA64
}
if (-not $machines.ContainsKey($Triple)) {
  throw "unsupported Windows ripgrep triple: $Triple (expected x86_64-pc-windows-msvc or aarch64-pc-windows-msvc)"
}

$pin = Get-Content -Raw -Path (Join-Path $PSScriptRoot 'ripgrep-release.json') | ConvertFrom-Json
$entry = $pin.windows.$Triple
if ($null -eq $entry) { throw "no windows ripgrep pin for $Triple" }
$asset = [string]$entry.asset
$sha256 = ([string]$entry.sha256).ToLowerInvariant()
$url = [string]$entry.url
if ($sha256 -notmatch '^[0-9a-f]{64}$') { throw "the pinned sha256 for $Triple is not 64 lowercase hex characters" }
if ($asset -notmatch '^ripgrep-[0-9.]+-[a-z0-9_-]+\.zip$') { throw "unexpected pinned asset name: $asset" }

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$Dir = (Resolve-Path -LiteralPath $Dir).Path
$zip = Join-Path $Dir $asset
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
# -MaximumRetryCount is PowerShell 7 only; retry by hand so Windows PowerShell 5.1 works too.
for ($attempt = 1; ; $attempt++) {
  try {
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    break
  }
  catch {
    if ($attempt -ge 3) { throw }
    Write-Host "download attempt $attempt failed: $($_.Exception.Message)"
    Start-Sleep -Seconds (2 * $attempt)
  }
}

# Verify the archive BEFORE reading anything out of it.
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
if ($actual -ne $sha256) {
  throw "sha256 mismatch for ${asset}: expected $sha256, got $actual"
}
Write-Host "sha256 verified for ${asset}"

# Extract exactly one entry, <asset without .zip>/rg.exe, by name: never the archive's own paths.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$entryName = ($asset -replace '\.zip$', '') + '/rg.exe'
$rg = Join-Path $Dir 'rg.exe'
$archive = [IO.Compression.ZipFile]::OpenRead($zip)
try {
  $item = $archive.GetEntry($entryName)
  if ($null -eq $item) { throw "$entryName not found in $asset" }
  [IO.Compression.ZipFileExtensions]::ExtractToFile($item, $rg, $true)
}
finally {
  $archive.Dispose()
}

# The PE header says which machine the binary is for: it must be the requested one.
$bytes = [IO.File]::ReadAllBytes($rg)
if ($bytes.Length -lt 0x40 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
  throw 'rg.exe is not a PE executable (missing MZ header)'
}
$peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
if ($peOffset -lt 0 -or $peOffset + 6 -gt $bytes.Length -or
    $bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset + 1] -ne 0x45 -or
    $bytes[$peOffset + 2] -ne 0 -or $bytes[$peOffset + 3] -ne 0) {
  throw 'rg.exe is not a PE executable (missing PE signature)'
}
$machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
$want = $machines[$Triple]
if ($machine -ne $want) {
  throw ('the bundled ripgrep must be PE machine 0x{0:X4} for {1}, got 0x{2:X4}' -f $want, $Triple, $machine)
}
Write-Host ('rg.exe: PE machine 0x{0:X4} ({1})' -f $machine, $Triple)

Write-Output $rg
