# Authenticode-signs the three executables of a Windows sandbox bundle directory in place
# (srt-sidecar.exe, srt-win.exe, rg.exe) with signtool, using a certificate that is already in
# the CurrentUser\My store. The Windows counterpart of sign-macos.sh: run it BEFORE packing, then
# rebuild the manifest over the signed files (`build -- --remanifest`), because signing changes
# the bytes the manifest hashes.
#
#   pwsh sign-windows.ps1 -BundleDir <dir> -Thumbprint <sha1> -TimestampUrl <rfc3161 url>
#       Release signing: RFC 3161 timestamped, and every signature must verify as Valid (a trusted
#       chain), exactly like the installer.
#   pwsh sign-windows.ps1 -BundleDir <dir> -Thumbprint <sha1> -Throwaway
#       Pull-request CI with a self-signed certificate made for the run: no timestamp, and the
#       status may only be UnknownError or NotTrusted (signed, chain not trusted). It still proves that signing
#       leaves the executables intact (a corrupted or hash-mismatched image is rejected) and that
#       the bundle can be re-manifested, packed and verified over signed files.
param(
  [Parameter(Mandatory = $true)][string]$BundleDir,
  [Parameter(Mandatory = $true)][string]$Thumbprint,
  [string]$TimestampUrl = '',
  [switch]$Throwaway
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

if ($Thumbprint -notmatch '^[A-Fa-f0-9]{40}$') { throw 'Invalid Windows certificate thumbprint' }
if ($Throwaway -and $TimestampUrl) { throw '-Throwaway signing is never timestamped' }
if (-not $Throwaway -and -not $TimestampUrl) { throw 'a release signature needs -TimestampUrl (RFC 3161)' }
$BundleDir = (Resolve-Path -LiteralPath $BundleDir).Path

# signtool ships with the Windows SDK. Prefer the newest SDK and the runner's own architecture
# (an arm64 runner has a native signtool; an x64 one runs under emulation), then x64, then x86.
function Find-SignTool {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $order = @($arch, 'x64', 'x86') | Select-Object -Unique
  $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  if (Test-Path -LiteralPath $kits) {
    $versions = Get-ChildItem -LiteralPath $kits -Directory |
      Where-Object { $_.Name -match '^10\.\d+\.\d+\.\d+$' } |
      Sort-Object { [version]$_.Name } -Descending
    foreach ($version in $versions) {
      foreach ($candidate in $order) {
        $path = Join-Path $version.FullName "$candidate\signtool.exe"
        if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
      }
    }
  }
  $onPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  throw 'signtool.exe was not found (it ships with the Windows SDK)'
}

$signtool = Find-SignTool
Write-Host "signtool: $signtool"

foreach ($name in 'srt-sidecar.exe', 'srt-win.exe', 'rg.exe') {
  $path = Join-Path $BundleDir $name
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "missing from the bundle: $name" }
  $arguments = @('sign', '/fd', 'sha256', '/sha1', $Thumbprint)
  if (-not $Throwaway) { $arguments += @('/tr', $TimestampUrl, '/td', 'sha256') }
  & $signtool @arguments $path
  if ($LASTEXITCODE -ne 0) { throw "signtool failed for $name with exit code $LASTEXITCODE" }

  Import-Module Microsoft.PowerShell.Security
  $signature = Get-AuthenticodeSignature -LiteralPath $path
  if ($null -eq $signature.SignerCertificate -or
      $signature.SignerCertificate.Thumbprint -ne $Thumbprint.ToUpperInvariant()) {
    throw "$name is not signed by the expected certificate (status $($signature.Status))"
  }
  if ($Throwaway) {
    # A self-signed root is not trusted, which Windows reports as UnknownError or NotTrusted; anything that
    # says the image or its signature is damaged (HashMismatch, NotSigned, ...) is a failure.
    if ($signature.Status -notin @('Valid', 'UnknownError', 'NotTrusted')) {
      throw "$name signature status is $($signature.Status): $($signature.StatusMessage)"
    }
  }
  else {
    if ($signature.Status -ne 'Valid') {
      throw "$name signature status is $($signature.Status): $($signature.StatusMessage)"
    }
    if ($null -eq $signature.TimeStamperCertificate) { throw "$name signature carries no timestamp" }
  }
  Write-Host "${name}: signed by $($signature.SignerCertificate.Subject), status $($signature.Status)"
}
