import express from 'express';
import { register, collectDefaultMetrics } from 'prom-client';

const app = express();
const port = Number(process.env.APP_PORT || 8080);

collectDefaultMetrics({ register });

app.get('/health', (_req, res) => res.status(200).send('ok'));

app.get('/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (e) {
    res.status(500).send('metrics error');
  }
});

app.get('/', (req, res) => {
  const tenant = process.env.TENANT || 'unknown-tenant';
  const tname = process.env.TENANT_NAME || '';
  const base = process.env.BASE_DOMAIN_ROOT || 'example.com';
  const prefix = process.env.TENANT_PREFIX || 't-';
  const logout = process.env.SF_LOGOUT_REDIRECT_URL || '';
  const host = req.headers['host'] || '';
  res.type('html').send(`
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Hello App</title>
        <style>
          body { font-family: system-ui, sans-serif; padding: 2rem; line-height: 1.6; }
          code { background: #f3f4f6; padding: 0.2rem 0.4rem; border-radius: 4px; }
          .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
        </style>
      </head>
      <body>
        <h1>helloapp</h1>
        <p>This is a minimal example app running behind anyapp-saas.</p>
        <ul>
          <li>Host: <code class="mono">${host}</code></li>
          <li>Tenant: <code class="mono">${tenant}</code>${tname ? ` (${tname})` : ''}</li>
          <li>Domain model: <code class="mono">${prefix}${tenant}.${base}</code></li>
        </ul>
        <p>Health: <a href="/health">/health</a> | Metrics: <a href="/metrics">/metrics</a></p>
        ${logout ? `<p>Logout redirect configured.</p>` : ''}
      </body>
    </html>
  `);
});

app.listen(port, () => console.log(`helloapp listening on :${port}`));
