const fs = require('fs');
const path = require('path');

const SUPPORTED = ['en','zh','ms','ta','it'];
const DEFAULT = 'en';
let messages = {};

const loadMessages = () => {
  const dir = path.join(__dirname,'locales');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
  for (const lang of SUPPORTED) {
    const fp = path.join(dir,lang+'.json');
    if (fs.existsSync(fp)) messages[lang] = JSON.parse(fs.readFileSync(fp,'utf8'));
  }
};

const t = (lang, key, params={}) => {
  let msg = (messages[lang] && messages[lang][key]) || (messages[DEFAULT] && messages[DEFAULT][key]) || key;
  for (const [k,v] of Object.entries(params)) msg = msg.replace('{'+k+'}', v);
  return msg;
};

const i18nMiddleware = (req, res, next) => {
  const lang = (req.query.lang || req.headers['accept-language'] || '').split(',')[0].split('-')[0].substring(0,2);
  req.lang = SUPPORTED.includes(lang) ? lang : DEFAULT;
  req.t = (key, params) => t(req.lang, key, params);
  next();
};

loadMessages();
module.exports = { i18nMiddleware, t, loadMessages, SUPPORTED };
