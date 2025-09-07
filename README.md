# anyapp-saas

A generic, Docker Compose-first SaaS layer you can use to run any containerized web application per tenant.

Features:

- Traefik reverse-proxy with TLS via Let’s Encrypt
- oauth2-proxy + Auth0 for authentication (forwardAuth)
- YAML-based tenant access guard (forwardAuth to provisioner)
- Stripe billing with webhook-driven tenant provisioning
- Per-tenant Docker Compose template with subdomain routing (t-<tenant>.example.com)
- Script-based tenant lifecycle (add/provision/redeploy/suspend/delete)
- App Adapter Contract so any app can plug in

## Quickstart

Prereqs:

- Docker and Docker Compose (v2)
- A domain and DNS provider (e.g., Cloudflare)
- Auth0 application (Client ID/Secret, Issuer URL)
- Stripe account (for billing)

1) Clone this repo and create the external `proxy` network once:

```
docker network create proxy || true
```

2) Configure Traefik ACME email and domain in `traefik/traefik.yml` (placeholder is used by default). Create `acme.json` with proper perms:

```
mkdir -p traefik
: > traefik/acme.json
chmod 600 traefik/acme.json
```

3) Start the core stack (Traefik, oauth2-proxy, provisioner):

```
docker compose up -d
```

4) Configure Auth0 and oauth2-proxy

- Copy `templates/auth.env.example` and set real values (do not commit secrets).
- Inject those values into the `auth` service in `docker-compose.yml` via environment or env_file.

5) Configure Stripe for provisioning

- Copy `templates/billing.env.example`, set Stripe keys, price ID, and success/cancel URLs.
- Set these as environment on the provisioner service (see `docker-compose.yml`).

6) Create a tenant

- Either via Stripe checkout flowing through the provisioner webhook, or manually:

```
./scripts/add-tenant.sh tenant-aaa
# Then provision the tenant stack on the VM/repo host:
TENANT_ENV_FILE=/var/lib/anyapp-saas/tenants/tenant-aaa/.env \
  docker compose -f templates/docker-compose.tenant.yml \
  --env-file /var/lib/anyapp-saas/tenants/tenant-aaa/.env \
  -p tenant_tenant-aaa up -d
```

7) Point DNS

- Create an A/AAAA record for `t-tenant-aaa.<BASE_DOMAIN_ROOT>` → your VM IP.

Optional: use a local env file

You can set local overrides for Compose variable expansion without committing secrets:

```bash
cp .env.local.example .env.local
# Edit .env.local and adjust as needed, for example:
# TENANT_ROOT_DOMAIN=example.com
# TENANT_PREFIX=t-
# PROVISIONER_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173,https://www.example.com

make network && make acme && make up
```

## Validate with the Hello App

You can quickly validate the stack using the example app under `examples/helloapp/`:

1) Build the image locally (replace OWNER with your registry namespace if pushing):

```bash
cd examples/helloapp
IMAGE=ghcr.io/OWNER/helloapp:latest
docker build -t $IMAGE .
# docker push $IMAGE   # optional if pulling from a registry on a different host
```

2) Create a tenant and set the app image:

```bash
./scripts/add-tenant.sh tenant-aaa
sed -i.bak "s|^APP_IMAGE=.*$|APP_IMAGE=${IMAGE%:*}|" /var/lib/anyapp-saas/tenants/tenant-aaa/.env && rm -f /var/lib/anyapp-saas/tenants/tenant-aaa/.env.bak
```

3) Start the tenant stack:

```bash
TENANT_ENV_FILE=/var/lib/anyapp-saas/tenants/tenant-aaa/.env \
  docker compose -f templates/docker-compose.tenant.yml \
  --env-file /var/lib/anyapp-saas/tenants/tenant-aaa/.env \
  -p tenant_tenant-aaa up -d
```

Then visit: `https://t-tenant-aaa.<BASE_DOMAIN_ROOT>`

The Hello App exposes `/health` and `/metrics` as required by the adapter.

## Full Documentation

- Getting Started: `docs/GETTING_STARTED.md`
- App Adapter Guide: `docs/APP_ADAPTER.md`
- Operations: `docs/OPERATIONS.md`
- Configuration reference: `docs/CONFIGURATION.md`

## App Adapter Contract

Your application must:

- Provide a container image (`APP_IMAGE`) with a listening port (`APP_PORT`).
- Expose an HTTP health endpoint at `/health` returning 200 OK.
- Optionally expose Prometheus metrics at `/metrics`.
- Be reverse-proxy aware (do not hardcode base URLs; honor X-Forwarded-*).
- Persist tenant data under `/data` (host-mount `${APP_DATA_HOST}` → `/data`).
- Accept config via env: `TENANT`, `TENANT_NAME`, `BASE_DOMAIN_ROOT`, `TENANT_PREFIX`, optional `SF_LOGOUT_REDIRECT_URL`, and app-specific env.

## Directory Layout

- `docker-compose.yml`: Traefik + oauth2-proxy + provisioner
- `traefik/`: static and dynamic config, ACME storage
- `services/provisioner/`: Node/Express service for billing + access checks
- `templates/`: per-tenant compose and env templates, access.yml schema
- `scripts/`: lifecycle helpers (add/provision/redeploy/etc.)
- `/var/lib/anyapp-saas/tenants/<tenant>/`: runtime per-tenant state (on VM)

## Security Notes

- Do not commit real secrets. Use env files managed by your secrets tool.
- Ensure `traefik/acme.json` has 0600 permissions.
- Restrict CORS origins for the provisioner via environment in production.

## License

MIT
