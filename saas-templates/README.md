# SaaS Templates

Place shared partial templates or static files here that your app containers can read at runtime. These are mounted read-only into each tenant container at:

- Host: ${SAAS_TEMPLATES_HOST_PATH:-/opt/anyapp-saas/saas-templates}
- Container: /var/lib/anyapp-saas/templates

Use cases:

- Branding/white-label partials (HTML fragments, CSS)
- Legal pages (terms/privacy) to be embedded by the app
- Common config snippets

If you run locally and want to mount this repo’s directory, set in the tenant env:

```
SAAS_TEMPLATES_HOST_PATH=/Users/you/src/anyapp-saas/saas-templates
```
