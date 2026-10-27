<#
    Registers IngestX to start automatically when this Windows user logs in.
    No administrator rights required: creates a shortcut in the user's Startup
    folder that runs deploy\watchdog.ps1 hidden.
#>

$ErrorActionPreference = 'Stop'

$Root      = Split-Path -Parent $PSScriptRoot
$Watchdog  = Join-Path $PSScriptRoot 'watchdog.ps1'
$Startup   = [Environment]::GetFolderPath('Startup')
$Shortcut  = Join-Path $Startup 'IngestX.lnk'

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($Shortcut)
$link.TargetPath       = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$link.Arguments        = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Watchdog`""
$link.WorkingDirectory = $Root
$link.WindowStyle      = 7
$link.Description      = 'IngestX playout control plane (nginx + Daphne)'
$link.Save()

Write-Host "[IngestX] autostart installed: $Shortcut"
