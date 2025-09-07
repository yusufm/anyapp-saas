#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <tenant-slug> <base-domain-root> [tenant-name] [owner-email]"
  exit 1
fi

TENANT="$1"             # e.g., tenant-aaa
BASE_DOMAIN_ROOT="$2"   # e.g., example.com
TENANT_NAME_INPUT="${3:-}"
OWNER_EMAIL_INPUT="${4:-}"
REPO_DIR="/opt/repo"    # mounted inside provisioner container

# Optional: GHCR credentials for pulling private/container images
GHCR_USER_ENV="${GHCR_USER:-}"
GHCR_TOKEN_ENV="${GHCR_TOKEN:-}"

# GitHub configuration for PR creation (optional; disabled in this model)
GITHUB_REPO="${GITHUB_REPO:-}"                  # owner/name
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
GITHUB_DEFAULT_BRANCH="${GITHUB_DEFAULT_BRANCH:-main}"
GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-Provisioner Bot}"
GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-changeme@example.com}"

cd "$REPO_DIR"

# Portable in-place sed (GNU vs BSD)
sedi() {
  if sed --version >/dev/null 2>&1; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

# 1) Create tenant runtime files (in /var/lib/anyapp-saas/tenants)
./scripts/add-tenant.sh "$TENANT"

# 1c) If a human-friendly tenant name was provided, persist to .env (runtime path)
TENANT_RUNTIME_DIR="/var/lib/anyapp-saas/tenants/$TENANT"
TENANT_ENV="$TENANT_RUNTIME_DIR/.env"
if [[ -n "$TENANT_NAME_INPUT" && -f "$TENANT_ENV" ]]; then
  # Remove any existing TENANT_NAME line, then append
  if grep -qE '^TENANT_NAME=' "$TENANT_ENV"; then
    sedi -e '/^TENANT_NAME=/d' "$TENANT_ENV"
  fi
  printf 'TENANT_NAME=%s\n' "$TENANT_NAME_INPUT" >> "$TENANT_ENV"
fi

# 1c-1) Ensure per-tenant persistent data directory exists and has correct ownership
if [[ -f "$TENANT_ENV" ]]; then
  APP_DATA_HOST=$(grep -E '^APP_DATA_HOST=' "$TENANT_ENV" | cut -d'=' -f2- || true)
  if [[ -n "$APP_DATA_HOST" ]]; then
    echo "Ensuring tenant data directory exists: $APP_DATA_HOST"
    # Create dir and chown to app user (uid:gid 10001) via a helper container so host perms match container user
    docker run --rm -v "$APP_DATA_HOST:/data" busybox:latest sh -c 'mkdir -p /data && chown -R 10001:10001 /data' || true
  fi
fi

# 1c-2) Record project name into access.yml as a proper field 'project_name' (runtime path)
ACCESS_YAML="$TENANT_RUNTIME_DIR/access.yml"
if [[ -n "$TENANT_NAME_INPUT" && -f "$ACCESS_YAML" ]]; then
  if grep -qE '^project_name:' "$ACCESS_YAML"; then
    # Update existing field
    sedi -e "s/^project_name:.*/project_name: ${TENANT_NAME_INPUT//\//\/}/" "$ACCESS_YAML"
  else
    # Insert after the tenant line
    TMP_FILE="${ACCESS_YAML}.tmp"
    awk -v pn="$TENANT_NAME_INPUT" '
      BEGIN { inserted=0 }
      /^tenant:[[:space:]]*/ && inserted==0 { print; print "project_name: " pn; inserted=1; next }
      { print }
      END { if (inserted==0) { print "project_name: " pn } }
    ' "$ACCESS_YAML" > "$TMP_FILE" && mv "$TMP_FILE" "$ACCESS_YAML"
  fi
fi

# 1d) If an owner email was provided, inject into access.yml (runtime path)
if [[ -n "$OWNER_EMAIL_INPUT" && -f "$ACCESS_YAML" ]]; then
  # Basic email sanity check
  if [[ "$OWNER_EMAIL_INPUT" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
    # Replace default owner placeholder in both owners list and roles map
    sedi -e "s/owner@example.com/$OWNER_EMAIL_INPUT/g" "$ACCESS_YAML"
  else
    echo "Warning: OWNER_EMAIL_INPUT does not look like an email; leaving access.yml as template default"
  fi
fi

# 2) Authenticate to GHCR if creds are provided (optional)
if [[ -n "$GHCR_USER_ENV" && -n "$GHCR_TOKEN_ENV" ]]; then
  echo "Logging in to ghcr.io as $GHCR_USER_ENV"
  docker login ghcr.io -u "$GHCR_USER_ENV" -p "$GHCR_TOKEN_ENV"
fi

# 3) Bring up tenant stack using shared template
# Export tenant env into the shell so docker compose variable interpolation works
set -a
source "$TENANT_ENV"
export TENANT_ENV_FILE="$TENANT_ENV"
set +a

docker compose \
  -f templates/docker-compose.tenant.yml \
  --env-file "$TENANT_ENV" \
  -p "tenant_$TENANT" pull

docker compose \
  -f templates/docker-compose.tenant.yml \
  --env-file "$TENANT_ENV" \
  -p "tenant_$TENANT" up -d

# Determine TENANT_PREFIX from the tenant .env if present (default t-)
if [[ -f "$TENANT_ENV" ]]; then
  TENANT_PREFIX=$(grep -E '^TENANT_PREFIX=' "$TENANT_ENV" | cut -d'=' -f2- || true)
fi
TENANT_PREFIX=${TENANT_PREFIX:-t-}
echo "Provisioned tenant: $TENANT at https://${TENANT_PREFIX}${TENANT}.$BASE_DOMAIN_ROOT"
