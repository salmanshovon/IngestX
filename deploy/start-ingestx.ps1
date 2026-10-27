<#
    Starts IngestX now without waiting for the next logon.
    Launches the same supervisor used by autostart, hidden, and waits for health.
#>

$ErrorActionPreference = 'Stop'

$Root      = Split-Path -Parent $PSScriptRoot
$Watchdog  = Join-Path $PSScriptRoot 'watchdog.ps1'
$LogDir    = Join-Path $Root 'backend\logs'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$alreadyRunning = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*deploy\watchdog.ps1*' }

if (-not $alreadyRunning) {
    Start-Process -FilePath 'powershell.exe' `
        -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$Watchdog`"" `
        -WorkingDirectory $Root `
        -WindowStyle Hidden | Out-Null
    Write-Host '[IngestX] supervisor started.'
} else {
    Write-Host '[IngestX] supervisor already running.'
}

for ($i = 0; $i -lt 30; $i++) {
    $code = & curl.exe -s -o NUL --max-time 3 -w '%{http_code}' 'http://127.0.0.1/api/auth/me/' 2>$null
    if ($code -in @('200', '401', '403')) {
        Write-Host "[IngestX] ready at http://$env:COMPUTERNAME/ and http://127.0.0.1/ (API $code)"
        exit 0
    }
    Start-Sleep -Seconds 1
}

Write-Warning '[IngestX] did not become healthy within 30s. Check backend\logs.'
exit 1
