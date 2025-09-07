# Operations

This page covers day-2 operations: creating tenants, redeployments, suspensions, deletion, DNS, and monitoring.

---

## Tenant lifecycle

All tenant runtime state lives under `/var/lib/anyapp-saas/tenants/<tenant>/` on the VM.

- `.env` — per-tenant environment for the Compose template
- `access.yml` — YAML ACL (owners/members/roles)
- `data/` — app’s persistent data mounted as `/data` inside the container

### Create

```bash
./scripts/add-tenant.sh tenant-aaa
```

Then bring up the tenant app:

```bash
TENANT_ENV_FILE=/var/lib/anyapp-saas/tenants/tenant-aaa/.env \
  docker compose -f templates/docker-compose.tenant.yml \
  --env-file /var/lib/anyapp-saas/tenants/tenant-aaa/.env \
  -p tenant_tenant-aaa up -d
```

Or rely on Stripe checkout + webhook which calls `scripts/provision-tenant.sh` automatically.

### Redeploy

Pull latest images and restart:

```bash
./scripts/redeploy-tenant.sh tenant-aaa
```

### Suspend

Stop containers (data retained):

```bash
./scripts/suspend-tenant.sh tenant-aaa
```

### Delete

Bring down stack and optionally delete data:

```bash
./scripts/delete-tenant.sh tenant-aaa --delete-data
```

---

## DNS

- Core: point `www.example.com` → VM IP (for oauth2 callback and Stripe webhook routes)
- Tenants: `t-<slug>.example.com` → VM IP

Cloudflare recommended (proxied ON). Ensure TLS is valid for both `www` and tenant subdomains.

---

## Logs & Metrics

- Traefik
  - Logs: `docker logs <traefik-container>`
  - Metrics (Prometheus): `:9100/metrics` entrypoint exposed internally
- oauth2-proxy
  - Logs: `docker logs <auth-container>`
- Provisioner
  - Health: `GET /health`
  - Metrics: `GET /metrics`
  - Logs: `docker logs <provisioner-container>`
- App containers
  - Health: `GET https://t-<slug>.example.com/health`
  - Metrics: `GET https://t-<slug>.example.com/metrics`

---

## Access control

- Edit `/var/lib/anyapp-saas/tenants/<tenant>/access.yml`
- Validate all tenant ACLs:

```bash
node ./scripts/validate-access.js
```

- ForwardAuth checks rely on oauth2-proxy headers (`X-Auth-Request-Email` or `X-Auth-Request-Preferred-Username`).

---

## Backups

- Snapshot `/var/lib/anyapp-saas/tenants/*/data/` regularly (e.g., rsync + restic)
- Optional: back up the repo itself for config-as-code

---

## Upgrades

- Update Traefik or oauth2-proxy images in `docker-compose.yml`, then:

```bash
docker compose pull && docker compose up -d
```

- Update tenant app images (globally):

```bash
# per tenant
./scripts/redeploy-tenant.sh tenant-aaa
```

- Or update tags in tenant `.env` files (`APP_TAG`) and redeploy.
