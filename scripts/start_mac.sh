#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose up --build -d --wait
echo 'AP1000 RPS training simulator: http://localhost:8000'
