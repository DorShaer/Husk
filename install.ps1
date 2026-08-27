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

This file must stay standalone. When a script is piped into iex there is no file
on disk, so $PSScriptRoot and $MyInvocation.MyCommand.Definition are both empty.
Nothing here may reference either, and nothing here may dot-source a repo file.
(The repo root install.ps1 is the separate from-source installer.)
#>

$ErrorActionPreference = 'Stop'

# Some Windows 10 builds of PowerShell 5.1 still offer TLS 1.0 first, which
# github.com refuses. Add TLS 1.2 rather than assigning it, so TLS 1.3 stays
# available on hosts that already negotiate it.
[Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# Invoke-WebRequest repaints a progress bar on every read, which makes a ~100 MB
# download roughly 10x slower. Suppress it and print plain progress lines instead.
$ProgressPreference = 'SilentlyContinue'

$Owner     = 'DorShaer'
$Repo      = 'Husk'
$UserAgent = 'husk-installer'

function Write-Info  ($msg) { Write-Host ('> '    + $msg) -ForegroundColor Cyan }
function Write-Ok    ($msg) { Write-Host ('[OK] ' + $msg) -ForegroundColor Green }
function Write-Warn2 ($msg) { Write-Host ('[!] '  + $msg) -ForegroundColor Yellow }

# ─── Release tag resolution ──────────────────────────────────────────
function Get-LatestTag {
    # Read the tag from the /releases/latest redirect rather than api.github.com.
    # The JSON API allows 60 unauthenticated requests per hour per IP, a budget
    # that is easily exhausted behind a corporate NAT. The redirect has no such
    # limit, so take the tag from the Location header.
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

    # Validate the shape before trusting it, so a changed redirect target fails
    # here with a clear message rather than as a 404 on the asset URL later.
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

function Get-Download ($url, $outFile, [int64] $knownSize) {
    # Stream the asset to disk and print a single, rewritten progress line.
    # Invoke-WebRequest's own bar is suppressed ($ProgressPreference) because it
    # repaints per read and drags a 100 MB download to a crawl; a manual copy is
    # both fast and honest. Without this the terminal sits silent for the whole
    # download and looks hung, which is exactly what users reported.
    $req = [System.Net.HttpWebRequest]::Create($url)
    $req.UserAgent        = $UserAgent
    $req.Timeout          = 30000     # initial response only
    $req.ReadWriteTimeout = 300000    # a slow-but-alive stream must not be killed mid-download
    $resp = $req.GetResponse()
    $total = if ($knownSize -gt 0) { $knownSize } else { [int64] $resp.ContentLength }
    $in  = $resp.GetResponseStream()
    $out = [System.IO.File]::Create($outFile)
    try {
        $buffer  = New-Object byte[] (1MB)
        $sofar   = [int64] 0
        $lastPct = -1
        $read    = 0
        while (($read = $in.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $out.Write($buffer, 0, $read)
            $sofar += $read
            if ($total -gt 0) {
                # Repaint only on a percent change, so the line updates smoothly
                # without flooding the console.
                $pct = [int] (($sofar * 100) / $total)
                if ($pct -ne $lastPct) {
                    $lastPct = $pct
                    Write-Host ("`r    {0,3}%  {1:N0} / {2:N0} MB   " -f $pct, [math]::Round($sofar / 1MB), [math]::Round($total / 1MB)) -NoNewline
                }
            } else {
                # No Content-Length: show bytes pulled so far instead of a percent.
                Write-Host ("`r    {0:N0} MB   " -f [math]::Round($sofar / 1MB)) -NoNewline
            }
        }
        Write-Host ''   # close the rewritten line so the next message starts clean
    } finally {
        $out.Close()
        $in.Close()
        $resp.Close()
    }
}

function ConvertTo-Text ($content) {
    # GitHub serves SHA256SUMS as application/octet-stream. PowerShell 5.1 returns
    # that from Invoke-WebRequest as a string, while PowerShell 7 returns a byte[]
    # for any content type it does not consider text. Decode so the checksum lookup
    # sees text on both.
    if ($content -is [byte[]]) { return [System.Text.Encoding]::UTF8.GetString($content) }
    return [string] $content
}

function Get-ExpectedSha256 ($sumsText, $fileName) {
    # SHA256SUMS lines are "<64 hex><space><space><filename>", with an optional
    # leading * on the name for binary mode. Match the filename exactly, so a
    # similarly named asset (.zip, .blockmap) cannot satisfy the check.
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

    $remoteBytes = Get-RemoteSize $assetUrl
    $size  = Format-Size $remoteBytes
    $label = if ($size) { "Husk $tag ($size)" } else { "Husk $tag" }
    Write-Info "Downloading $label..."
    Get-Download $assetUrl $installerPath $remoteBytes
    Write-Ok "Downloaded $assetName"

    # A missing or unreachable SHA256SUMS is a hard failure. We never run bytes we
    # could not verify.
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

    # Downloaded files carry a Mark-of-the-Web alternate data stream, and with the
    # build not yet code-signed, launching it with that mark attached makes
    # SmartScreen block it outright. The bytes were verified against the published
    # checksum above, so clear the mark.
    Unblock-File -LiteralPath $installerPath
    Write-Warn2 'This build is not code-signed yet. Windows SmartScreen may still warn about an unknown publisher, and the UAC prompt will show no verified publisher name.'

    if ($Silent) {
        # The NSIS config sets oneClick:false, so /S is what makes it install with
        # its defaults and no UI.
        Write-Info 'Running the installer silently...'
        $proc = Start-Process -FilePath $installerPath -ArgumentList '/S' -Wait -PassThru
    } else {
        # -Wait blocks on the NSIS GUI wizard. Without saying so, the terminal
        # looks frozen and users guess at pressing Enter; tell them a window
        # opened and that this shell waits until they finish it.
        Write-Info 'A Husk Setup window has opened. Click through it to finish (Next/Install/Finish).'
        Write-Warn2 'If it is hidden, check the taskbar. If SmartScreen warns, choose "More info" then "Run anyway" -- this shell waits here until Setup closes.'
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
    # Signal failure without calling exit. Piped into iex, this runs in the user's
    # own shell, where exit would close their session.
    $global:LASTEXITCODE = 1
}
finally {
    if ($installerPath -and (Test-Path -LiteralPath $installerPath)) {
        Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
    }
}
