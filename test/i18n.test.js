'use strict';
const i18n = require('../i18n');

const { translate, resolveTag, parseAcceptLanguage, resolveLocale, i18nMiddleware, SUPPORTED, OPTIONAL, DEFAULT_LOCALE } = i18n;

describe('i18n module config', () => {
  test('exposes the 4 required languages plus italian as optional', () => {
    expect(SUPPORTED).toEqual(['en', 'zh', 'ms', 'ta']);
    expect(OPTIONAL).toEqual(['it']);
  });
  test('default locale is en', () => {
    expect(DEFAULT_LOCALE).toBe('en');
  });
  test('loads a locale file for every supported and optional language', () => {
    for (const code of ['en', 'zh', 'ms', 'ta', 'it']) {
      expect(i18n.LOCALES[code]).toBeDefined();
      expect(typeof i18n.LOCALES[code].tokens.listRetrieved).toBe('string');
    }
  });
});

describe('parseAcceptLanguage', () => {
  test('returns [] for missing/empty header', () => {
    expect(parseAcceptLanguage(undefined)).toEqual([]);
    expect(parseAcceptLanguage('')).toEqual([]);
  });
  test('preserves order for equal weights', () => {
    expect(parseAcceptLanguage('zh,en,ms')).toEqual(['zh', 'en', 'ms']);
  });
  test('orders by descending q-value', () => {
    expect(parseAcceptLanguage('en;q=0.3,zh;q=0.9,ms;q=0.5')).toEqual(['zh', 'ms', 'en']);
  });
  test('drops entry with empty tag', () => {
    expect(parseAcceptLanguage('zh, ,en')).toEqual(['zh', 'en']);
  });
});

describe('resolveTag', () => {
  test('matches a bare supported code', () => {
    expect(resolveTag('zh')).toBe('zh');
    expect(resolveTag('ta')).toBe('ta');
    expect(resolveTag('it')).toBe('it');
  });
  test('normalizes region subtags to primary code', () => {
    expect(resolveTag('zh-CN')).toBe('zh');
    expect(resolveTag('zh-Hans')).toBe('zh');
    expect(resolveTag('en-US')).toBe('en');
    expect(resolveTag('ms-MY')).toBe('ms');
    expect(resolveTag('ta-SG')).toBe('ta');
  });
  test('falls back to en for unsupported primary', () => {
    expect(resolveTag('fr')).toBe('en');
    expect(resolveTag('ja-JP')).toBe('en');
  });
  test('falls back to en for missing/invalid input', () => {
    expect(resolveTag(null)).toBe('en');
    expect(resolveTag('')).toBe('en');
    expect(resolveTag(undefined)).toBe('en');
  });
});

describe('translate', () => {
  test('returns the localized message for each supported language', () => {
    expect(translate('tokens.listRetrieved', 'en')).toBe('Tokens retrieved successfully');
    expect(translate('tokens.listRetrieved', 'zh')).toBe('代币检索成功');
    expect(translate('tokens.listRetrieved', 'ms')).toBe('Token berjaya diambil');
    expect(translate('tokens.listRetrieved', 'ta')).toBe('டோக்கன்கள் வெற்றிகரமாக பெறப்பட்டன');
    expect(translate('tokens.listRetrieved', 'it')).toBe('Token recuperati con successo');
  });
  test('interpolates placeholders by name', () => {
    expect(translate('errors.dbConnection', 'en', { detail: 'ECONNREFUSED' })).toBe('Database connection failed: ECONNREFUSED');
    expect(translate('errors.dbConnection', 'zh', { detail: '超时' })).toBe('数据库连接失败：超时');
  });
  test('leaves unknown placeholders untouched', () => {
    expect(translate('errors.dbConnection', 'en', {})).toBe('Database connection failed: {detail}');
  });
  test('falls back to en when the locale is unsupported', () => {
    expect(translate('tokens.listRetrieved', 'fr')).toBe('Tokens retrieved successfully');
  });
  test('returns the raw key when absent from all locales', () => {
    expect(translate('nonexistent.deep.key', 'en')).toBe('nonexistent.deep.key');
  });
});

describe('resolveLocale (request)', () => {
  test('uses a supported Accept-Language preference before the user profile', () => {
    expect(resolveLocale({ user: { locale: 'zh' }, headers: { 'accept-language': 'en' } })).toBe('en');
  });
  test('ignores an unsupported user profile locale', () => {
    expect(resolveLocale({ user: { locale: 'fr' }, headers: { 'accept-language': 'zh' } })).toBe('zh');
  });
  test('falls back to a supported user profile when the header is unsupported', () => {
    expect(resolveLocale({ user: { locale: 'ta' }, headers: { 'accept-language': 'fr,de' } })).toBe('ta');
  });
  test('uses Accept-Language when no user profile', () => {
    expect(resolveLocale({ headers: { 'accept-language': 'ms,en;q=0.1' } })).toBe('ms');
  });
  test('falls back to en when nothing matches', () => {
    expect(resolveLocale({ headers: { 'accept-language': 'fr,de' } })).toBe('en');
    expect(resolveLocale({ headers: {} })).toBe('en');
    expect(resolveLocale({})).toBe('en');
  });
  test('normalizes a supported regional header before considering the user profile', () => {
    expect(resolveLocale({ user: { locale: 'ta' }, headers: { 'accept-language': 'zh-CN' } })).toBe('zh');
  });
});

describe('i18nMiddleware', () => {
  test('sets req.locale and a working req.t', (done) => {
    const req = { headers: { 'accept-language': 'zh-CN,en;q=0.8' } };
    i18nMiddleware(req, {}, () => {
      expect(req.locale).toBe('zh');
      expect(typeof req.t).toBe('function');
      expect(req.t('tokens.notFound')).toBe('未找到任何代币');
      expect(req.t('errors.dbConnection', { detail: 'x' })).toBe('数据库连接失败：x');
      done();
    });
  });
  test('produces en messages when no language hint is present', (done) => {
    const req = { headers: {} };
    i18nMiddleware(req, {}, () => {
      expect(req.locale).toBe('en');
      expect(req.t('health.ok')).toBe('Service is healthy');
      done();
    });
  });
  test('handles tamil via Accept-Language with quality values', (done) => {
    const req = { headers: { 'accept-language': 'en;q=0.5,ta;q=0.9' } };
    i18nMiddleware(req, {}, () => {
      expect(req.locale).toBe('ta');
      expect(req.t('health.name')).toBe('MyZubster கேட்வே API');
      done();
    });
  });
});
