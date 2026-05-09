/**
 * 使用 AES-256-GCM 加密存储用户 oauth token。
 * 生产环境务必设置 SCHEDULER_ENCRYPTION_KEY（64 位十六进制 = 32 字节）或 SCHEDULER_MASTER_PASSWORD。
 */
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 16;
const AUTH_TAG_LEN = 16;

function getKeyBuffer() {
  const hex = process.env.SCHEDULER_ENCRYPTION_KEY;
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) {
    return Buffer.from(hex, 'hex');
  }
  const pwd = process.env.SCHEDULER_MASTER_PASSWORD;
  if (pwd && String(pwd).length > 0) {
    return crypto.scryptSync(String(pwd), 'byerun-scheduler-v1', 32);
  }
  console.warn(
    '[tokenVault] 未设置 SCHEDULER_ENCRYPTION_KEY 或 SCHEDULER_MASTER_PASSWORD，使用内置弱密钥（仅开发）。',
  );
  return crypto.scryptSync('byerun-dev-only-unsafe', 'byerun-scheduler-v1', 32);
}

function encryptToken(plainText) {
  const key = getKeyBuffer();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptToken(payloadB64) {
  const key = getKeyBuffer();
  const buf = Buffer.from(String(payloadB64), 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + AUTH_TAG_LEN);
  const enc = buf.subarray(IV_LEN + AUTH_TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

module.exports = { encryptToken, decryptToken };
