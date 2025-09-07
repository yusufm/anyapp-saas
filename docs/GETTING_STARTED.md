# Getting Started

This guide takes you from zero to a working multi-tenant SaaS proxy with Traefik, oauth2-proxy (Auth0), a Stripe-enabled provisioner, and a per-tenant Docker Compose template.

If you prefer a tiny checklist, see the Quickstart in the repo `README.md`.

---

## 1) Prerequisites

- Docker and Docker Compose v2
- A domain managed by you (e.g., example.com)
- An Auth0 application (OIDC)
- Stripe account for billing (optional, can be added later)

Networking note: this stack uses an external Docker network named `proxy` for all routed services.

---

## 2) Clone and bootstrap the repo

```bash
# one-time: create global docker network used by Traefik and tenant stacks
docker network create proxy || true

# create ACME storage with correct permissions
mkdir -p traefik
: > traefik/acme.json
chmod 600 traefik/acme.json
```

Edit `traefik/traefik.yml` and set your ACME email (used by Let’s Encrypt):

```yaml
certificatesResolvers:
  le:
    acme:
      email: changeme@example.com  # <— set to your email
```

---

## 3) Configure oauth2-proxy (Auth0)

Copy `templates/auth.env.example` and set the following values (do not commit secrets):

- `OAUTH2_PROXY_PROVIDER=oidc`
- `OAUTH2_PROXY_OIDC_ISSUER_URL=https://YOUR_AUTH0_DOMAIN/` (trailing slash OK)
- `OAUTH2_PROXY_CLIENT_ID=...`
- `OAUTH2_PROXY_CLIENT_SECRET=...`
- `OAUTH2_PROXY_COOKIE_SECRET=<32-byte base64>`
- `OAUTH2_PROXY_REDIRECT_URL=https://www.example.com/oauth2/callback`
- Optional: `OAUTH2_PROXY_COOKIE_DOMAINS=.example.com` for subdomain-wide cookies

Auth0 application settings:

- Application type: Regular Web App
- Allowed Callback URLs: `https://www.example.com/oauth2/callback`
- Allowed Logout URLs:
  - `https://auth.example.com/oauth2/sign_out` (if you stand up an auth host)
  - Any final landing URL(s), e.g. `https://www.example.com`

Traefik routes all `PathPrefix(/oauth2)` traffic to oauth2-proxy (`auth` service) regardless of host, so using `www.example.com` for the Redirect URL is convenient.

Wire the env file into the `auth` service in `docker-compose.yml` (already defaulted to `templates/auth.env.example`). You can change this to your own path.

---

## 4) Configure Stripe (optional)

Copy `templates/billing.env.example` and set:

- `STRIPE_SECRET_KEY=sk_test_...`
- `STRIPE_WEBHOOK_SECRET=whsec_...`
- `STRIPE_PRICE_ID=price_...`
- `CHECKOUT_SUCCESS_URL=https://www.example.com/success`
- `CHECKOUT_CANCEL_URL=https://www.example.com/cancel`

Webhook endpoint to add in Stripe: `https://www.example.com/webhooks/stripe`

Provisioner CORS: you can override allowed origins via `PROVISIONER_ALLOWED_ORIGINS` env (comma-separated).

---

## 5) Start core services

```bash
docker compose up -d
```

- Traefik serves `:80` and `:443` and reads dynamic config from `traefik/dynamic/`.
- oauth2-proxy listens on `:4180` inside the container; routed via Traefik on `/oauth2/*`.
- Provisioner listens on `:8080` internally; `(www) + /auth/*` and `/webhooks/stripe` are routed by Traefik.

DNS:

- Point `www.example.com` to your VM IP (A/AAAA) so the Auth routes and Stripe webhooks work.
- Later, each tenant gets `t-<slug>.example.com`.

---

## 6) Create your first tenant

Create runtime files (on the VM where this repo runs):

```bash
./scripts/add-tenant.sh tenant-aaa
```

This creates `/var/lib/anyapp-saas/tenants/tenant-aaa/` with:

- `.env` based on `templates/tenant.env.example`
- `access.yml` based on `templates/access.example.yml`

Provision and start the tenant app:

```bash
TENANT_ENV_FILE=/var/lib/anyapp-saas/tenants/tenant-aaa/.env \
  docker compose -f templates/docker-compose.tenant.yml \
  --env-file /var/lib/anyapp-saas/tenants/tenant-aaa/.env \
  -p tenant_tenant-aaa up -d
```

Alternatively, trigger Stripe checkout → webhook → auto-provisioning flow.

Set DNS: `t-tenant-aaa.example.com` → your VM IP.

---

## 7) App Adapter Contract (your app’s requirements)

Your container must:

- Listen on `APP_PORT`
- Provide `/health` → 200 OK
- Optionally provide `/metrics` (Prometheus exposition)
- Honor reverse proxy headers (`X-Forwarded-*`); don’t hardcode base URLs
- Persist under `/data` (mounted from host `${APP_DATA_HOST}`)
- Accept env: `TENANT`, `TENANT_NAME`, `BASE_DOMAIN_ROOT`, `TENANT_PREFIX`, optional `SF_LOGOUT_REDIRECT_URL`, and your app-specific vars

Per-tenant compose mounts:

- `${APP_DATA_HOST}` → `/data`
- `${SAAS_TEMPLATES_HOST_PATH:-/opt/anyapp-saas/saas-templates}` → `/var/lib/anyapp-saas/templates:ro`

---

## 8) Common operations

- Redeploy a tenant:

```bash
./scripts/redeploy-tenant.sh tenant-aaa
```

- Suspend (stop containers, keep data):

```bash
./scripts/suspend-tenant.sh tenant-aaa
```

- Delete tenant stack (optional `--delete-data`):

```bash
./scripts/delete-tenant.sh tenant-aaa --delete-data
```

- Validate tenant ACLs:

```bash
node ./scripts/validate-access.js
```

---

## 9) Troubleshooting

- Certificates not appearing: ensure `traefik/acme.json` is `0600` and domain points to the VM.
- 401 loops: verify oauth2-proxy env, callback URL, and cookies domain settings.
- 403 on tenant: ensure your email is listed in the tenant’s `access.yml` (`owners`/`members` or `roles`).
- webhook 4xx: confirm Stripe webhook secret and Traefik router for `/webhooks/stripe`.

---

## 10) Security recommendations

- Do not commit real secrets; use env files or a secrets manager.
- Limit `PROVISIONER_ALLOWED_ORIGINS` in production.
- Consider Cloudflare proxied DNS in front of your VM.
- Restrict SSH access and keep Docker/host patched.
