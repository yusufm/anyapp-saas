#!/usr/bin/env bash
set -euo pipefail

# Suspend a tenant by stopping its containers (keeps volumes/data)
# Usage:
#   ./scripts/suspend-tenant.sh <tenant-slug>

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <tenant-slug>"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TENANT="$1"
TENANT_RUNTIME_DIR="/var/lib/anyapp-saas/tenants/$TENANT"
TENANT_ENV="$TENANT_RUNTIME_DIR/.env"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_DIR/templates/docker-compose.tenant.yml}"
PROJECT_NAME="tenant_$TENANT"

if [[ ! -f "$TENANT_ENV" ]]; then
  echo "Error: tenant env not found: $TENANT_ENV" >&2
  exit 2
fi

set -a
source "$TENANT_ENV"
export TENANT_ENV_FILE="$TENANT_ENV"
set +a

# Stop all services for this tenant
docker compose -f "$COMPOSE_FILE" --env-file "$TENANT_ENV" -p "$PROJECT_NAME" stop

echo "Tenant $TENANT suspended (containers stopped)."
