'use strict';

/**
 * Internationalization (i18n) module for the MyZubster Gateway API.
 *
 * Closes issue #22 — implements locale-aware error and response
 * messages for the four required languages (English, Chinese
 * Simplified, Malay, Tamil) plus Italian as the optional fifth.
 *
 * Locale resolution order (highest priority first):
 *   1. `req.user.locale` if a route attaches one (logged-in profile)
 *   2. `Accept-Language` HTTP header, parsed with q-value ordering
 *   3. `defaultLocale` (English)
 *
 * Public surface:
 *   - DEFAULT_LOCALE, SUPPORTED_LOCALES
 *   - parseAcceptLanguage(header) -> [{tag, q}] ordered by preference
 *   - resolveTag(tag) -> supported primary subtag or null
 *   - resolveLocale({ headerLocale, userLocale })
 *   - interpolate(template, params)
 *   - translate(locales, key, params, locale)
 *   - loadLocales(dir) -> {locale: {key: value}} (synchronous)
 *   - createMiddleware(opts) -> express middleware
 *
 * Behaviour:
 *   - Missing keys never throw; the raw key with interpolation
 *     applied is returned so handlers stay safe in production.
 *   - Unknown locale tags fall back to `DEFAULT_LOCALE`.
 *   - Locale files are read once at startup; the result is shared
 *     across requests so middleware allocation stays cheap.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_LOCALE = 'en';
const SUPPORTED_LOCALES = ['en', 'zh', 'ms', 'ta', 'it'];

/**
 * Parse a raw HTTP `Accept-Language` header into an ordered list of
 * `{ tag, q }` entries. Ties on `q` are broken by source order so the
 * caller's preference matches the HTTP spec.
 *
 *   parseAcceptLanguage('zh-CN,ms;q=0.8,en;q=0.6')
 *     -> [{ tag: 'zh-CN', q: 1 }, { tag: 'ms', q: 0.8 }, { tag: 'en', q: 0.6 }]
 *
 * `q` is clamped to [0, 1] and entries with `q === 0` are dropped.
 * The wildcard `*` is preserved as a literal tag so `resolveTag` can
 * map it to the default locale.
 */
function parseAcceptLanguage(header) {
  if (typeof header !== 'string' || header.length === 0) {
    return [];
  }
  const out = [];
  const parts = header.split(',');
  for (const raw of parts) {
    const piece = raw.trim();
    if (!piece) continue;
    const segments = piece.split(';').map((s) => s.trim()).filter(Boolean);
    const tag = segments[0];
    if (!tag) continue;
    let q = 1;
    for (const seg of segments.slice(1)) {
      const m = /^q\s*=\s*(-?[0-9.]+)$/i.exec(seg);
      if (!m) continue;
      const parsed = Number(m[1]);
      if (Number.isFinite(parsed)) {
        q = Math.max(0, Math.min(1, parsed));
      }
    }
    if (q <= 0) continue;
    out.push({ tag, q });
  }
  out.sort((a, b) => {
    if (b.q !== a.q) return b.q - a.q;
    return out.indexOf(a) - out.indexOf(b);
  });
  return out;
}

/**
 * Normalize a BCP-47-style language tag and return the supported
 * primary-subtag match, or `null`.
 *
 *   resolveTag('zh-CN')     -> 'zh'
 *   resolveTag('zh-Hans')   -> 'zh'
 *   resolveTag('en-US')     -> 'en'
 *   resolveTag('ms-MY')     -> 'ms'
 *   resolveTag('ta-IN')     -> 'ta'
 *   resolveTag('it-IT')     -> 'it'
 *   resolveTag('fr')        -> null
 *   resolveTag('fr-FR')     -> null
 *   resolveTag('*')         -> 'en'
 *   resolveTag('')          -> null
 */
function resolveTag(tag, supported = SUPPORTED_LOCALES) {
  if (typeof tag !== 'string' || tag.length === 0) return null;
  if (tag === '*') return DEFAULT_LOCALE;
  const primary = tag.toLowerCase().split('-')[0];
  if (supported.indexOf(primary) !== -1) return primary;
  return null;
}

/**
 * Choose the best locale for a request given an optional user profile
 * value and a parsed Accept-Language list.
 *
 *   resolveLocale({ userLocale: 'ms-MY', headerLocale: [...] })
 *     -> 'ms'
 *
 * Falls back to `DEFAULT_LOCALE` when neither input matches a
 * supported locale.
 */
function resolveLocale(opts) {
  const headerLocale = Array.isArray(opts && opts.headerLocale) ? opts.headerLocale : [];
  const userLocale = opts && opts.userLocale;
  const supported = SUPPORTED_LOCALES;

  if (typeof userLocale === 'string' && userLocale.length > 0) {
    const resolved = resolveTag(userLocale, supported);
    if (resolved) return resolved;
  }
  for (const entry of headerLocale) {
    const resolved = resolveTag(entry.tag, supported);
    if (resolved) return resolved;
  }
  return DEFAULT_LOCALE;
}

/**
 * Replace `{name}` placeholders in a template with values from
 * `params`. Unknown placeholders are left untouched.
 *
 *   interpolate('Hello, {name}!', { name: 'World' }) -> 'Hello, World!'
 */
function interpolate(template, params) {
  if (typeof template !== 'string') return '';
  if (!params || typeof params !== 'object') return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      const value = params[key];
      return value === null || value === undefined ? '' : String(value);
    }
    return match;
  });
}

/**
 * Look up a translation key in the locale map and interpolate the
 * result. Returns the raw key on miss so handlers never crash.
 *
 *   translate(locales, 'errors.internal', null, 'en') -> 'Internal server error'
 *   translate(locales, 'missing.key', null, 'en')     -> 'missing.key'
 */
function translate(locales, key, params, locale) {
  const bag = locales && locales[locale];
  const fallback = locales && locales[DEFAULT_LOCALE];
  let template;
  if (bag && Object.prototype.hasOwnProperty.call(bag, key)) {
    template = bag[key];
  } else if (fallback && Object.prototype.hasOwnProperty.call(fallback, key)) {
    template = fallback[key];
  } else {
    template = key;
  }
  return interpolate(template, params);
}

/**
 * Read all `*.json` files in `dir` and return `{<locale>: {key: value}}`.
 * Bad files (invalid JSON, missing keys) are skipped so a single
 * malformed locale cannot crash startup — the others still load.
 */
function loadLocales(dir) {
  const out = {};
  if (!dir) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_err) {
    return out;
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const locale = name.slice(0, -'.json'.length);
    if (SUPPORTED_LOCALES.indexOf(locale) === -1) continue;
    const full = path.join(dir, name);
    try {
      const raw = fs.readFileSync(full, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out[locale] = parsed;
      }
    } catch (_err) {
      // Skip malformed locale; the request path will fall back to en.
    }
  }
  return out;
}

/**
 * Build an Express middleware that decorates `req` with:
 *   - `req.locale` — resolved locale tag
 *   - `req.t(key, params)` — translator bound to this request
 *
 * Options:
 *   - `dir`           directory holding `<locale>.json` files (default: `./i18n/locales`)
 *   - `defaultLocale` override the fallback locale
 *   - `getUserLocale(req)` optional hook to extract a profile locale
 */
function createMiddleware(opts) {
  const options = opts || {};
  const dir = options.dir || path.join(__dirname, 'locales');
  const defaultLocale = options.defaultLocale || DEFAULT_LOCALE;
  const getUserLocale = typeof options.getUserLocale === 'function'
    ? options.getUserLocale
    : null;
  const locales = loadLocales(dir);
  const supported = SUPPORTED_LOCALES;

  function localeFromReq(req) {
    const headerLocale = parseAcceptLanguage(req && req.headers ? req.headers['accept-language'] : '');
    const userLocale = getUserLocale ? getUserLocale(req) : (req && req.user ? req.user.locale : undefined);
    return resolveLocale({
      headerLocale,
      userLocale,
      supported,
      defaultLocale,
    });
  }

  function t(key, params) {
    return translate(locales, key, params || null, this && this.locale ? this.locale : defaultLocale);
  }

  function middleware(req, _res, next) {
    const locale = localeFromReq(req);
    req.locale = locale;
    req.t = t;
    next();
  }

  middleware.locales = locales;
  middleware.supported = supported;
  middleware.defaultLocale = defaultLocale;
  middleware.parseAcceptLanguage = parseAcceptLanguage;
  middleware.resolveTag = resolveTag;
  middleware.resolveLocale = resolveLocale;
  middleware.translate = translate;
  middleware.interpolate = interpolate;
  return middleware;
}

module.exports = {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  parseAcceptLanguage,
  resolveTag,
  resolveLocale,
  interpolate,
  translate,
  loadLocales,
  createMiddleware,
};