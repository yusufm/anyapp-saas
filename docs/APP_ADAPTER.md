# App Adapter Guide

This document shows how to make any web app run behind the anyapp-saas layer.

Your app can be written in any language, as long as it runs in a container and follows a few conventions.

---

## Requirements

- Expose an HTTP port inside the container (`APP_PORT`)
- Health check endpoint: `GET /health` returns 200 OK
- Optional metrics endpoint: `GET /metrics` (Prometheus exposition)
- Be reverse-proxy aware (honor `X-Forwarded-*`, do not hardcode base URLs)
- Store tenant data under `/data` (mounted from the host per tenant)
- Accept configuration via environment variables:
  - `TENANT` (slug)
  - `TENANT_NAME` (friendly name)
  - `BASE_DOMAIN_ROOT` (e.g., example.com)
  - `TENANT_PREFIX` (e.g., `t-`)
  - `SF_LOGOUT_REDIRECT_URL` (optional, used by `GET /logout` flows)
  - Any app-specific variables you need

---

## Per-tenant Compose Mounts

From the template `templates/docker-compose.tenant.yml` your app will receive:

- `${APP_DATA_HOST}` → `/data`
- `${SAAS_TEMPLATES_HOST_PATH:-/opt/anyapp-saas/saas-templates}` → `/var/lib/anyapp-saas/templates:ro`

These paths let you persist tenant data and optionally read shared templates/partials.

---

## Hello App Example

A minimal Node.js service that satisfies the adapter contract is provided under `examples/helloapp/`.

Key features:

- Listens on `APP_PORT` (default 8080)
- `GET /health` returns 200
- `GET /metrics` exposes Prometheus metrics
- Shows tenant + domain information on `GET /`

To build it locally:

```bash
cd examples/helloapp
# Build the image using your GHCR/registry namespace
# Replace OWNER with your account, e.g., ghcr.io/yourname/helloapp
IMAGE=ghcr.io/OWNER/helloapp:latest

docker build -t $IMAGE .
docker push $IMAGE  # optional if your VM will pull from a registry
```

Then in your tenant `.env`, set:

```ini
APP_IMAGE=ghcr.io/OWNER/helloapp
APP_TAG=latest
APP_PORT=8080
```

---

## Logs and Debugging

- When testing behind Traefik, ensure your app trusts `X-Forwarded-*` headers (common in frameworks; consult your framework docs).
- If you observe 401 loops, verify your oauth2-proxy settings and cookie domain.
- 403 errors to app routes indicate the tenant ACL forwardAuth rejecting your email; ensure it’s present in `/var/lib/anyapp-saas/tenants/<tenant>/access.yml`.
