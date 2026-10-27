<#
    Polls GitHub for new commits and deploys them automatically.

    Intended to be run by Windows Task Scheduler every 5 minutes (user-level
    task, no administrator rights required). Safe to run manually.
#>

$ErrorActionPreference = 'Continue'

$Root   = Split-Path -Parent $PSScriptRoot
$Git    = 'C:\Program Files\Git\cmd\git.exe'
$LogDir = Join-Path $Root 'backend\logs'
$Lock   = Join-Path $Root 'deploy\.auto-pull.lock'
$Log    = Join-Path $LogDir 'auto-pull.log'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# Prevent overlapping runs.
if (Test-Path $Lock) {
    $age = (Get-Date) - (Get-Item $Lock).LastWriteTime
    if ($age.TotalMinutes -lt 15) {
        Write-Host "Another run is in progress ($([int]$age.TotalMinutes)m). Skipping."
        exit 0
    }
    Remove-Item $Lock -Force
}
New-Item -ItemType File -Path $Lock | Out-Null

function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Add-Content -Path $Log -Value $line
    Write-Host $line
}

try {
    Push-Location $Root
    & $Git fetch origin main 2>&1 | Out-Null

    $local  = (& $Git rev-parse HEAD).Trim()
    $remote = (& $Git rev-parse origin/main).Trim()

    if ($local -eq $remote) {
        Log "No new commits ($local)."
        exit 0
    }

    Log "New commits detected: $local -> $remote. Deploying..."
    & powershell -ExecutionPolicy Bypass -File (Join-Path $Root 'deploy\update.ps1') 2>&1 |
        Tee-Object -FilePath (Join-Path $LogDir 'auto-pull-deploy.log') | Out-Null

    if ($LASTEXITCODE -eq 0) {
        Log "Deploy succeeded. Now at $((& $Git rev-parse HEAD).Trim())."
    } else {
        Log "Deploy FAILED (exit $LASTEXITCODE). Check auto-pull-deploy.log."
    }
} catch {
    Log "ERROR: $($_.Exception.Message)"
} finally {
    Remove-Item $Lock -Force -ErrorAction SilentlyContinue
    Pop-Location
}
