# Configuration Reference

This page documents the key configuration knobs for the core stack, app adapter, and per-tenant settings.

---

## Core stack (docker-compose.yml)

### Traefik

- `traefik/traefik.yml`
  - `certificatesResolvers.le.acme.email` — Let’s Encrypt email (set to your address)
  - `providers.docker.network` — must match the external Docker network (`proxy`)
  - `providers.file.directory` — points to `traefik/dynamic/`

- `traefik/dynamic/`
  - `middlewares.yml` — oauth2 forwardAuth, error redirection, tenant access check
  - `routers.yml` — routes `/oauth2/*` to oauth2-proxy and Stripe webhook/auth endpoints to provisioner on `www.example.com`

- `traefik/acme.json`
  - Must exist and be `chmod 600`

### oauth2-proxy (auth)

Provided via the `auth` service in `docker-compose.yml`. Uses env from `templates/auth.env.example` by default.

Required (Auth0 OIDC):

- `OAUTH2_PROXY_PROVIDER=oidc`
- `OAUTH2_PROXY_OIDC_ISSUER_URL=https://YOUR_AUTH0_DOMAIN/`
- `OAUTH2_PROXY_CLIENT_ID`
- `OAUTH2_PROXY_CLIENT_SECRET`
- `OAUTH2_PROXY_COOKIE_SECRET` (32-byte base64)
- `OAUTH2_PROXY_REDIRECT_URL=https://www.example.com/oauth2/callback`

Optional:

- `OAUTH2_PROXY_COOKIE_DOMAINS=.example.com`
- `OAUTH2_PROXY_EMAIL_DOMAINS=*`
- `OAUTH2_PROXY_COOKIE_SECURE=true`
- `OAUTH2_PROXY_COOKIE_SAMESITE=lax`

### Provisioner

Provided via `services/provisioner/`. Uses env from `templates/billing.env.example` and inline env in `docker-compose.yml`.

Core:

- `TENANT_ROOT_DOMAIN` (default: `example.com`)
- `TENANT_PREFIX` (default: `t-`)
- `RUNTIME_TENANTS_PATH` (default: `/var/lib/anyapp-saas/tenants`)
- `REPO_PATH` (default: `/opt/repo` inside container)
- `AUTH_DEBUG` (optional: `1` to enable `/auth/me` and debug behavior)
- `PROVISIONER_ALLOWED_ORIGINS` (comma-separated list for CORS)

Stripe billing:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ID`
- `CHECKOUT_SUCCESS_URL`
- `CHECKOUT_CANCEL_URL`
- `TENANT_SLUG_MAX_LEN` (default: computed from DNS max label 63 minus prefix length)

Optional registries and PR automation:

- `GHCR_USER`, `GHCR_TOKEN` (for private images)
- `GITHUB_REPO`, `GITHUB_TOKEN`, `GITHUB_DEFAULT_BRANCH`
- `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`

---

## Tenant configuration (templates/tenant.env.example)

- `TENANT` — slug (e.g., `tenant-aaa`)
- `TENANT_NAME` — friendly name (optional)
- `BASE_DOMAIN_ROOT` — e.g., `example.com`
- `TENANT_PREFIX` — e.g., `t-`
- `APP_IMAGE` — container image for your app
- `APP_TAG` — tag for your app image
- `APP_PORT` — internal port your app listens on
- `APP_DATA_HOST` — host path mounted to `/data` inside the container
- `SAAS_TEMPLATES_HOST_PATH` — optional host path for branding/partials (default `/opt/anyapp-saas/saas-templates`)
- `SF_LOGOUT_REDIRECT_URL` — optional logout chain URL (Auth0 → oauth2-proxy → landing)

These env values are consumed by the shared per-tenant compose file: `templates/docker-compose.tenant.yml`.

---

## App Adapter expectations

Your app image must support:

- Health: `GET /health` → 200 OK
- Optional metrics: `GET /metrics`
- Reverse proxy headers: honor `X-Forwarded-*`
- Storage under `/data`

Env provided to the container:

- `TENANT`, `TENANT_NAME`, `BASE_DOMAIN_ROOT`, `TENANT_PREFIX`
- `SF_LOGOUT_REDIRECT_URL` (if set)
- Any app-specific env you include in the tenant `.env`

---

## Paths and networks

- External Docker network: `proxy` (must exist)
- Runtime tenants (on VM): `/var/lib/anyapp-saas/tenants/<tenant>/`
  - `.env`, `access.yml`, `data/`
- SaaS templates mount: host `${SAAS_TEMPLATES_HOST_PATH:-/opt/anyapp-saas/saas-templates}` → container `/var/lib/anyapp-saas/templates:ro`
