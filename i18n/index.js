// Multi-language (i18n) support for API messages — issue #7.
// Detects language via: Accept-Language header -> user profile language -> "en" fallback.
// Express middleware attaches req.locale (resolved code) and req.t() (bound translator).
// A standalone translate() is also exported for use outside of request scope.
'use strict';

const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, 'locales');
const DEFAULT_LOCALE = 'en';

// Supported language codes plus optional ones, so the resolver can compute
// the fallback chain deterministically.
const SUPPORTED = ['en', 'zh', 'ms', 'ta'];
const OPTIONAL = ['it'];

function loadLocale(code) {
  try {
    return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, code + '.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

const LOCALES = {};
for (const c of SUPPORTED.concat(OPTIONAL)) {
  const data = loadLocale(c);
  if (data) LOCALES[c] = data;
}
const CODES = Object.keys(LOCALES);

// Map a raw language tag (e.g. "zh-CN", "zh-Hans;q=0.9,en;q=0.8") to the best
// supported code, normalizing to the primary subtag, case-insensitively.
function resolveTag(tag) {
  if (!tag || typeof tag !== 'string') return DEFAULT_LOCALE;
  const parts = tag.split(',').map((s) => s.trim().split(';')[0].toLowerCase());
  for (const p of parts) {
    const base = p.split('-')[0];
    if (CODES.includes(base)) return base;
  }
  return DEFAULT_LOCALE;
}

// Parse an Accept-Language header into an ordered list of candidate tags.
function parseAcceptLanguage(header) {
  if (!header) return [];
  return header
    .split(',')
    .map((part) => {
      const seg = part.trim();
      const qIdx = seg.indexOf(';q=');
      let q = 1;
      let tag = seg;
      if (qIdx !== -1) {
        tag = seg.slice(0, qIdx).trim();
        const qv = parseFloat(seg.slice(qIdx + 3));
        if (!Number.isNaN(qv)) q = qv;
      }
      return { tag, q };
    })
    .filter((c) => c.tag)
    .sort((a, b) => b.q - a.q)
    .map((c) => c.tag);
}

// Resolve the best locale for a request:
// 1) explicit user profile language (if route populated req.user.locale)
// 2) Accept-Language header (in priority order)
// 3) "en" fallback.
function resolveLocale(req) {
  if (req && req.user && req.user.locale && CODES.includes(String(req.user.locale).toLowerCase())) {
    return String(req.user.locale).toLowerCase();
  }
  const header = req && req.headers && req.headers['accept-language'];
  for (const tag of parseAcceptLanguage(header)) {
    const resolved = resolveTag(tag);
    if (resolved !== DEFAULT_LOCALE) return resolved;
  }
  return DEFAULT_LOCALE;
}

function interpolate(message, params) {
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : m
  );
}

// Look up a dotted key path (e.g. "errors.dbConnection") in a locale map, with
// fallback to the default locale, then to the raw key.
function lookup(code, key) {
  const data = LOCALES[code] || LOCALES[DEFAULT_LOCALE];
  const fallback = LOCALES[DEFAULT_LOCALE];
  const segments = String(key).split('.');
  let node = data;
  for (const seg of segments) {
    if (node && Object.prototype.hasOwnProperty.call(node, seg)) node = node[seg];
    else { node = null; break; }
  }
  if (node == null) {
    let fb = fallback;
    for (const seg of segments) {
      if (fb && Object.prototype.hasOwnProperty.call(fb, seg)) fb = fb[seg];
      else { fb = null; break; }
    }
    return fb != null ? fb : key;
  }
  return node;
}

function translate(key, locale, params) {
  const code = (locale && CODES.includes(String(locale).toLowerCase())) ? String(locale).toLowerCase() : DEFAULT_LOCALE;
  return interpolate(String(lookup(code, key)), params);
}

function i18nMiddleware(req, _res, next) {
  req.locale = resolveLocale(req);
  req.t = (key, params) => translate(key, req.locale, params);
  next();
}

module.exports = {
  translate, resolveLocale, resolveTag, parseAcceptLanguage, i18nMiddleware,
  SUPPORTED: SUPPORTED.slice(), OPTIONAL: OPTIONAL.slice(),
  LOCALES, DEFAULT_LOCALE,
};
