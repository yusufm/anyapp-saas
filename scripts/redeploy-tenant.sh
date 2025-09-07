#!/usr/bin/env bash
set -euo pipefail

# Redeploy a tenant by pulling the latest images and restarting services
# Usage:
#   ./scripts/redeploy-tenant.sh <tenant-slug> [service ...]
#
# Examples:
#   ./scripts/redeploy-tenant.sh tenant-aaa            # pull & restart all services for tenant-aaa
#   ./scripts/redeploy-tenant.sh tenant-aaa web api    # pull & restart only web and api services
#
# Notes:
# - Uses runtime tenant env at /var/lib/anyapp-saas/tenants/<tenant>/.env
# - Uses shared compose file at templates/docker-compose.tenant.yml
# - If GHCR_USER and GHCR_TOKEN env vars are set, logs into ghcr.io before pulling

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <tenant-slug> [service ...]"
  exit 1
fi

# Resolve repo root relative to this script's directory so it works from any CWD
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TENANT="$1"; shift || true
SERVICES=("$@")

TENANT_RUNTIME_DIR="/var/lib/anyapp-saas/tenants/$TENANT"
TENANT_ENV="$TENANT_RUNTIME_DIR/.env"

# Allow override via COMPOSE_FILE env; otherwise prefer shared template, then per-tenant compose
COMPOSE_FILE="${COMPOSE_FILE:-}"
if [[ -z "${COMPOSE_FILE}" ]]; then
  CANDIDATE_SHARED="$REPO_DIR/templates/docker-compose.tenant.yml"
  CANDIDATE_TENANT="$REPO_DIR/tenants/$TENANT/docker-compose.yml"
  if [[ -f "$CANDIDATE_SHARED" ]]; then
    COMPOSE_FILE="$CANDIDATE_SHARED"
  elif [[ -f "$CANDIDATE_TENANT" ]]; then
    COMPOSE_FILE="$CANDIDATE_TENANT"
  else
    echo "Error: compose file not found. Tried: $CANDIDATE_SHARED and $CANDIDATE_TENANT" >&2
    exit 2
  fi
fi

PROJECT_NAME="tenant_$TENANT"

if [[ ! -f "$TENANT_ENV" ]]; then
  echo "Error: tenant env not found: $TENANT_ENV" >&2
  exit 3
fi

# Optional GHCR login for private images
if [[ -n "${GHCR_USER:-}" && -n "${GHCR_TOKEN:-}" ]]; then
  echo "Logging into ghcr.io as $GHCR_USER"
  docker login ghcr.io -u "$GHCR_USER" -p "$GHCR_TOKEN"
fi

# Export tenant env so docker compose variable interpolation works
set -a
# shellcheck source=/dev/null
source "$TENANT_ENV"
export TENANT_ENV_FILE="$TENANT_ENV"
set +a

# Pull latest images
if [[ ${#SERVICES[@]} -gt 0 ]]; then
  echo "Pulling images for tenant $TENANT services: ${SERVICES[*]}"
  docker compose -f "$COMPOSE_FILE" --env-file "$TENANT_ENV" -p "$PROJECT_NAME" pull "${SERVICES[@]}"
else
  echo "Pulling images for all services in tenant $TENANT"
  docker compose -f "$COMPOSE_FILE" --env-file "$TENANT_ENV" -p "$PROJECT_NAME" pull
fi

# Recreate/restart containers
# --no-deps to avoid unintended dependency restarts when targeting specific services
# --force-recreate to ensure containers restart even if config unchanged
if [[ ${#SERVICES[@]} -gt 0 ]]; then
  echo "Restarting services for tenant $TENANT: ${SERVICES[*]}"
  docker compose -f "$COMPOSE_FILE" --env-file "$TENANT_ENV" -p "$PROJECT_NAME" up -d --no-deps --force-recreate "${SERVICES[@]}"
else
  echo "Restarting all services for tenant $TENANT"
  docker compose -f "$COMPOSE_FILE" --env-file "$TENANT_ENV" -p "$PROJECT_NAME" up -d --force-recreate
fi

echo "Done. Tenant $TENANT has been redeployed."
