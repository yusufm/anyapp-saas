#!/usr/bin/env node
/**
 * Validate access.yml files under runtime tenants directory for schema and consistency.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const runtimeTenantsDir = process.env.RUNTIME_TENANTS_PATH || '/var/lib/anyapp-saas/tenants';

function isValidEmail(email) {
  return typeof email === 'string' && /.+@.+\..+/.test(email);
}

function isValidDomain(domain) {
  return typeof domain === 'string' && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain);
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function fail(msg) {
  console.error(`validate-access: ${msg}`);
  process.exitCode = 1;
}

function loadYaml(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    return yaml.load(txt) || {};
  } catch (e) {
    fail(`YAML parse error in ${file}: ${e.message}`);
    return {};
  }
}

function validateTenant(tenantSlug, filePath) {
  const doc = loadYaml(filePath);

  // version
  if (doc.version !== 1) {
    fail(`${filePath}: version must be 1`);
  }

  // tenant slug match
  const slug = String(doc.tenant || '').toLowerCase();
  if (!slug) fail(`${filePath}: tenant is required`);
  if (slug !== tenantSlug) fail(`${filePath}: tenant slug '${slug}' must match directory '${tenantSlug}'`);
  if (!/^[a-z0-9-]{1,32}$/.test(slug)) fail(`${filePath}: tenant slug must match ^[a-z0-9-]{1,32}$`);

  // arrays
  const owners = Array.isArray(doc.owners) ? doc.owners : [];
  const members = Array.isArray(doc.members) ? doc.members : [];
  const domains = Array.isArray(doc.domains) ? doc.domains : [];
  const roles = doc.roles && typeof doc.roles === 'object' ? doc.roles : {};

  // email checks
  const allEmails = [...owners, ...members, ...Object.keys(roles)];
  for (const e of allEmails) {
    if (!isValidEmail(e)) fail(`${filePath}: invalid email '${e}'`);
  }

  // duplicates
  if (owners.length !== uniq(owners).length) fail(`${filePath}: duplicate emails in owners`);
  if (members.length !== uniq(members).length) fail(`${filePath}: duplicate emails in members`);

  // roles values must be strings
  for (const [email, role] of Object.entries(roles)) {
    if (typeof role !== 'string' || role.length === 0) fail(`${filePath}: role for ${email} must be a non-empty string`);
  }

  // domains valid
  for (const d of domains) {
    if (!isValidDomain(d)) fail(`${filePath}: invalid domain '${d}'`);
  }

  // optional: warn if owner not in owners list but has role owner
  for (const [email, role] of Object.entries(roles)) {
    if (role === 'owner' && !owners.includes(email)) {
      console.warn(`${filePath}: note: ${email} has role 'owner' but is not listed in owners[]`);
    }
  }
}

function main() {
  if (!fs.existsSync(runtimeTenantsDir)) {
    console.log('Runtime tenants directory not found; skipping');
    return;
  }
  const baseDir = runtimeTenantsDir;
  console.log(`validate-access: using runtime tenants dir: ${baseDir}`);

  const tenants = fs
    .readdirSync(baseDir)
    .filter((d) => fs.statSync(path.join(baseDir, d)).isDirectory());

  let checked = 0;
  for (const t of tenants) {
    const file = path.join(baseDir, t, 'access.yml');
    if (fs.existsSync(file)) {
      validateTenant(t, file);
      checked += 1;
    }
  }
  console.log(`validate-access: checked ${checked} tenant access files`);
}

main();
