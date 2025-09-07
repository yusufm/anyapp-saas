# anyapp-saas Makefile

SHELL := /bin/bash
TENANT ?=
TENANT_ENV ?=/var/lib/anyapp-saas/tenants/$(TENANT)/.env
COMPOSE_TENANT := templates/docker-compose.tenant.yml
PROJECT := tenant_$(TENANT)

.DEFAULT_GOAL := help

.PHONY: help
help:
	@echo "anyapp-saas make targets:"
	@echo "  make network            - create external 'proxy' Docker network (idempotent)"
	@echo "  make acme               - create traefik/acme.json with 0600 perms"
	@echo "  make up                 - start core stack (traefik, auth, provisioner)"
	@echo "  make down               - stop core stack"
	@echo "  make restart            - restart core stack"
	@echo "  make tenant TENANT=slug - create tenant runtime files (env + access.yml)"
	@echo "  make tenant-up TENANT=slug - start tenant stack using shared template"
	@echo "  make tenant-redeploy TENANT=slug [SERVICES=...] - pull+restart tenant services"
	@echo "  make tenant-suspend TENANT=slug - stop tenant containers (retain data)"
	@echo "  make tenant-delete TENANT=slug [DELETE_DATA=1] - bring down stack; optionally delete data"
	@echo "  make validate-access    - validate all runtime tenant access.yml files"

.PHONY: network
network:
	docker network create proxy || true

.PHONY: acme
acme:
	mkdir -p traefik
	: > traefik/acme.json
	chmod 600 traefik/acme.json

.PHONY: up
up:
	docker compose up -d

.PHONY: down
down:
	docker compose down

.PHONY: restart
restart: down up

.PHONY: tenant
tenant:
	@if [ -z "$(TENANT)" ]; then echo "Usage: make tenant TENANT=tenant-aaa"; exit 1; fi
	./scripts/add-tenant.sh $(TENANT)

.PHONY: tenant-up
tenant-up:
	@if [ -z "$(TENANT)" ]; then echo "Usage: make tenant-up TENANT=tenant-aaa"; exit 1; fi
	TENANT_ENV_FILE=$(TENANT_ENV) \
	docker compose -f $(COMPOSE_TENANT) --env-file $(TENANT_ENV) -p $(PROJECT) up -d

.PHONY: tenant-redeploy
tenant-redeploy:
	@if [ -z "$(TENANT)" ]; then echo "Usage: make tenant-redeploy TENANT=tenant-aaa [SERVICES=web api]"; exit 1; fi
	./scripts/redeploy-tenant.sh $(TENANT) $(SERVICES)

.PHONY: tenant-suspend
tenant-suspend:
	@if [ -z "$(TENANT)" ]; then echo "Usage: make tenant-suspend TENANT=tenant-aaa"; exit 1; fi
	./scripts/suspend-tenant.sh $(TENANT)

.PHONY: tenant-delete
tenant-delete:
	@if [ -z "$(TENANT)" ]; then echo "Usage: make tenant-delete TENANT=tenant-aaa [DELETE_DATA=1]"; exit 1; fi
	@if [ "$(DELETE_DATA)" = "1" ]; then \
		./scripts/delete-tenant.sh $(TENANT) --delete-data; \
	else \
		./scripts/delete-tenant.sh $(TENANT); \
	fi

.PHONY: validate-access
validate-access:
	node ./scripts/validate-access.js
