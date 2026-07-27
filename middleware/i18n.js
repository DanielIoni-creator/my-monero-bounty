/**
 * i18n Middleware for MyZubster Gateway
 * Detects language from Accept-Language header and provides translation helpers.
 * 
 * Supported languages: en (English), zh (Chinese), ms (Malay), ta (Tamil)
 * Default fallback: en
 */

const fs = require('fs');
const path = require('path');

const SUPPORTED_LANGUAGES = ['en', 'zh', 'ms', 'ta'];
const DEFAULT_LANGUAGE = 'en';
const LOCALES_DIR = path.join(__dirname, '..', 'locales');

// Load all translation files at startup
const translations = {};
for (const lang of SUPPORTED_LANGUAGES) {
  try {
    const filePath = path.join(LOCALES_DIR, `${lang}.json`);
    translations[lang] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`⚠️  Could not load translations for '${lang}': ${err.message}`);
    translations[lang] = {};
  }
}

/**
 * Parse the Accept-Language header and return the best matching language.
 * Example: "zh-CN,zh;q=0.9,en;q=0.8" → "zh"
 */
function detectLanguage(acceptLanguage) {
  if (!acceptLanguage) return DEFAULT_LANGUAGE;
  
  // Parse quality values
  const langs = acceptLanguage.split(',').map(part => {
    const [lang, qValue] = part.trim().split(';q=');
    return {
      code: lang.split('-')[0].toLowerCase(),
      quality: qValue ? parseFloat(qValue) : 1.0
    };
  });
  
  // Sort by quality (highest first)
  langs.sort((a, b) => b.quality - a.quality);
  
  // Find first supported language
  for (const lang of langs) {
    if (SUPPORTED_LANGUAGES.includes(lang.code)) {
      return lang.code;
    }
  }
  
  return DEFAULT_LANGUAGE;
}

/**
 * Translate a key with optional format arguments (printf-style %s, %d).
 */
function translate(lang, key, ...args) {
  const template = (translations[lang] && translations[lang][key]) 
    || (translations[DEFAULT_LANGUAGE][key])
    || key;
  
  if (args.length === 0) return template;
  
  // Simple printf-style formatting: %s, %d
  let result = template;
  let argIndex = 0;
  result = result.replace(/%[sd]/g, () => {
    const val = args[argIndex++];
    return val !== undefined ? String(val) : '';
  });
  return result;
}

/**
 * Express middleware that attaches i18n helpers to the request object.
 */
function i18nMiddleware(req, res, next) {
  const lang = detectLanguage(req.headers['accept-language']);
  req.language = lang;
  req.t = (key, ...args) => translate(lang, key, ...args);
  req.translations = translations[lang] || translations[DEFAULT_LANGUAGE];
  next();
}

module.exports = { i18nMiddleware, detectLanguage, translate, SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE };
