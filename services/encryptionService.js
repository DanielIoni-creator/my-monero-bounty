const crypto = require('crypto');
const fs = require('fs');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

const getEncryptionKey = () => {
  const keyPath = process.env.ENCRYPTION_KEY_PATH || '.encryption.key';
  if (fs.existsSync(keyPath)) return Buffer.from(fs.readFileSync(keyPath, 'hex'), 'hex');
  const key = crypto.randomBytes(KEY_LENGTH);
  fs.writeFileSync(keyPath, key.toString('hex'));
  return key;
};

const encrypt = (plaintext, key = null) => {
  const encKey = key || getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, encKey, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return JSON.stringify({ iv: iv.toString('hex'), data: encrypted, tag, version: 1 });
};

const decrypt = (encryptedJson, key = null) => {
  const encKey = key || getEncryptionKey();
  const { iv, data, tag } = JSON.parse(encryptedJson);
  const decipher = crypto.createDecipheriv(ALGORITHM, encKey, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
};

const encryptOrderData = (order) => {
  const sensitive = { walletAddress: order.walletAddress, email: order.email, phone: order.phone, amount: order.amount };
  return encrypt(JSON.stringify(sensitive));
};

const decryptOrderData = (encryptedJson) => {
  try { return JSON.parse(decrypt(encryptedJson)); }
  catch { return null; }
};

module.exports = { encrypt, decrypt, encryptOrderData, decryptOrderData };
