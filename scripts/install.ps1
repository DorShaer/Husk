param(
    [string] $Version,
    [switch] $Silent
)

<#
Husk Windows installer. Meant to be run straight from the network:

    irm https://dorshaer.github.io/Husk/install.ps1 | iex

iex cannot forward parameters, so to pass options build the scriptblock instead:

    & ([scriptblock]::Create((irm https://dorshaer.github.io/Husk/install.ps1))) -Silent

or set the environment variables the script also honours:

    $env:HUSK_VERSION = 'v2.8.8'; $env:HUSK_SILENT = '1'
    irm https://dorshaer.github.io/Husk/install.ps1 | iex

What it does: resolve the latest release tag, download the NSIS installer built
for this machine, verify it against the release SHA256SUMS, then run it.

This file is deliberately standalone. The repo root install.ps1 builds Husk from
source and dot-sources installer/lib/verify.ps1, which cannot work when a script
is piped into iex: there is no file on disk, so $PSScriptRoot and
$MyInvocation.MyCommand.Definition are both empty and the dot-source resolves to
nothing. Nothing in this file may reference either of them, and nothing here may
dot-source a repo file.
#>

$ErrorActionPreference = 'Stop'

# Windows 10 stock PowerShell (5.1) still offers TLS 1.0 first on some builds and
# github.com refuses it. Add TLS 1.2 rather than assigning it, so we do not strip
# TLS 1.3 back off on hosts that already negotiate it.
[Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# Invoke-WebRequest repaints a progress bar on every read, which makes a ~100 MB
# download roughly 10x slower. Suppress it and print our own progress lines.
$ProgressPreference = 'SilentlyContinue'

$Owner     = 'DorShaer'
$Repo      = 'Husk'
$UserAgent = 'husk-installer'

function Write-Info  ($msg) { Write-Host ('> '    + $msg) -ForegroundColor Cyan }
function Write-Ok    ($msg) { Write-Host ('[OK] ' + $msg) -ForegroundColor Green }
function Write-Warn2 ($msg) { Write-Host ('[!] '  + $msg) -ForegroundColor Yellow }

# ─── Release tag resolution ──────────────────────────────────────────
function Get-LatestTag {
    # Deliberately NOT api.github.com. The JSON API is rate limited to 60 requests
    # per hour per IP for unauthenticated callers, and behind a corporate NAT that
    # budget is routinely already spent, which fails the install for a reason the
    # user cannot see or fix. The plain /releases/latest URL is a redirect served
    # by github.com itself with no such limit, so we read the tag out of the
    # Location header and never touch the API.
    $url = "https://github.com/$Owner/$Repo/releases/latest"

    $req = [System.Net.HttpWebRequest]::Create($url)
    $req.Method          = 'HEAD'
    $req.AllowAutoRedirect = $false
    $req.UserAgent       = $UserAgent
    $req.Timeout         = 30000  # an unbounded wait here hangs the terminal with no output

    $resp = $null
    try {
        $resp = $req.GetResponse()
    } catch [System.Net.WebException] {
        # GetResponse throws for status >= 400 but still hands us the response.
        # A 3xx with AllowAutoRedirect off comes back normally, not as a throw.
        if ($_.Exception.Response) {
            $resp = $_.Exception.Response
        } else {
            throw "Could not reach github.com to resolve the latest release: $($_.Exception.Message)"
        }
    }

    try {
        $status   = [int] $resp.StatusCode
        $location = $resp.Headers['Location']
    } finally {
        $resp.Close()
    }

    if ($status -lt 300 -or $status -ge 400 -or -not $location) {
        throw "Expected a redirect from $url but got HTTP $status. Set -Version (or `$env:HUSK_VERSION) to a tag such as v2.8.8 to skip tag resolution."
    }

    $tag = $location.TrimEnd('/').Split('/')[-1]

    # Validate the shape before trusting it. If GitHub ever changes the redirect
    # target we want a clear error here, not a 404 on a nonsense asset URL later.
    if ($tag -notmatch '^v\d+\.\d+\.\d+') {
        throw "Could not parse a release tag out of '$location' (got '$tag')."
    }
    return $tag
}

# ─── Architecture ────────────────────────────────────────────────────
function Get-TargetArch {
    # PROCESSOR_ARCHITEW6432 is set only when a 32-bit process runs on a 64-bit
    # OS. In that case it holds the real machine architecture and
    # PROCESSOR_ARCHITECTURE reports the emulated one ("x86"), so it wins.
    $arch = $env:PROCESSOR_ARCHITEW6432
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
    if (-not $arch) { throw 'Could not determine the processor architecture.' }

    switch ($arch.ToUpperInvariant()) {
        'AMD64' { return 'x64' }
        'ARM64' {
            # There is no native arm64 build yet. Windows on ARM runs x64 binaries
            # under its built-in emulation layer, so install the x64 build rather
            # than refusing outright, and say so plainly.
            Write-Warn2 'Windows on ARM detected. There is no native arm64 build yet, so this installs the x64 build and Windows will run it under x64 emulation.'
            return 'x64'
        }
        'X86' { throw '32-bit Windows is not supported. Husk ships an x64 build only.' }
        default { throw "Unsupported processor architecture '$arch'. Husk ships an x64 build only." }
    }
}

# ─── Download helpers ────────────────────────────────────────────────
function Get-RemoteSize ($url) {
    # Cheap HEAD purely so the progress line can show an honest size. This is
    # cosmetic, so any failure returns 0 and we print no size rather than abort.
    try {
        $req = [System.Net.HttpWebRequest]::Create($url)
        $req.Method    = 'HEAD'
        $req.UserAgent = $UserAgent
        $req.Timeout   = 15000
        $resp = $req.GetResponse()
        try { return [int64] $resp.ContentLength } finally { $resp.Close() }
    } catch {
        return [int64] 0
    }
}

function Format-Size ([int64] $bytes) {
    if ($bytes -le 0) { return $null }
    return ('{0:N0} MB' -f [math]::Round($bytes / 1MB))
}

function ConvertTo-Text ($content) {
    # GitHub serves SHA256SUMS as application/octet-stream. Windows PowerShell 5.1
    # hands that back from Invoke-WebRequest as a string, but PowerShell 7 hands
    # back a byte[] for any content type it does not consider text. Without this,
    # the checksum lookup silently matches nothing on PS 7 and every install fails
    # with "no entry for husk-...exe".
    if ($content -is [byte[]]) { return [System.Text.Encoding]::UTF8.GetString($content) }
    return [string] $content
}

function Get-ExpectedSha256 ($sumsText, $fileName) {
    # SHA256SUMS lines look like "<64 hex><space><space><filename>", with an
    # optional leading * on the name for binary mode. Match the filename exactly
    # so a different asset with a similar name can never satisfy the check.
    foreach ($line in ($sumsText -split '\r?\n')) {
        if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$') {
            if ($matches[2] -eq $fileName) { return $matches[1] }
        }
    }
    return $null
}

# ─── Install ─────────────────────────────────────────────────────────
$installerPath = $null

try {
    # PS 5.1 is the floor. #requires is ignored when a script is run through iex,
    # so check at runtime instead of relying on it.
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        throw "PowerShell 5.1 or newer is required (found $($PSVersionTable.PSVersion))."
    }

    # Explicit -Version wins; $env:HUSK_VERSION is the fallback for the piped form,
    # where iex cannot forward parameters.
    if (-not $Version -and $env:HUSK_VERSION) { $Version = $env:HUSK_VERSION }
    if (-not $Silent  -and $env:HUSK_SILENT)  { $Silent  = $true }

    if ($Version) {
        # Accept both "2.8.8" and "v2.8.8" and normalise to the tag form.
        $tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
        Write-Info "Using pinned version $tag"
    } else {
        Write-Info 'Resolving the latest release...'
        $tag = Get-LatestTag
    }

    $arch      = Get-TargetArch
    $assetName = "husk-$tag-win-$arch.exe"
    $baseUrl   = "https://github.com/$Owner/$Repo/releases/download/$tag"
    $assetUrl  = "$baseUrl/$assetName"
    $sumsUrl   = "$baseUrl/SHA256SUMS"

    $installerPath = Join-Path $env:TEMP $assetName

    $size  = Format-Size (Get-RemoteSize $assetUrl)
    $label = if ($size) { "Husk $tag ($size)" } else { "Husk $tag" }
    Write-Info "Downloading $label..."
    Invoke-WebRequest -Uri $assetUrl -OutFile $installerPath -UseBasicParsing -UserAgent $UserAgent
    Write-Ok "Downloaded $assetName"

    # The site promises "checksums verified", so a missing or unreachable
    # SHA256SUMS is a hard failure, never a silently skipped step.
    Write-Info 'Verifying checksum...'
    try {
        $sums = ConvertTo-Text (Invoke-WebRequest -Uri $sumsUrl -UseBasicParsing -UserAgent $UserAgent).Content
    } catch {
        throw "Could not download SHA256SUMS from $sumsUrl : $($_.Exception.Message). Refusing to run an unverified installer."
    }

    $expected = Get-ExpectedSha256 $sums $assetName
    if (-not $expected) {
        throw "SHA256SUMS has no entry for $assetName. Refusing to run an unverified installer."
    }

    $actual = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash
    if ($actual -ne $expected) {  # -ne on strings is case-insensitive in PowerShell
        throw "Checksum mismatch for $assetName. Expected $expected but got $actual. The download has been discarded; do not run it."
    }
    Write-Ok "Checksum verified ($($expected.ToLowerInvariant().Substring(0, 16))...)"

    # Files downloaded from the internet carry a Mark-of-the-Web alternate data
    # stream. Because the build is not code-signed, launching it with that mark
    # still attached makes SmartScreen block it outright. We have just verified
    # the bytes against the published checksum, so strip the mark and let the
    # installer run.
    Unblock-File -LiteralPath $installerPath
    Write-Warn2 'This build is not code-signed yet. Windows SmartScreen may still warn about an unknown publisher, and the UAC prompt will show no verified publisher name.'

    Write-Info 'Running the installer...'
    if ($Silent) {
        # The NSIS config sets oneClick:false, so /S is what makes it install with
        # its defaults and no UI.
        $proc = Start-Process -FilePath $installerPath -ArgumentList '/S' -Wait -PassThru
    } else {
        $proc = Start-Process -FilePath $installerPath -Wait -PassThru
    }

    if ($proc.ExitCode -ne 0) {
        # NSIS: 0 = success, 1 = user cancelled, 2 = fatal error.
        if ($proc.ExitCode -eq 1) { throw 'The installer was cancelled.' }
        throw "The installer exited with code $($proc.ExitCode)."
    }

    Write-Host ''
    Write-Ok 'Husk installed. Launch it from the Start menu.'
    Write-Host ''
}
catch {
    Write-Host ''
    Write-Host ('[x] ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host ''
    # Signal failure without calling exit: when this script is piped into iex it
    # runs in the user's own shell, and exit would close their session.
    $global:LASTEXITCODE = 1
}
finally {
    if ($installerPath -and (Test-Path -LiteralPath $installerPath)) {
        Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
    }
}
