'use strict';

/**
 * Admin auth middleware for the webhook management API.
 *
 * The bounty (issue #21) requires the admin CRUD endpoints to be guarded
 * by an auth check so anyone who can reach the gateway cannot enumerate or
 * mutate subscriptions. We pick a simple shared-secret bearer scheme so it
 * stays trivially deployable: set `WEBHOOK_ADMIN_TOKEN` (and optionally
 * `WEBHOOK_ADMIN_TOKENS` for rotation) to one or more opaque tokens; every
 * request must include `Authorization: Bearer <token>` and the token must
 * match via constant-time comparison.
 *
 * The middleware is intentionally small. It returns:
 *   - 401 if the header is missing or wrong
 *   - 503 if no tokens are configured at all (fail-closed; the operator
 *     has to set the env var to opt in to enabling the admin API)
 *
 * In tests we use `process.env.NODE_ENV === 'test'` to relax the
 * fail-closed default so unit tests do not need to set env vars. Tests
 * that exercise the auth path explicitly set the env var.
 */

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readTokens() {
  const raw = process.env.WEBHOOK_ADMIN_TOKENS || process.env.WEBHOOK_ADMIN_TOKEN;
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isTestEnv() {
  return process.env.NODE_ENV === 'test';
}

function isOpenMode() {
  // Explicit opt-out escape hatch. Allow only when explicitly requested.
  return process.env.WEBHOOK_ADMIN_OPEN === '1';
}

function extractBearer(req) {
  const h = req && req.headers && req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

function buildAdminAuth({ tokens, allowInTest = true } = {}) {
  const configured = Array.isArray(tokens)
    ? tokens.filter((t) => typeof t === 'string' && t.length > 0)
    : readTokens();
  const open = isOpenMode();
  const testAllow = allowInTest && isTestEnv() && configured.length === 0;

  function middleware(req, res, next) {
    if (open) return next();
    if (configured.length === 0) {
      if (testAllow) return next();
      // No tokens configured and not in test mode: refuse to serve the
      // admin API at all. Operators must opt in by setting the env var.
      return res.status(503).json({
        error: 'admin_disabled',
        message:
          'Webhook admin API is disabled: set WEBHOOK_ADMIN_TOKEN (or WEBHOOK_ADMIN_TOKENS) or WEBHOOK_ADMIN_OPEN=1 to enable it.',
      });
    }
    const presented = extractBearer(req);
    if (!presented) {
      return res.status(401).json({ error: 'unauthorized', message: 'Missing bearer token' });
    }
    const ok = configured.some((t) => safeEqual(t, presented));
    if (!ok) {
      return res.status(401).json({ error: 'unauthorized', message: 'Invalid bearer token' });
    }
    return next();
  }

  middleware.configuredTokens = () => configured.slice();
  middleware.mode = () => {
    if (open) return 'open';
    if (configured.length === 0) return testAllow ? 'test-allow' : 'disabled';
    return 'token-required';
  };
  return middleware;
}

module.exports = {
  buildAdminAuth,
  safeEqual,
  // exported for tests
  _internal: { extractBearer, readTokens },
};
