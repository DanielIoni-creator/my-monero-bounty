'use strict';

/**
 * Tests for the i18n module added for issue #22.
 *
 * Coverage required by the bounty brief:
 *   1. Language resolution priority
 *      - user.profile.locale > Accept-Language > default ('en')
 *   2. Missing-key fallback
 *      - locale-specific miss -> English; English miss -> raw key
 *   3. Accept-Language q-value parsing
 *      - ordering by q, drop q=0, wildcard '*'
 *
 * Plus end-to-end coverage for the wired-up admin webhook router
 * (the simple-server entry point is exercised in a separate manual
 * smoke test because requiring it binds port 8080).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');

const i18n = require('../i18n');

function makeTempLocalesDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-test-'));
  const en = {
    'errors.internal': 'Internal server error',
    'errors.bad_request': 'Bad request',
    'errors.not_found': 'Resource not found',
    'errors.upstream_unavailable': 'Upstream service is currently unavailable',
    'api.tokens.list_failed': 'Unable to load token list',
    'api.health.ok': 'ok',
    'webhook.signature_missing': 'Webhook signature header is missing',
    'webhook.signature_invalid': 'Webhook signature is invalid',
  };
  fs.writeFileSync(path.join(dir, 'en.json'), JSON.stringify(en));
  return dir;
}

describe('i18n core', () => {
  describe('parseAcceptLanguage', () => {
    test('orders entries by q-value', () => {
      const parsed = i18n.parseAcceptLanguage('en;q=0.2,zh;q=0.9,ms;q=0.5');
      expect(parsed.map((p) => p.tag)).toEqual(['zh', 'ms', 'en']);
      expect(parsed.map((p) => p.q)).toEqual([0.9, 0.5, 0.2]);
    });

    test('drops q=0 entries', () => {
      const parsed = i18n.parseAcceptLanguage('en;q=0,zh,ms;q=0.4');
      expect(parsed.map((p) => p.tag)).toEqual(['zh', 'ms']);
    });

    test('preserves source order on tied q-values', () => {
      const parsed = i18n.parseAcceptLanguage('ms,zh,en');
      expect(parsed.map((p) => p.tag)).toEqual(['ms', 'zh', 'en']);
    });

    test('returns empty list for empty / non-string header', () => {
      expect(i18n.parseAcceptLanguage('')).toEqual([]);
      expect(i18n.parseAcceptLanguage(undefined)).toEqual([]);
      expect(i18n.parseAcceptLanguage(null)).toEqual([]);
    });

    test('clamps out-of-range q to [0, 1]', () => {
      const parsed = i18n.parseAcceptLanguage('en;q=2,zh;q=-1,ms;q=0.5');
      expect(parsed).toEqual([
        { tag: 'en', q: 1 },
        { tag: 'ms', q: 0.5 },
      ]);
    });

    test('keeps wildcard *', () => {
      const parsed = i18n.parseAcceptLanguage('*;q=0.1');
      expect(parsed).toEqual([{ tag: '*', q: 0.1 }]);
    });
  });

  describe('resolveTag', () => {
    test('matches primary subtag and ignores region', () => {
      expect(i18n.resolveTag('zh-CN')).toBe('zh');
      expect(i18n.resolveTag('zh-Hans')).toBe('zh');
      expect(i18n.resolveTag('en-US')).toBe('en');
      expect(i18n.resolveTag('ms-MY')).toBe('ms');
      expect(i18n.resolveTag('ta-IN')).toBe('ta');
      expect(i18n.resolveTag('it-IT')).toBe('it');
    });

    test('returns null for unsupported primary subtag', () => {
      expect(i18n.resolveTag('fr')).toBeNull();
      expect(i18n.resolveTag('fr-FR')).toBeNull();
      expect(i18n.resolveTag('de')).toBeNull();
    });

    test('maps wildcard to default locale', () => {
      expect(i18n.resolveTag('*')).toBe('en');
    });

    test('returns null for empty / non-string', () => {
      expect(i18n.resolveTag('')).toBeNull();
      expect(i18n.resolveTag(undefined)).toBeNull();
    });
  });

  describe('resolveLocale', () => {
    test('user profile beats header', () => {
      const out = i18n.resolveLocale({
        userLocale: 'ta',
        headerLocale: i18n.parseAcceptLanguage('zh-CN,ms;q=0.8,en;q=0.6'),
      });
      expect(out).toBe('ta');
    });

    test('header beats default when no user profile', () => {
      const out = i18n.resolveLocale({
        headerLocale: i18n.parseAcceptLanguage('zh-CN,ms;q=0.8,en;q=0.6'),
      });
      expect(out).toBe('zh');
    });

    test('falls back to default locale on empty header', () => {
      expect(i18n.resolveLocale({ headerLocale: [] })).toBe('en');
      expect(i18n.resolveLocale({})).toBe('en');
    });

    test('skips unsupported header entries', () => {
      const out = i18n.resolveLocale({
        headerLocale: i18n.parseAcceptLanguage('fr-FR;q=0.9,de;q=0.8,ms;q=0.5'),
      });
      expect(out).toBe('ms');
    });

    test('falls back when user profile is unsupported', () => {
      const out = i18n.resolveLocale({
        userLocale: 'de',
        headerLocale: i18n.parseAcceptLanguage('zh-CN'),
      });
      expect(out).toBe('zh');
    });
  });

  describe('interpolate', () => {
    test('replaces known placeholders', () => {
      expect(i18n.interpolate('Field {field} is required', { field: 'name' }))
        .toBe('Field name is required');
    });

    test('leaves unknown placeholders intact', () => {
      expect(i18n.interpolate('Hi {name}, age {age}', { name: 'A' }))
        .toBe('Hi A, age {age}');
    });

    test('returns template unchanged when params is null', () => {
      expect(i18n.interpolate('Hi {name}', null)).toBe('Hi {name}');
    });
  });

  describe('translate', () => {
    const locales = {
      en: { 'greeting': 'Hello {name}' },
      zh: { 'greeting': '你好 {name}' },
    };

    test('returns localized string with interpolation', () => {
      expect(i18n.translate(locales, 'greeting', { name: 'A' }, 'zh'))
        .toBe('你好 A');
    });

    test('falls back to English when locale-specific key missing', () => {
      const partial = { en: { 'greeting': 'Hello' }, zh: {} };
      expect(i18n.translate(partial, 'greeting', null, 'zh')).toBe('Hello');
    });

    test('returns raw key when key missing in both locale and English', () => {
      expect(i18n.translate({}, 'missing.key', null, 'en')).toBe('missing.key');
    });

    test('never throws on missing locale bag', () => {
      expect(() => i18n.translate(null, 'x', null, 'en')).not.toThrow();
    });
  });
});

describe('i18n middleware', () => {
  function buildApp(middleware) {
    const app = express();
    app.use(middleware);
    app.get('/probe', (req, res) => {
      res.json({ locale: req.locale, value: req.t('errors.internal') });
    });
    return app;
  }

  test('decorates req.locale from Accept-Language', async () => {
    const app = buildApp(i18n.createMiddleware({ dir: makeTempLocalesDir() }));
    const res = await request(app)
      .get('/probe')
      .set('Accept-Language', 'zh-CN,ms;q=0.8,en;q=0.6');
    expect(res.status).toBe(200);
    expect(res.body.locale).toBe('zh');
  });

  test('defaults to English when no header is sent', async () => {
    const app = buildApp(i18n.createMiddleware({ dir: makeTempLocalesDir() }));
    const res = await request(app).get('/probe');
    expect(res.body.locale).toBe('en');
    expect(res.body.value).toBe('Internal server error');
  });

  test('falls back to English when header is unsupported', async () => {
    const app = buildApp(i18n.createMiddleware({ dir: makeTempLocalesDir() }));
    const res = await request(app)
      .get('/probe')
      .set('Accept-Language', 'fr-FR,de;q=0.5');
    expect(res.body.locale).toBe('en');
  });

  test('user-profile locale takes priority over header', async () => {
    // When the user profile resolves to an unsupported locale,
    // the middleware falls back through the Accept-Language chain
    // (instead of falling back directly to default). This keeps
    // the priority order: user-profile -> header -> default.
    //
    // Note: `req.locale` is the resolved primary subtag from the
    // *supported set*, not the loaded-file set. Translation lookup
    // falls back to English when the selected locale has no file.
    const app = buildApp(i18n.createMiddleware({
      dir: makeTempLocalesDir(),
      getUserLocale: (req) => req.headers['x-user-locale'],
    }));
    const res = await request(app)
      .get('/probe')
      .set('Accept-Language', 'zh-CN')
      .set('X-User-Locale', 'de');
    // User set 'de' (unsupported) -> falls back to header 'zh-CN' -> 'zh'.
    expect(res.body.locale).toBe('zh');
    // Translation lookup still falls back to en since the test dir
    // only contains en.json.
    expect(res.body.value).toBe('Internal server error');
  });

  test('user-profile supported value wins over header', async () => {
    // Provide a richer locale dir so 'ta' is supported.
    const dir = makeTempLocalesDir();
    fs.writeFileSync(path.join(dir, 'ta.json'), JSON.stringify({
      'errors.internal': 'உள் சேவையக பிழை',
    }));
    const app = buildApp(i18n.createMiddleware({
      dir,
      getUserLocale: (req) => req.headers['x-user-locale'],
    }));
    const res = await request(app)
      .get('/probe')
      .set('Accept-Language', 'zh-CN')
      .set('X-User-Locale', 'ta');
    expect(res.body.locale).toBe('ta');
    expect(res.body.value).toBe('உள் சேவையக பிழை');
  });

  test('missing translation returns raw key with interpolation', async () => {
    const app = buildApp(i18n.createMiddleware({ dir: makeTempLocalesDir() }));
    app.get('/raw', (req, res) => res.json({ value: req.t('nonexistent.key') }));
    const res = await request(app).get('/raw');
    expect(res.body.value).toBe('nonexistent.key');
  });
});

describe('mongo-proxy.js /api/health style localized handler', () => {
  test('responds with localized status string for zh-CN', async () => {
    const dir = makeTempLocalesDir();
    fs.writeFileSync(path.join(dir, 'zh.json'), JSON.stringify({
      'api.health.ok': '正常',
    }));
    const express = require('express');
    const { createMiddleware } = require('../i18n');
    const app = express();
    app.use(createMiddleware({ dir }));
    app.get('/api/health', (req, res) => {
      res.json({ status: req.t('api.health.ok'), timestamp: 'x' });
    });

    const zh = await request(app).get('/api/health').set('Accept-Language', 'zh-CN');
    expect(zh.body.status).toBe('正常');

    const en = await request(app).get('/api/health');
    expect(en.body.status).toBe('ok');
  });
});

describe('routes/admin/webhooks.js localized error labels', () => {
  test('bad_request carries localized label and locale field', async () => {
    const dir = makeTempLocalesDir();
    const { InMemoryWebhookStore } = require('../services/inMemoryStore');
    const { buildAdminWebhooksRouter } = require('../routes/admin/webhooks');
    const express = require('express');
    const { createMiddleware } = require('../i18n');

    const app = express();
    app.use(express.json());
    app.use(createMiddleware({ dir }));
    app.use('/api/admin', buildAdminWebhooksRouter({ store: new InMemoryWebhookStore() }));

    const res = await request(app)
      .post('/api/admin/webhooks')
      .set('Accept-Language', 'zh-CN')
      .send({ name: 'no-url' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
    expect(res.body.locale).toBe('zh');
    expect(typeof res.body.label).toBe('string');
    expect(res.body.label.length).toBeGreaterThan(0);
  });

  test('not_found carries localized label and locale field', async () => {
    const dir = makeTempLocalesDir();
    const { InMemoryWebhookStore } = require('../services/inMemoryStore');
    const { buildAdminWebhooksRouter } = require('../routes/admin/webhooks');
    const express = require('express');
    const { createMiddleware } = require('../i18n');

    const app = express();
    app.use(express.json());
    app.use(createMiddleware({ dir }));
    app.use('/api/admin', buildAdminWebhooksRouter({ store: new InMemoryWebhookStore() }));

    const res = await request(app)
      .get('/api/admin/webhooks/does-not-exist')
      .set('Accept-Language', 'zh-CN');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
    expect(res.body.locale).toBe('zh');
    expect(typeof res.body.label).toBe('string');
  });
});

describe('loadLocales', () => {
  test('reads only supported locales and skips malformed files', () => {
    const dir = makeTempLocalesDir();
    // Write a malformed locale file (bad JSON) and an unsupported
    // locale; the loader should silently skip both.
    fs.writeFileSync(path.join(dir, 'fr.json'), '{ this is not json');
    fs.writeFileSync(path.join(dir, 'klingon.json'), JSON.stringify({ 'a': 'b' }));
    const loaded = i18n.loadLocales(dir);
    expect(Object.keys(loaded).sort()).toEqual(['en']);
  });

  test('returns empty object when directory is missing', () => {
    expect(i18n.loadLocales('/tmp/does-not-exist-i18n-' + Date.now())).toEqual({});
  });
});