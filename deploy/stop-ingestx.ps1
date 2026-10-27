<#
    Stops the IngestX supervisor, Daphne and nginx.

    Only processes owned by this deployment are touched: the watchdog by its
    command line, Daphne by the PID listening on 127.0.0.1:8000, nginx by its
    install path.
#>

$ErrorActionPreference = 'Continue'

$NginxHome = 'D:\Program\NGINX'
$NginxExe  = Join-Path $NginxHome 'nginx.exe'

Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*deploy\watchdog.ps1*' } |
    ForEach-Object {
        Write-Host "[IngestX] stopping supervisor pid $($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

try {
    $backendPid = Get-NetTCPConnection -State Listen -LocalPort 8000 -ErrorAction Stop |
        Select-Object -First 1 -ExpandProperty OwningProcess
    if ($backendPid) {
        Write-Host "[IngestX] stopping Daphne pid $backendPid"
        Stop-Process -Id $backendPid -Force -ErrorAction SilentlyContinue
    }
} catch { }

if (Test-Path $NginxExe) {
    Write-Host '[IngestX] stopping nginx'
    & $NginxExe -p $NginxHome -c 'conf\nginx.conf' -s quit 2>$null
}

Write-Host '[IngestX] stopped.'
