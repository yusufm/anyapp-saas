#!/usr/bin/env bash
set -euo pipefail

# Delete a tenant: bring down its stack and optionally delete runtime data
# Usage:
#   ./scripts/delete-tenant.sh <tenant-slug> [--delete-data]

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <tenant-slug> [--delete-data]"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TENANT="$1"; shift || true
DELETE_DATA=0
if [[ "${1:-}" == "--delete-data" ]]; then
  DELETE_DATA=1
fi

TENANT_RUNTIME_DIR="/var/lib/anyapp-saas/tenants/$TENANT"
TENANT_ENV="$TENANT_RUNTIME_DIR/.env"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_DIR/templates/docker-compose.tenant.yml}"
PROJECT_NAME="tenant_$TENANT"

if [[ ! -f "$TENANT_ENV" ]]; then
  echo "Warning: tenant env not found: $TENANT_ENV (continuing with down)" >&2
else
  set -a
  source "$TENANT_ENV"
  export TENANT_ENV_FILE="$TENANT_ENV"
  set +a
fi

# Bring down compose stack (ignore errors if not running)
docker compose -f "$COMPOSE_FILE" --env-file "$TENANT_ENV" -p "$PROJECT_NAME" down || true

echo "Tenant $TENANT stack removed."

if [[ $DELETE_DATA -eq 1 ]]; then
  echo "Deleting runtime directory: $TENANT_RUNTIME_DIR"
  rm -rf "$TENANT_RUNTIME_DIR"
  echo "Runtime data deleted."
else
  echo "Runtime data retained at: $TENANT_RUNTIME_DIR"
fi
