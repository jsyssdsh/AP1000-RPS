$ErrorActionPreference = "Stop"
Set-Location "$PSScriptRoot\.."
docker compose up --build -d --wait
if ($LASTEXITCODE -ne 0) { throw "Docker Compose failed" }
Write-Host "AP1000 RPS training simulator: http://localhost:8000"
