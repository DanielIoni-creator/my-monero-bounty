'use strict';

/**
 * Pure unit tests for the i18n module + middleware.
 * No network, no DB. Uses an in-memory fake Express req/res.
 */

const path = require('path');

jest.mock('express', () => {
  return {
    Router: () => {
      const stack = [];
      const handler = {};
      handler.get = jest.fn();
      handler.post = jest.fn();
      handler.put = jest.fn();
      handler.delete = jest.fn();
      handler.use = jest.fn((mw) => {
        if (typeof mw === 'function') stack.push(mw);
        return handler;
      });
      handler._stack = stack;
      return handler;
    },
  };
});

const i18n = require('../i18n');

function runMiddleware(mw, req) {
  const res = { locals: {} };
  return new Promise((resolve, reject) => {
    let nextCalled = false;
    const next = (err) => {
      nextCalled = true;
      if (err) reject(err);
      else resolve({ req, res, called: nextCalled });
    };
    try {
      const ret = mw(req, res, next);
      if (ret && typeof ret.then === 'function') {
        ret.then(() => resolve({ req, res, called: nextCalled })).catch(reject);
      }
    } catch (err) {
      reject(err);
    }
    if (!nextCalled) {
      // Express middleware is expected to call next synchronously here.
    }
  });
}

describe('i18n module — constants', () => {
  test('DEFAULT_LOCALE is "en"', () => {
    expect(i18n.DEFAULT_LOCALE).toBe('en');
  });

  test('SUPPORTED_LOCALES includes en, zh, ms, ta, it', () => {
    expect(i18n.SUPPORTED_LOCALES).toEqual(
      expect.arrayContaining(['en', 'zh', 'ms', 'ta', 'it'])
    );
    expect(i18n.SUPPORTED_LOCALES.length).toBe(5);
  });
});

describe('parseAcceptLanguage', () => {
  test('returns [] for null / undefined / empty / non-string', () => {
    expect(i18n.parseAcceptLanguage(null)).toEqual([]);
    expect(i18n.parseAcceptLanguage(undefined)).toEqual([]);
    expect(i18n.parseAcceptLanguage('')).toEqual([]);
    expect(i18n.parseAcceptLanguage(42)).toEqual([]);
  });

  test('parses a single tag with default q=1', () => {
    expect(i18n.parseAcceptLanguage('en')).toEqual([{ tag: 'en', q: 1 }]);
  });

  test('orders by q-value descending', () => {
    const out = i18n.parseAcceptLanguage('en;q=0.1, zh;q=0.9, ms;q=0.5');
    expect(out.map((e) => e.tag)).toEqual(['zh', 'ms', 'en']);
  });

  test('skips entries with q <= 0', () => {
    const out = i18n.parseAcceptLanguage('en;q=0, zh;q=1');
    expect(out.map((e) => e.tag)).toEqual(['zh']);
  });

  test('clamps q to [0, 1] when the value matches the q-value pattern', () => {
    expect(i18n.parseAcceptLanguage('en;q=2')[0].q).toBe(1);
    // q=0 is dropped by the `q <= 0` filter
    expect(i18n.parseAcceptLanguage('en;q=0')).toEqual([]);
    // Malformed q values (e.g. with a sign) do not match the pattern and
    // fall back to the default q=1. This is a deliberate fail-open.
    expect(i18n.parseAcceptLanguage('en;q=-1')[0].q).toBe(1);
  });

  test('skips empty parts and malformed segments', () => {
    const out = i18n.parseAcceptLanguage(' , ,en;q=0.5, ,');
    expect(out.map((e) => e.tag)).toEqual(['en']);
  });

  test('handles wildcard *', () => {
    expect(i18n.parseAcceptLanguage('*')).toEqual([{ tag: '*', q: 1 }]);
  });
});

describe('resolveTag', () => {
  test('returns the primary subtag for known locales', () => {
    expect(i18n.resolveTag('en')).toBe('en');
    expect(i18n.resolveTag('en-US')).toBe('en');
    expect(i18n.resolveTag('zh-CN')).toBe('zh');
    expect(i18n.resolveTag('zh-Hans')).toBe('zh');
    expect(i18n.resolveTag('ms-MY')).toBe('ms');
    expect(i18n.resolveTag('ta-IN')).toBe('ta');
    expect(i18n.resolveTag('it-IT')).toBe('it');
  });

  test('returns null for unsupported locales', () => {
    expect(i18n.resolveTag('fr')).toBeNull();
    expect(i18n.resolveTag('fr-FR')).toBeNull();
    expect(i18n.resolveTag('de')).toBeNull();
  });

  test('wildcard * resolves to DEFAULT_LOCALE', () => {
    expect(i18n.resolveTag('*')).toBe('en');
  });

  test('returns null for null / undefined / non-string', () => {
    expect(i18n.resolveTag(null)).toBeNull();
    expect(i18n.resolveTag(undefined)).toBeNull();
    expect(i18n.resolveTag(42)).toBeNull();
    expect(i18n.resolveTag('')).toBeNull();
  });

  test('respects the supported set override', () => {
    expect(i18n.resolveTag('zh-CN', ['en', 'zh'])).toBe('zh');
    expect(i18n.resolveTag('it', ['en'])).toBeNull();
  });
});

describe('resolveLocale', () => {
  test('user locale wins over Accept-Language', () => {
    const out = i18n.resolveLocale({
      headerList: i18n.parseAcceptLanguage('en;q=0.9'),
      userLocale: 'zh-CN',
    });
    expect(out).toBe('zh');
  });

  test('unsupported user locale is ignored, header is used', () => {
    const out = i18n.resolveLocale({
      headerList: i18n.parseAcceptLanguage('zh;q=0.9'),
      userLocale: 'fr-FR',
    });
    expect(out).toBe('zh');
  });

  test('falls back to default when nothing matches', () => {
    const out = i18n.resolveLocale({
      headerList: i18n.parseAcceptLanguage('fr-FR;q=0.9, de;q=0.5'),
    });
    expect(out).toBe('en');
  });

  test('header with no user locale uses header', () => {
    const out = i18n.resolveLocale({
      headerList: i18n.parseAcceptLanguage('zh-CN,en;q=0.5'),
    });
    expect(out).toBe('zh');
  });

  test('default is configurable', () => {
    const out = i18n.resolveLocale({
      headerList: [],
      defaultLocale: 'ta',
    });
    expect(out).toBe('ta');
  });
});

describe('interpolate', () => {
  test('replaces {{name}} placeholders', () => {
    expect(i18n.interpolate('Hello, {{name}}!', { name: 'World' })).toBe(
      'Hello, World!'
    );
  });

  test('replaces multiple placeholders and stringifies numbers', () => {
    expect(
      i18n.interpolate('Found {{count}} of {{total}}', { count: 3, total: 10 })
    ).toBe('Found 3 of 10');
  });

  test('missing params become empty strings', () => {
    expect(i18n.interpolate('Hi {{name}}, {{greeting}}', { name: 'A' })).toBe(
      'Hi A, '
    );
  });

  test('no params returns the template unchanged', () => {
    expect(i18n.interpolate('plain text', null)).toBe('plain text');
  });

  test('handles whitespace inside braces', () => {
    expect(i18n.interpolate('a {{ x }} b', { x: '1' })).toBe('a 1 b');
  });
});

describe('loadLocales', () => {
  test('reads every supported locale file in the given directory', () => {
    const dir = path.join(__dirname, '..', 'i18n', 'locales');
    const locales = i18n.loadLocales(dir);
    for (const code of i18n.SUPPORTED_LOCALES) {
      expect(locales[code]).toBeDefined();
      expect(typeof locales[code]).toBe('object');
    }
  });

  test('returns {} for a non-existent directory', () => {
    expect(i18n.loadLocales('/no/such/dir/anywhere')).toEqual({});
  });

  test('ignores files that are not <supported-locale>.json', () => {
    const locales = i18n.loadLocales(__dirname);
    // no JSON files in the test/ directory; result must be empty
    expect(locales).toEqual({});
  });
});

describe('makeTranslator', () => {
  const locales = {
    en: { hello: 'Hello, {{name}}' },
    zh: { hello: '你好，{{name}}' },
  };
  const t = i18n.makeTranslator(locales);

  test('returns the localized string for a known key', () => {
    expect(t('hello', { name: 'A' }, 'zh')).toBe('你好，A');
    expect(t('hello', { name: 'B' }, 'en')).toBe('Hello, B');
  });

  test('falls back to en when the locale is unsupported', () => {
    expect(t('hello', { name: 'C' }, 'fr')).toBe('Hello, C');
  });

  test('falls back to en when the key is missing in the requested locale', () => {
    const sparse = { en: { only_en: 'en-only' }, zh: {} };
    const t2 = i18n.makeTranslator(sparse);
    expect(t2('only_en', {}, 'zh')).toBe('en-only');
  });

  test('returns the raw key as a fallback when nothing has the key', () => {
    expect(t('missing_key', { x: 1 }, 'en')).toBe('missing_key');
  });

  test('returns the raw key when the missing key contains a placeholder', () => {
    // No interpolation on raw fallback (safer for unknown keys).
    expect(t('foo.{{name}}', { name: 'bar' }, 'en')).toBe('foo.{{name}}');
  });
});

describe('i18nMiddleware (Express middleware)', () => {
  beforeEach(() => {
    // Force a fresh load of locales for each test by re-configuring.
    i18n.i18nMiddleware.configure({
      localesDir: path.join(__dirname, '..', 'i18n', 'locales'),
    });
  });

  test('sets req.locale and req.t from Accept-Language', () => {
    const req = { headers: { 'accept-language': 'zh-CN,en;q=0.5' } };
    return runMiddleware(i18n.i18nMiddleware, req).then(({ req: r }) => {
      expect(r.locale).toBe('zh');
      expect(typeof r.t).toBe('function');
      expect(r.t('health.ok')).toBe('正常');
    });
  });

  test('user locale on req.user.locale wins', () => {
    const req = {
      headers: { 'accept-language': 'en' },
      user: { locale: 'ta' },
    };
    return runMiddleware(i18n.i18nMiddleware, req).then(({ req: r }) => {
      expect(r.locale).toBe('ta');
      expect(r.t('health.ok')).toBe('சரி');
    });
  });

  test('falls back to en when header and user locale are missing/unsupported', () => {
    const req = { headers: {} };
    return runMiddleware(i18n.i18nMiddleware, req).then(({ req: r }) => {
      expect(r.locale).toBe('en');
      expect(r.t('health.ok')).toBe('ok');
    });
  });

  test('handles missing Accept-Language header gracefully', () => {
    const req = { headers: {} };
    return runMiddleware(i18n.i18nMiddleware, req).then(({ req: r }) => {
      expect(r.locale).toBe('en');
    });
  });

  test('returns localized messages for the requested locale', () => {
    const req = { headers: { 'accept-language': 'ms' } };
    return runMiddleware(i18n.i18nMiddleware, req).then(({ req: r }) => {
      expect(r.t('errors.notFound')).toBe('Sumber tidak ditemui');
    });
  });

  test('returns Italian for it locale', () => {
    const req = { headers: { 'accept-language': 'it-IT,it;q=0.9' } };
    return runMiddleware(i18n.i18nMiddleware, req).then(({ req: r }) => {
      expect(r.locale).toBe('it');
      expect(r.t('health.ok')).toBe('ok');
    });
  });

  test('interpolates placeholders in middleware t() calls', () => {
    const req = { headers: { 'accept-language': 'en' } };
    return runMiddleware(i18n.i18nMiddleware, req).then(({ req: r }) => {
      expect(r.t('db.tokenCount', { count: 5 })).toBe('Found 5 tokens');
    });
  });

  test('sets res.locals.locale for templates', () => {
    const req = { headers: { 'accept-language': 'zh' } };
    return runMiddleware(i18n.i18nMiddleware, req).then(({ res }) => {
      expect(res.locals.locale).toBe('zh');
      expect(typeof res.locals.t).toBe('function');
    });
  });

  test('q-value ordering chooses higher-preference locale', () => {
    const req = { headers: { 'accept-language': 'en;q=0.1, zh;q=0.9' } };
    return runMiddleware(i18n.i18nMiddleware, req).then(({ req: r }) => {
      expect(r.locale).toBe('zh');
    });
  });

  test('returns the raw key on a missing translation without throwing', () => {
    const req = { headers: { 'accept-language': 'en' } };
    return runMiddleware(i18n.i18nMiddleware, req).then(({ req: r }) => {
      expect(r.t('not.a.real.key')).toBe('not.a.real.key');
    });
  });
});
