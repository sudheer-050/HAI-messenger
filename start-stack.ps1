# Brings up the HAI Messenger docker stack and the Multica daemon after login.
# Docker Desktop is launched separately via its own Run-key autostart entry;
# this script just waits for the engine to be ready, then starts everything else.

$logFile = "$env:USERPROFILE\hurricane-chat\startup.log"
function Log($msg) {
    "[$(Get-Date -Format s)] $msg" | Out-File -FilePath $logFile -Append -Encoding utf8
}

Log "start-stack.ps1 triggered"

# Wait up to 5 minutes for the Docker engine to come up
$dockerReady = $false
for ($i = 0; $i -lt 60; $i++) {
    docker info *> $null
    if ($LASTEXITCODE -eq 0) {
        $dockerReady = $true
        break
    }
    Start-Sleep -Seconds 5
}

if (-not $dockerReady) {
    Log "Docker engine did not become ready in time, aborting compose up"
} else {
    Log "Docker engine ready, starting compose stack"
    Set-Location "$env:USERPROFILE\hurricane-chat"
    docker compose up -d *> $null
    Log "docker compose up -d exit code: $LASTEXITCODE"
}

# Start the Multica daemon (safe no-op if already running)
Log "Ensuring Multica daemon is running"
& "$env:USERPROFILE\.multica\bin\multica" daemon start *> $null
Log "multica daemon start exit code: $LASTEXITCODE"

# Open both dashboards in the default browser
Log "Opening myhai.org and multica.ai in browser"
Start-Process "https://myhai.org"
Start-Process "https://multica.ai"
