<#
    Pulls the latest code and redeploys IngestX in place.

    Steps: git pull -> pip install -> npm ci + build -> migrate -> collectstatic
           -> restart Daphne (the watchdog brings it back) -> reload nginx.

    Stop the deployment first if you need a zero-downtime window; for a LAN
    install the few seconds of API unavailability during restart are acceptable.
#>

$ErrorActionPreference = 'Stop'

$Root    = Split-Path -Parent $PSScriptRoot
$Backend = Join-Path $Root 'backend'
$Front   = Join-Path $Root 'frontend'
$Python  = Join-Path $Backend '.venv\Scripts\python.exe'
$Daphne  = Join-Path $Backend '.venv\Scripts\daphne.exe'
$Git     = 'C:\Program Files\Git\cmd\git.exe'
$Nginx   = 'D:\Program\NGINX\nginx.exe'

function Step($Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }

Step 'Pulling latest code'
# Stash any local production edits (deploy config) so the pull can fast-forward.
$stash = & $Git -C $Root stash push -u -m 'auto-deploy-stash' 2>&1
$popped = $false
if ($stash -notmatch 'No local changes') {
    $popped = $true
}
& $Git -C $Root pull --ff-only
if ($popped) {
    $pop = & $Git -C $Root stash pop 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Stash pop had conflicts; resolve manually:`n$pop"
        throw 'Deploy aborted due to merge conflict.'
    }
}

Step 'Installing backend dependencies'
& $Python -m pip install -r (Join-Path $Backend 'requirements.txt') --disable-pip-version-check

Step 'Installing frontend dependencies'
Push-Location $Front
try {
    & npm ci --no-audit --no-fund
    Step 'Building frontend'
    & npm run build
} finally {
    Pop-Location
}

Step 'Applying migrations'
& $Python (Join-Path $Backend 'manage.py') migrate --noinput

Step 'Collecting static files'
& $Python (Join-Path $Backend 'manage.py') collectstatic --noinput

Step 'Reloading nginx'
if (Test-Path $Nginx) {
    & $Nginx -p 'D:\Program\NGINX' -c 'conf\nginx.conf' -s reload
}

Step 'Restarting Daphne'
try {
    # NOT `$pid`: that is a read-only PowerShell automatic variable, so assigning
    # to it throws and the catch block then wrongly reports "Daphne was not
    # running" -- leaving the old process serving stale Python after a deploy.
    $daphnePid = Get-NetTCPConnection -State Listen -LocalPort 8000 -ErrorAction Stop |
        Select-Object -First 1 -ExpandProperty OwningProcess
    if ($daphnePid) { Stop-Process -Id $daphnePid -Force }
    Write-Host 'Daphne stopped; the watchdog will start it again within 10s.'
} catch {
    Write-Host 'Daphne was not running.'
}

Write-Host "`nIngestX redeployed." -ForegroundColor Green
