#requires -Version 5.1
<#
Husk Windows installer.

Run from an elevated or normal PowerShell prompt:
    powershell -ExecutionPolicy Bypass -File .\installer\install.ps1
or in PowerShell 7+:
    pwsh -File .\installer\install.ps1

Goals (parity with install.sh on Linux/macOS):
- Detect and install prerequisites: jq (statusline) and bun (PAI hooks)
- npm install + native rebuild for node-pty
- Bootstrap PAI bundle into ~\.claude\ (no overwrite)
- Create a husk.cmd wrapper under %LOCALAPPDATA%\Husk and a Start Menu shortcut

Failures in the prerequisite block are logged but do not abort: Husk core
still installs, only the PAI features that depend on the missing tool are
degraded.
#>

$ErrorActionPreference = 'Stop'
# This script lives in installer/, so the project root is its parent.
$AppDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)

# Pinned SHA-256 of the upstream bun installer script revision we
# accept. Install-Bun verifies the downloaded file against this constant
# before running it. Procedure for bumping is in installer/lib/verify.ps1.
$Script:BunInstallerUrl = 'https://bun.sh/install.ps1'
$Script:BunInstallerSha256 = '54fd5c34e08d2e363e9ee4cc52f58eca72b3c307c170869eec1e394c16fb7744'

. (Join-Path $AppDir 'installer/lib/verify.ps1')

function Write-Info  ($msg) { Write-Host ("> " + $msg) -ForegroundColor Cyan }
function Write-Ok    ($msg) { Write-Host ("[OK] " + $msg) -ForegroundColor Green }
function Write-Warn2 ($msg) { Write-Host ("[!] " + $msg) -ForegroundColor Yellow }

Write-Ok "Detected Windows ($([Environment]::OSVersion.VersionString))"

# Helper: is a command available on PATH?
function Test-Cmd($name) {
    return [bool] (Get-Command $name -ErrorAction SilentlyContinue)
}

# ─── 0. Node.js detection (hard prereq) ──────────────────────────────
if (-not (Test-Cmd node)) {
    Write-Warn2 "Node.js is required but was not found. Install Node 20+ from https://nodejs.org/ and re-run."
    exit 1
}
$nodeVer = (& node --version) 2>$null
Write-Ok "node present ($nodeVer)"

if (-not (Test-Cmd npm)) {
    Write-Warn2 "npm is missing even though node is present; reinstall Node from https://nodejs.org/"
    exit 1
}

# ─── 0b. MSVC build tools detection (soft warning) ───────────────────
# node-pty has a C++ addon. The native rebuild needs MSVC's cl.exe or
# MSBuild. We do not auto-install Visual Studio (multi-GB, license-gated);
# we just warn so the user can intervene before the rebuild fails noisily.
if (-not (Test-Cmd cl) -and -not (Test-Cmd msbuild)) {
    Write-Warn2 "Neither cl.exe nor MSBuild is on PATH. The node-pty native rebuild may fail. If it does, install 'Visual Studio Build Tools' (Desktop development with C++) from https://visualstudio.microsoft.com/visual-cpp-build-tools/ and re-run."
}

# ─── 1. Prerequisites: jq + bun ──────────────────────────────────────
function Install-Jq {
    if (Test-Cmd jq) {
        $jqVer = (& jq --version) 2>$null
        Write-Ok "jq present ($jqVer)"
        return
    }
    Write-Info "Installing jq (PAI statusline needs it for the Anthropic usage cache)..."
    if (Test-Cmd winget) {
        try { winget install --id jqlang.jq -e --silent --accept-package-agreements --accept-source-agreements } catch { Write-Warn2 ("winget install jq failed: " + $_.Exception.Message) }
    } elseif (Test-Cmd scoop) {
        try { scoop install jq } catch { Write-Warn2 ("scoop install jq failed: " + $_.Exception.Message) }
    } elseif (Test-Cmd choco) {
        try { choco install jq -y } catch { Write-Warn2 ("choco install jq failed: " + $_.Exception.Message) }
    } else {
        Write-Warn2 "No package manager found (winget / scoop / choco). Install jq manually from https://jqlang.github.io/jq/download/"
        return
    }
    # winget refreshes PATH per-session via env vars; pull the latest in.
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
    if (Test-Cmd jq) {
        Write-Ok "jq installed"
    } else {
        Write-Warn2 "jq install command finished but jq is still not on PATH. Open a new terminal and re-run if you need it now."
    }
}

function Install-Bun {
    if (Test-Cmd bun) {
        $bunVer = (& bun --version) 2>$null
        Write-Ok "bun present ($bunVer)"
        return
    }
    Write-Info "Installing bun (PAI hooks need it for rating capture and learning)..."
    # Download the bun installer to a temp file and check its SHA-256
    # against the pinned constant before running it.
    $installerTmp = Join-Path $env:TEMP ("husk-bun-installer-" + [Guid]::NewGuid().ToString('N') + '.ps1')
    if (-not (Get-VerifiedDownload -Url $Script:BunInstallerUrl -Expected $Script:BunInstallerSha256 -OutFile $installerTmp)) {
        Write-Warn2 ("bun installer SHA-256 did not match the pinned value (expected " + $Script:BunInstallerSha256 + "). Skipping. To update the pin, see installer/lib/verify.ps1.")
        return
    }
    try {
        & powershell -ExecutionPolicy Bypass -File $installerTmp
    } catch {
        Write-Warn2 ("bun installer failed: " + $_.Exception.Message + ". Install manually from https://bun.sh")
    } finally {
        Remove-Item -LiteralPath $installerTmp -Force -ErrorAction SilentlyContinue
    }
    # bun.exe lands at $env:USERPROFILE\.bun\bin\bun.exe
    $bunBin = Join-Path $env:USERPROFILE ".bun\bin"
    if (Test-Path (Join-Path $bunBin "bun.exe")) {
        if (-not ($env:Path -split ';' | Where-Object { $_ -ieq $bunBin })) {
            $env:Path = "$bunBin;$env:Path"
        }
        Write-Ok "bun installed at $bunBin (added to PATH for this session)"
    } else {
        Write-Warn2 "bun install completed but bun.exe was not found at $bunBin. PAI hooks will not run until you install bun manually."
    }
}

Write-Info "Checking prerequisites (jq, bun)..."
Install-Jq
Install-Bun

# ─── 2. Dependencies + native rebuild ────────────────────────────────
Push-Location $AppDir
try {
    $ptyBuilt = Test-Path (Join-Path $AppDir "node_modules\node-pty\build\Release\pty.node")
    if (-not (Test-Path (Join-Path $AppDir "node_modules")) -or -not $ptyBuilt) {
        Write-Info "Installing Node dependencies..."
        npm install --no-audit --no-fund
        Write-Info "Rebuilding node-pty for Electron's Node ABI..."
        npx --yes @electron/rebuild -f -w node-pty
        Write-Ok "Dependencies installed"
    } else {
        Write-Ok "Dependencies already installed"
    }
} catch {
    Write-Warn2 ("Dependency install or native rebuild failed: " + $_.Exception.Message)
    Write-Warn2 "If the failure was a C++ toolchain issue, install Visual Studio Build Tools and re-run."
    Pop-Location
    exit 1
}
Pop-Location

# ─── 3. PAI bootstrap (idempotent, never overwrites user files) ──────
$ClaudeDir = Join-Path $env:USERPROFILE ".claude"
$PaiBundle = Join-Path $AppDir "libs\pai"
if (Test-Path $PaiBundle) {
    Write-Info "Bootstrapping PAI into $ClaudeDir (only adds missing files)..."
    New-Item -ItemType Directory -Force -Path $ClaudeDir | Out-Null

    $claudeMd = Join-Path $ClaudeDir "CLAUDE.md"
    if (-not (Test-Path $claudeMd)) {
        $tpl = Join-Path $PaiBundle "CLAUDE.md.template"
        if (Test-Path $tpl) {
            Copy-Item $tpl $claudeMd
        } else {
            $stock = Join-Path $PaiBundle "CLAUDE.md"
            if (Test-Path $stock) { Copy-Item $stock $claudeMd }
        }
        Write-Ok "Installed CLAUDE.md (you can edit it any time)"
    }

    foreach ($sub in @('PAI', 'agents', 'hooks', 'lib', 'skills')) {
        $src = Join-Path $PaiBundle $sub
        $dst = Join-Path $ClaudeDir $sub
        if (-not (Test-Path $src)) { continue }
        if (-not (Test-Path $dst)) {
            Copy-Item -Recurse $src $dst
            Write-Ok "Installed $sub\"
        } else {
            # Mirror the cp -Rn behavior of install.sh: copy missing files,
            # never overwrite user changes. Get-ChildItem -Recurse + a
            # destination existence check covers both files and subdirs.
            Get-ChildItem -Path $src -Recurse -File | ForEach-Object {
                $rel = $_.FullName.Substring($src.Length).TrimStart('\','/')
                $tgt = Join-Path $dst $rel
                if (-not (Test-Path $tgt)) {
                    $tgtDir = Split-Path -Parent $tgt
                    if (-not (Test-Path $tgtDir)) { New-Item -ItemType Directory -Force -Path $tgtDir | Out-Null }
                    Copy-Item $_.FullName $tgt
                }
            }
        }
    }

    foreach ($fileName in @('blocklist.json', 'statusline-command.sh')) {
        $src = Join-Path $PaiBundle $fileName
        $dst = Join-Path $ClaudeDir $fileName
        if ((Test-Path $src) -and -not (Test-Path $dst)) { Copy-Item $src $dst }
    }

    Write-Ok "PAI ready"
}

# ─── 4. Wrapper + Start Menu shortcut ────────────────────────────────
$BinDir = Join-Path $env:LOCALAPPDATA "Husk"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$Wrapper = Join-Path $BinDir "husk.cmd"
@"
@echo off
rem Auto-generated by Husk install.ps1, do not edit by hand
cd /d "$AppDir"
call npm start
"@ | Set-Content -Path $Wrapper -Encoding ASCII
Write-Ok "Wrapper installed: $Wrapper"

# Add wrapper directory to user PATH if missing.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -split ';' | Where-Object { $_ -ieq $BinDir })) {
    [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $BinDir), 'User')
    Write-Ok "Added $BinDir to your User PATH (open a new terminal to launch Husk by name)"
}

# Start Menu shortcut.
try {
    $LnkDir = [Environment]::GetFolderPath('Programs')
    $LnkPath = Join-Path $LnkDir "Husk.lnk"
    $WshShell = New-Object -ComObject WScript.Shell
    $Lnk = $WshShell.CreateShortcut($LnkPath)
    $Lnk.TargetPath = $Wrapper
    $Lnk.WorkingDirectory = $AppDir
    $iconCandidate = Join-Path $AppDir "installer\husk-icon.png"
    if (Test-Path $iconCandidate) { $Lnk.IconLocation = $iconCandidate }
    $Lnk.Save()
    Write-Ok "Start Menu shortcut: $LnkPath"
} catch {
    Write-Warn2 ("Could not create Start Menu shortcut: " + $_.Exception.Message)
}

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════"
Write-Host "  Husk installed"
Write-Host "═══════════════════════════════════════════════════════"
Write-Host ""
Write-Host "Launch:    Start menu -> Husk"
Write-Host "Or run:    $Wrapper"
Write-Host "From here: npm start"
Write-Host ""
