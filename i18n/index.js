'use strict';

/**
 * Internationalization (i18n) module for MyZubster Gateway API responses.
 *
 * Resolves the request locale from (in order):
 *   1. `req.user.locale` if a route sets it (logged-in user profile)
 *   2. The `Accept-Language` HTTP header (parsed with q-value ordering
 *      and regional-tag normalization)
 *   3. The default locale (`en`)
 *
 * Exposes:
 *   - DEFAULT_LOCALE, SUPPORTED_LOCALES
 *   - parseAcceptLanguage(header): [{tag, q}] ordered by preference
 *   - resolveTag(tag): primary subtag if supported, else null
 *   - resolveLocale({ headerLocale, userLocale, supported, defaultLocale })
 *   - translate(key, params, locale): localized string (raw key on miss)
 *   - loadLocales(dir): {locale: {key: value}} (sync fs read)
 *   - i18nMiddleware: express middleware that sets req.locale + req.t
 *
 * Designed to fail open: a missing translation returns the raw key with
 * interpolation applied, so handlers never throw because of i18n.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_LOCALE = 'en';
const SUPPORTED_LOCALES = ['en', 'zh', 'ms', 'ta', 'it'];

/**
 * Parse an HTTP Accept-Language header into an ordered list of
 * `{ tag, q }` entries. Ties are broken by source order. The wildcard
 * `*` resolves to the default locale. Invalid entries are skipped.
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
      const m = /^q\s*=\s*([0-9.]+)$/i.exec(seg);
      if (m) {
        const parsed = Number(m[1]);
        if (Number.isFinite(parsed)) q = Math.max(0, Math.min(1, parsed));
      }
    }
    if (q <= 0) continue;
    out.push({ tag, q });
  }
  out.sort((a, b) => b.q - a.q);
  return out;
}

/**
 * Normalize a BCP-47-style language tag to its primary subtag and
 * return the supported-locale match (or null).
 *
 *   'zh'        -> 'zh'
 *   'zh-CN'     -> 'zh'
 *   'zh-Hans'   -> 'zh'
 *   'en-US'     -> 'en'
 *   'ms-MY'     -> 'ms'
 *   'ta-IN'     -> 'ta'
 *   'it-IT'     -> 'it'
 *   'fr'        -> null
 *   'fr-FR'     -> null
 *   'en'        -> 'en'
 */
function resolveTag(tag, supported = SUPPORTED_LOCALES) {
  if (typeof tag !== 'string' || tag.length === 0) return null;
  if (tag === '*') return DEFAULT_LOCALE;
  const primary = tag.toLowerCase().split('-')[0];
  if (supported.indexOf(primary) !== -1) return primary;
  return null;
}

/**
 * Pick the best locale given (optional) header list, optional user
 * profile setting, the supported set, and the default.
 */
function resolveLocale({
  headerList = [],
  userLocale = null,
  supported = SUPPORTED_LOCALES,
  defaultLocale = DEFAULT_LOCALE,
} = {}) {
  if (typeof userLocale === 'string' && userLocale.length > 0) {
    const userMatch = resolveTag(userLocale, supported);
    if (userMatch) return userMatch;
  }
  for (const entry of headerList) {
    const match = resolveTag(entry.tag, supported);
    if (match) return match;
  }
  return defaultLocale;
}

/**
 * Replace `{{name}}` placeholders with values from `params`. Missing
 * params become empty strings. Numeric and boolean params stringify.
 */
function interpolate(template, params) {
  if (typeof template !== 'string') return '';
  if (!params || typeof params !== 'object') return template;
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key) => {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      const v = params[key];
      if (v === null || v === undefined) return '';
      return String(v);
    }
    return '';
  });
}

/**
 * Synchronously load every `*.json` file in `dir` as a locale dictionary.
 * Files must be named `<locale>.json`. Unknown locales are ignored.
 * Returns `{ en: {...}, zh: {...}, ... }`.
 */
function loadLocales(dir) {
  const result = {};
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (_err) {
    return result;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const locale = entry.slice(0, -'.json'.length);
    if (SUPPORTED_LOCALES.indexOf(locale) === -1) continue;
    const full = path.join(dir, entry);
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (data && typeof data === 'object') {
        result[locale] = data;
      }
    } catch (_err) {
      // skip unreadable / malformed locale files
    }
  }
  return result;
}

/**
 * Build the translate function for a given loaded-locales dictionary.
 * Returns the raw key on a missing key or unsupported locale, with
 * `{{name}}` interpolation applied.
 */
function makeTranslator(locales) {
  return function translate(key, params, locale) {
    const requestedLocale =
      typeof locale === 'string' && SUPPORTED_LOCALES.indexOf(locale) !== -1
        ? locale
        : DEFAULT_LOCALE;
    const source = locales[requestedLocale] || locales[DEFAULT_LOCALE] || {};
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      return interpolate(source[key], params);
    }
    const fallback = locales[DEFAULT_LOCALE] || {};
    if (Object.prototype.hasOwnProperty.call(fallback, key)) {
      return interpolate(fallback[key], params);
    }
    // Return the raw key without interpolation when nothing has it
    // (safer for unknown keys: handlers see the missing key, not a
    // partially-rendered string).
    return key;
  };
}

/**
 * Express middleware that:
 *   - loads locales from the `i18n/locales` directory next to this
 *     module unless `locales` is provided
 *   - sets `req.locale` (string) and `req.t(key, params)` (function)
 *   - sets `res.locals.locale` for views/templates
 */
function i18nMiddleware(req, res, next) {
  if (!i18nMiddleware._locales) {
    const dir = i18nMiddleware._localesDir ||
      path.join(__dirname, 'locales');
    i18nMiddleware._locales = loadLocales(dir);
  }
  const locales = i18nMiddleware._locales;
  const headerList = parseAcceptLanguage(req.headers['accept-language']);
  const userLocale =
    req.user && typeof req.user.locale === 'string' ? req.user.locale : null;
  const locale = resolveLocale({
    headerList,
    userLocale,
    supported: SUPPORTED_LOCALES,
    defaultLocale: DEFAULT_LOCALE,
  });
  const translate = makeTranslator(locales);
  req.locale = locale;
  req.t = function t(key, params) {
    return translate(key, params, locale);
  };
  if (res && res.locals) {
    res.locals.locale = locale;
    res.locals.t = req.t;
  }
  next();
}

i18nMiddleware.configure = function configure(opts) {
  const dir = opts && opts.localesDir;
  const locales = opts && opts.locales;
  if (locales && typeof locales === 'object') {
    i18nMiddleware._locales = locales;
  }
  if (dir) {
    i18nMiddleware._localesDir = dir;
    i18nMiddleware._locales = loadLocales(dir);
  }
};

module.exports = {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  parseAcceptLanguage,
  resolveTag,
  resolveLocale,
  interpolate,
  loadLocales,
  makeTranslator,
  i18nMiddleware,
};
