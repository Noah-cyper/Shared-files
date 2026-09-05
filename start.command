#!/bin/sh
# Chay tren macOS / Linux:  sh start.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Chua cai Node.js. Tai ban LTS tai https://nodejs.org roi chay lai file nay."
  exit 1
fi
exec node server.js
