import express from 'express';
import Stripe from 'stripe';
import { execFile } from 'child_process';
import { promisify } from 'util';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import crypto from 'crypto';
import { register, collectDefaultMetrics, Counter, Histogram } from 'prom-client';

const execFileAsync = promisify(execFile);

const app = express();
const port = process.env.PORT || 8080;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const tenantRootDomain = process.env.TENANT_ROOT_DOMAIN || 'example.com';
const tenantPrefix = process.env.TENANT_PREFIX || 't-';
const repoPath = process.env.REPO_PATH || '/opt/repo';
const runtimeTenantsPath = process.env.RUNTIME_TENANTS_PATH || '/var/lib/anyapp-saas/tenants';
const stripePriceId = process.env.STRIPE_PRICE_ID || '';
const checkoutSuccessUrl = process.env.CHECKOUT_SUCCESS_URL || '';
const checkoutCancelUrl = process.env.CHECKOUT_CANCEL_URL || '';
// Configurable max slug length: ensure full label `${tenantPrefix}<slug>` <= 63
const MAX_DNS_LABEL = 63;
const computedCap = Math.max(1, MAX_DNS_LABEL - String(tenantPrefix).length);
const envRequested = Number(process.env.TENANT_SLUG_MAX_LEN || computedCap);
const maxSlugLen = Math.max(1, Math.min(computedCap, envRequested));

if (!stripeSecretKey || !webhookSecret) {
  console.warn('Provisioner: STRIPE keys not fully configured. Billing endpoints will error.');
}

const stripe = new Stripe(stripeSecretKey || '', { apiVersion: '2024-06-20' });
const authDebug = process.env.AUTH_DEBUG === '1';

// Security headers - must be registered before routes
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});
// Minimal CORS to allow browser calls from allowed origins
app.use((req, res, next) => {
  const origin = String(req.headers.origin || '');
  // Allow override via env (comma-separated list). Example:
  // PROVISIONER_ALLOWED_ORIGINS="https://www.example.com,https://billing.example.com"
  const envOrigins = String(process.env.PROVISIONER_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const defaultOrigins = [
    'https://www.example.com',
    'https://example.com',
    'https://billing.example.com',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:8080',
  ];
  const allowedOrigins = new Set(envOrigins.length > 0 ? envOrigins : defaultOrigins);
  res.setHeader('Vary', 'Origin');
  if (allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Stripe-Signature');
  }
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});
// JSON body parser for non-webhook endpoints (skip Stripe webhook which needs raw body)
app.use((req, res, next) => {
  if (req.originalUrl === '/webhooks/stripe') return next();
  return bodyParser.json()(req, res, next);
});

// -----------------------------
// Prometheus metrics
// -----------------------------
// Default labels for all metrics
try {
  register.setDefaultLabels({ env: process.env.METRICS_ENV || 'prod', service: 'provisioner' });
} catch (e) {
  // ignore
}
// Process and Node.js metrics
collectDefaultMetrics({ register });

// Request metrics
const HTTP_REQUESTS_TOTAL = new Counter({
  name: 'provisioner_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status'],
});

const HTTP_REQUEST_DURATION_SECONDS = new Histogram({
  name: 'provisioner_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path', 'status'],
  buckets: [0.05, 0.1, 0.3, 1, 3, 10],
});

// Metrics middleware
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    try {
      const durNs = Number(process.hrtime.bigint() - start);
      const durSec = durNs / 1e9;
      const pathLabel = String(req.path || '/');
      const method = String(req.method || 'GET');
      const status = String(res.statusCode || 0);
      HTTP_REQUESTS_TOTAL.labels(method, pathLabel, status).inc();
      HTTP_REQUEST_DURATION_SECONDS.labels(method, pathLabel, status).observe(durSec);
    } catch (e) {
      // ignore metrics errors
    }
  });
  next();
});

// Expose metrics endpoint
app.get('/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (e) {
    res.status(500).send('metrics error');
  }
});

// -----------------------------
// Helpers for ACL reads
// -----------------------------

function readAccessYaml(tenant) {
  const safe = String(tenant).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, maxSlugLen);
  if (!safe) return null;
  const filePath = path.join(runtimeTenantsPath, safe, 'access.yml');
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, 'utf8');
  const doc = yaml.load(text) || {};
  const owners = Array.isArray(doc.owners) ? doc.owners.map(String) : [];
  const members = Array.isArray(doc.members) ? doc.members.map(String) : [];
  const roles = doc.roles && typeof doc.roles === 'object' ? doc.roles : {};
  return { tenant: safe, owners, members, roles };
}

function resolveTenantsForEmail(email) {
  const tenantsDir = runtimeTenantsPath;
  if (!fs.existsSync(tenantsDir)) return [];
  const entries = fs.readdirSync(tenantsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  const results = [];
  for (const d of entries) {
    const t = d.name;
    const acl = readAccessYaml(t);
    if (!acl) continue;
    const owners = acl.owners.map((e) => e.toLowerCase());
    const members = acl.members.map((e) => e.toLowerCase());
    const roles = acl.roles || {};
    const all = new Set([...owners, ...members, ...Object.keys(roles).map((e) => e.toLowerCase())]);
    if (all.has(email)) {
      const role = typeof roles[email] === 'string' ? roles[email] : owners.includes(email) ? 'owner' : members.includes(email) ? 'member' : 'member';
      results.push({ tenant: acl.tenant, role });
    }
  }
  return results;
}

// -----------------------------
// Slug helpers (format + availability)
// -----------------------------

function sanitizeSlug(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, maxSlugLen);
}

function slugExists(slug) {
  const dir = path.join(runtimeTenantsPath, slug);
  return fs.existsSync(dir);
}

async function slugInStripe(slug) {
  try {
    // Best-effort search to avoid duplicates tied to billing
    const q = `metadata['tenant']:'${slug}' OR metadata['tenant_slug']:'${slug}'`;
    const res = await stripe.customers.search({ query: q, limit: 1 });
    return (res?.data?.length || 0) > 0;
  } catch (_e) {
    return false;
  }
}

function generateUuidSlug() {
  const raw = (crypto.randomUUID ? crypto.randomUUID() : (
    (() => {
      const b = crypto.randomBytes(16);
      // Set version 4
      b[6] = (b[6] & 0x0f) | 0x40;
      // Set variant 10
      b[8] = (b[8] & 0x3f) | 0x80;
      const hex = b.toString('hex');
      return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    })()
  ));
  return sanitizeSlug(raw);
}

async function suggestFromBase(base) {
  let s = sanitizeSlug(base);
  if (!s) s = generateUuidSlug();
  // If available, return immediately
  if (!slugExists(s) && !(await slugInStripe(s))) return s;
  // Try numeric suffixes
  for (let i = 1; i <= 99; i++) {
    const candidate = sanitizeSlug(`${s}-${i}`);
    if (!candidate) continue;
    if (!slugExists(candidate) && !(await slugInStripe(candidate))) return candidate;
  }
  // Fallback to uuid
  return generateUuidSlug();
}

// -----------------------------
// Auth endpoints (minimal + secure)
// -----------------------------

function getEmailFromHeaders(req) {
  const raw =
    req.headers['x-auth-request-email'] ||
    req.headers['x-auth-request-preferred-username'] ||
    '';
  const email = String(raw).trim().toLowerCase();
  // Basic allowlist validation to avoid header spoofing noise
  const emailOk = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email);
  return emailOk ? email : '';
}

// Expose /auth/me only when AUTH_DEBUG=1
if (authDebug) {
  app.get('/auth/me', (req, res) => {
    const email = getEmailFromHeaders(req);
    if (!email) return res.status(401).json({ error: 'unauthorized' });
    return res.json({ email });
  });
}

async function handleAuthComplete(req, res) {
  try {
    const email = getEmailFromHeaders(req);
    // No caching on auth completion responses
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    if (!email) return res.status(401).send('unauthorized');

    // Resolve tenants for this email by scanning YAML directly
    const results = resolveTenantsForEmail(email);

    if (results.length === 0) {
      return res.status(403).send('No tenant access. Please request access.');
    }

    // Debug mode: return tenants JSON instead of redirect (only when AUTH_DEBUG=1)
    if (authDebug && String(req.query.debug || '') === '1') {
      return res.json({ email, tenants: results, baseDomain: tenantRootDomain, tenantPrefix });
    }

    let targetTenant = results[0].tenant;
    if (req.query.tenant) {
      const requested = String(req.query.tenant).toLowerCase();
      if (results.find((t) => t.tenant === requested)) targetTenant = requested;
    }

    const dest = `https://${tenantPrefix}${targetTenant}.${tenantRootDomain}`;
    return res.redirect(302, dest);
  } catch (e) {
    console.error('auth/complete error', e);
    return res.status(500).send('internal error');
  }
}

app.get('/auth/complete', handleAuthComplete);

// -----------------------------
// Consolidated tenant access forwardAuth check
// -----------------------------

function getTenantFromHost(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers['host'] || '').toLowerCase();
  const suffix = `.${tenantRootDomain}`;
  if (!host.endsWith(suffix)) return '';
  const sub = host.slice(0, -suffix.length); // e.g., t-tenant
  if (!sub.startsWith(tenantPrefix)) return '';
  const tenant = sub.slice(tenantPrefix.length);
  return tenant.replace(/[^a-z0-9-]/g, '').slice(0, maxSlugLen);
}

app.get('/access/check', async (req, res) => {
  try {
    const email = getEmailFromHeaders(req);
    if (!email) return res.status(401).send('unauthorized');
    const tenant = getTenantFromHost(req);
    if (!tenant) return res.status(400).send('invalid tenant host');

    const acl = readAccessYaml(tenant);
    if (!acl) return res.status(404).send('access not found');
    const owners = acl.owners.map((e) => e.toLowerCase());
    const members = acl.members.map((e) => e.toLowerCase());
    const roles = acl.roles || {};
    const all = new Set([...owners, ...members, ...Object.keys(roles).map((e) => e.toLowerCase())]);
    if (!all.has(email)) return res.status(403).send('forbidden');
    return res.status(200).send('ok');
  } catch (e) {
    console.error('access/check error', e);
    return res.status(500).send('internal error');
  }
});

// -----------------------------
// Suggest a tenant slug
// -----------------------------

app.get('/tenants/suggest', async (req, res) => {
  try {
    const base = String(req.query.base || '');
    const suggestion = await suggestFromBase(base);
    return res.json({ ok: true, slug: suggestion });
  } catch (e) {
    console.error('tenants/suggest error', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

// -----------------------------
// Tenant slug validation
// -----------------------------

app.get('/tenants/validate', async (req, res) => {
  try {
    const requested = sanitizeSlug(req.query.slug || '');
    if (!requested) return res.status(400).json({ ok: false, error: 'invalid_slug' });
    if (/^-|-$/.test(requested)) return res.status(400).json({ ok: false, error: 'invalid_slug_edge_dash' });
    if (/--/.test(requested)) return res.status(400).json({ ok: false, error: 'invalid_slug_double_dash' });

    const existsLocally = slugExists(requested);
    const existsInStripe = await slugInStripe(requested);
    const available = !existsLocally && !existsInStripe;
    return res.json({ ok: true, slug: requested, available, existsLocally, existsInStripe, maxLen: maxSlugLen, charset: 'a-z0-9-'});
  } catch (e) {
    console.error('tenants/validate error', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

// -----------------------------
// Create Stripe Checkout Session with tenant metadata
// -----------------------------

async function billingSessionHandler(req, res) {
  try {
    if (!stripeSecretKey) return res.status(500).json({ error: 'stripe_not_configured' });
    if (!stripePriceId) return res.status(500).json({ error: 'missing_STRIPE_PRICE_ID' });
    if (!checkoutSuccessUrl || !checkoutCancelUrl) return res.status(500).json({ error: 'missing_checkout_urls' });

    const { slug, email } = req.body || {};
    let sanitized = sanitizeSlug(slug);
    if (!sanitized) {
      sanitized = generateUuidSlug();
    }
    if (!sanitized) return res.status(400).json({ error: 'invalid_slug' });
    if (/^-|-$/.test(sanitized) || /--/.test(sanitized)) return res.status(400).json({ error: 'invalid_slug_format' });

    // Check availability to reduce failures post-payment
    if (slugExists(sanitized)) return res.status(409).json({ error: 'slug_taken' });
    if (await slugInStripe(sanitized)) return res.status(409).json({ error: 'slug_taken_billing' });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: stripePriceId, quantity: 1 }],
      success_url: checkoutSuccessUrl,
      cancel_url: checkoutCancelUrl,
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
      // Collect a human-friendly tenant name
      custom_fields: [
        {
          key: 'tenant_name',
          label: { type: 'custom', custom: 'Project name' },
          type: 'text',
          text: {
            maximum_length: 64,
          },
        },
      ],
      metadata: { tenant: sanitized, tenant_slug: sanitized, email: String(email || '') },
      customer_email: email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : undefined,
    });

    return res.json({ url: session.url, id: session.id, slug: sanitized });
  } catch (e) {
    console.error('billing/session error', e);
    return res.status(500).json({ error: 'internal' });
  }
}

// Mount at both root and /auth to work with router forwarding
app.post('/billing/session', billingSessionHandler);
app.post('/auth/billing/session', billingSessionHandler);

// Stripe requires raw body for signature verification
app.post('/webhooks/stripe', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  const sig = req.headers['stripe-signature'];
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed' || event.type === 'customer.subscription.created') {
      const data = event.data.object;
      // Resolve tenant slug and user email from metadata
      const metadata = data.metadata || {};
      let tenant = metadata.tenant || metadata.tenant_slug;
      let email = data.customer_details?.email || metadata.email;
      let tenantName = '';

      // Extract custom field from checkout session when available
      try {
        const customFields = Array.isArray(data.custom_fields) ? data.custom_fields : [];
        const nameField = customFields.find((f) => f.key === 'tenant_name' && f.type === 'text');
        const val = nameField?.text?.value;
        if (typeof val === 'string' && val.trim()) tenantName = val.trim();
      } catch (_e) {
        // ignore
      }

      // If missing tenant, try retrieving from customer metadata
      if (!tenant && data.customer) {
        const cust = await stripe.customers.retrieve(data.customer);
        if (!cust.deleted) {
          tenant = cust.metadata?.tenant || cust.metadata?.tenant_slug || tenant;
          email = email || cust.email;
        }
      }

      if (!tenant) {
        console.error('No tenant provided in metadata; cannot provision.');
        return res.status(200).send('No tenant metadata; skipped');
      }

      // Sanitize + validate tenant slug (must match validate/session rules)
      tenant = String(tenant).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, maxSlugLen);
      if (!tenant || /^-|-$/.test(tenant) || /--/.test(tenant)) {
        console.error(`Invalid tenant slug in metadata; skipped. tenant='${tenant}'`);
        return res.status(200).send('Invalid tenant slug; skipped');
      }

      // If already provisioned, skip to ensure idempotency
      if (slugExists(tenant)) {
        console.log(`Tenant '${tenant}' already exists; skipping provisioning.`);
        return res.status(200).send('Tenant already provisioned; skipped');
      }

      console.log(`Provisioning tenant: ${tenant} for ${email || 'unknown email'}`);
      const script = `${repoPath}/scripts/provision-tenant.sh`;
      // Pass email to script so it can seed access.yml owners/roles
      const args = [tenant, tenantRootDomain, tenantName, String(email || '')];

      const { stdout, stderr } = await execFileAsync(script, args, { env: process.env });
      if (stdout) console.log(stdout);
      if (stderr) console.error(stderr);

      return res.status(200).send('Provisioning triggered');
    }

    // Other events are acknowledged
    return res.status(200).send('ok');
  } catch (e) {
    console.error('Error handling event', e);
    return res.status(500).send('internal error');
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(port, () => console.log(`Provisioner listening on :${port}`));
