#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <tenant-slug>"
  exit 1
fi

TENANT="$1" # e.g., tenant-aaa
BASE_DOMAIN_ROOT="${BASE_DOMAIN_ROOT:-example.com}"
TEMPLATE_DIR="$(dirname "$0")/../templates"
TENANTS_DIR="/var/lib/anyapp-saas/tenants"

# Portable in-place sed (GNU vs BSD)
sedi() {
  if sed --version >/dev/null 2>&1; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

mkdir -p "$TENANTS_DIR/$TENANT"
cp "$TEMPLATE_DIR/tenant.env.example" "$TENANTS_DIR/$TENANT/.env"
# Replace default tenant in env
sedi -e "s/tenant-aaa/$TENANT/g" "$TENANTS_DIR/$TENANT/.env"

# Add access control file from template and substitute tenant slug
if [[ -f "$TEMPLATE_DIR/access.example.yml" ]]; then
  cp "$TEMPLATE_DIR/access.example.yml" "$TENANTS_DIR/$TENANT/access.yml"
  sedi -e "s/tenant-aaa/$TENANT/g" "$TENANTS_DIR/$TENANT/access.yml"
fi

# Determine TENANT_PREFIX from env (default t-)
TENANT_PREFIX=$(grep -E '^TENANT_PREFIX=' "$TENANTS_DIR/$TENANT/.env" | cut -d'=' -f2- || true)
TENANT_PREFIX=${TENANT_PREFIX:-t-}

cat <<EONEXT
Tenant created: $TENANT
1) Set DNS: ${TENANT_PREFIX}${TENANT}.$BASE_DOMAIN_ROOT -> VM IP (Cloudflare proxied ON)
2) On VM: from repo root, run:
   TENANT_ENV_FILE=/var/lib/anyapp-saas/tenants/$TENANT/.env \
   docker compose -f templates/docker-compose.tenant.yml --env-file /var/lib/anyapp-saas/tenants/$TENANT/.env -p tenant_$TENANT pull
   TENANT_ENV_FILE=/var/lib/anyapp-saas/tenants/$TENANT/.env \
   docker compose -f templates/docker-compose.tenant.yml --env-file /var/lib/anyapp-saas/tenants/$TENANT/.env -p tenant_$TENANT up -d
3) (Optional) Run migrations as needed, e.g.:
   TENANT_ENV_FILE=/var/lib/anyapp-saas/tenants/$TENANT/.env \
   docker compose -f templates/docker-compose.tenant.yml --env-file /var/lib/anyapp-saas/tenants/$TENANT/.env -p tenant_$TENANT run --rm app npm run migrate
EONEXT
