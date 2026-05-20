# Husk installer download-and-verify helpers. Dot-sourced by install.ps1.
#
# Pinning policy: the SHA256 constants in install.ps1 pin a specific
# upstream revision of any script we fetch. We download to a temp file
# and check its hash against the pinned value before executing.
#
# Updating a pin: review the upstream script you intend to allow, then
#   (Invoke-WebRequest <url>).Content | Out-File -Encoding ascii t.txt
#   (Get-FileHash -Algorithm SHA256 t.txt).Hash.ToLower()
# and replace the matching constant in install.ps1.

function Verify-Sha256 {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Expected
    )
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower()
    return ($actual -eq $Expected.ToLower())
}

function Get-VerifiedDownload {
    param(
        [Parameter(Mandatory)][string]$Url,
        [Parameter(Mandatory)][string]$Expected,
        [Parameter(Mandatory)][string]$OutFile
    )
    try {
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop | Out-Null
    } catch {
        if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force }
        return $false
    }
    if (-not (Verify-Sha256 -Path $OutFile -Expected $Expected)) {
        Remove-Item -LiteralPath $OutFile -Force
        return $false
    }
    return $true
}
