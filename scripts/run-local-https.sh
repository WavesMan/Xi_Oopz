#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f .env ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == export\ * ]] && line="${line#export }"
    key="${line%%=*}"
    value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:-1}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:-1}"
    fi
    export "$key=$value"
  done < .env
fi

: "${PORT:=8443}"
: "${HTTPS_ENABLED:=true}"
: "${MYSQL_DSN:=root:password@tcp(127.0.0.1:3307)/oopz?parseTime=true&multiStatements=true}"
: "${REDIS_ADDR:=127.0.0.1:6379}"
: "${AUTH_SECRET:=oopz-dev-secret}"

if [[ -z "${TLS_CERT_FILE:-}" || -z "${TLS_KEY_FILE:-}" ]]; then
  echo "TLS_CERT_FILE or TLS_KEY_FILE is missing."
  echo "Example:"
  echo "  TLS_CERT_FILE=/absolute/path/to/localhost.pem"
  echo "  TLS_KEY_FILE=/absolute/path/to/localhost-key.pem"
  exit 1
fi

if [[ ! -f "$TLS_CERT_FILE" ]]; then
  echo "TLS cert not found: $TLS_CERT_FILE"
  exit 1
fi

if [[ ! -f "$TLS_KEY_FILE" ]]; then
  echo "TLS key not found: $TLS_KEY_FILE"
  exit 1
fi

echo "Building frontend dist..."
(
  cd frontend
  npm run build
)

echo "Starting HTTPS server on https://localhost:${PORT}"
HTTPS_ENABLED="$HTTPS_ENABLED" \
PORT="$PORT" \
GOCACHE="${GOCACHE:-$ROOT_DIR/.cache/go-build}" \
GOMODCACHE="${GOMODCACHE:-$ROOT_DIR/.cache/go-mod}" \
go run ./cmd/server
