<#
    IngestX process supervisor (Windows).

    Keeps two production processes alive without requiring administrator rights:
      * nginx on :80  (serves the built SPA, proxies /api, /4dm1n, /static, /media, /ws)
      * Daphne on 127.0.0.1:8000 (Django ASGI: REST + WebSockets)

    Started at logon by deploy\install-autostart.ps1. Logs live in backend\logs.
#>

$ErrorActionPreference = 'Continue'

$Root       = Split-Path -Parent $PSScriptRoot
$Backend    = Join-Path $Root 'backend'
$LogDir     = Join-Path $Backend 'logs'
$DaphneExe  = Join-Path $Backend '.venv\Scripts\daphne.exe'
$NginxHome  = 'D:\Program\NGINX'
$NginxExe   = Join-Path $NginxHome 'nginx.exe'
$HealthUrl  = 'http://127.0.0.1:8000/api/auth/me/'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Test-Listening([int]$Port) {
    try {
        return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop)
    } catch {
        return $false
    }
}

function Get-PortOwner([int]$Port) {
    try {
        return (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop |
                Select-Object -First 1 -ExpandProperty OwningProcess)
    } catch {
        return 0
    }
}

function Start-Backend {
    $stamp = Get-Date -Format 'yyyyMMdd'
    $out   = Join-Path $LogDir "daphne-$stamp.log"
    $err   = Join-Path $LogDir "daphne-$stamp.err.log"
    Write-Host "[IngestX] starting Daphne on 127.0.0.1:8000"
    Start-Process -FilePath $DaphneExe `
        -ArgumentList '-b', '127.0.0.1', '-p', '8000', '--proxy-headers', 'core.asgi:application' `
        -WorkingDirectory $Backend `
        -WindowStyle Hidden `
        -RedirectStandardOutput $out `
        -RedirectStandardError $err | Out-Null
}

function Start-Nginx {
    if (-not (Test-Path $NginxExe)) {
        Write-Warning "[IngestX] nginx not found at $NginxExe"
        return
    }
    Write-Host "[IngestX] starting nginx on 0.0.0.0:80"
    Start-Process -FilePath $NginxExe `
        -WorkingDirectory $NginxHome `
        -WindowStyle Hidden | Out-Null
}

function Test-BackendHealth {
    $code = & curl.exe -s -o NUL --max-time 5 -w '%{http_code}' $HealthUrl 2>$null
    return $code -in @('200', '401', '403')
}

function Rotate-OldLogs {
    Get-ChildItem -Path $LogDir -Filter 'daphne-*.log*' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

$lastRotation = Get-Date
$healthFailures = 0

while ($true) {
    if (-not (Test-Listening 8000)) {
        Start-Backend
        Start-Sleep -Seconds 3
        $healthFailures = 0
    } elseif (-not (Test-BackendHealth)) {
        $healthFailures++
        Write-Warning "[IngestX] backend health check failed ($healthFailures/3)"
        if ($healthFailures -ge 3) {
            $pidToStop = Get-PortOwner 8000
            if ($pidToStop) { Stop-Process -Id $pidToStop -Force -ErrorAction SilentlyContinue }
            Start-Sleep -Seconds 2
            Start-Backend
            $healthFailures = 0
        }
    } else {
        $healthFailures = 0
    }

    if (-not (Test-Listening 80)) {
        Start-Nginx
        Start-Sleep -Seconds 2
    }

    if ((Get-Date) -gt $lastRotation.AddHours(6)) {
        Rotate-OldLogs
        $lastRotation = Get-Date
    }

    Start-Sleep -Seconds 10
}
