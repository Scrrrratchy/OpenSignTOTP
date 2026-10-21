import crypto from 'node:crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newSecret() {
  const bytes = crypto.randomBytes(20);
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  return bits
    .match(/.{5}/g)
    .map(part => alphabet[parseInt(part, 2)])
    .join('');
}
function decode(secret) {
  const bits = [...secret].map(c => alphabet.indexOf(c).toString(2).padStart(5, '0')).join('');
  return Buffer.from(bits.match(/.{8}/g).map(part => parseInt(part, 2)));
}
export function totp(secret, counter, digits = 6) {
  const time = Buffer.alloc(8);
  time.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  time.writeUInt32BE(counter >>> 0, 4);
  const digest = crypto.createHmac('sha1', decode(secret)).update(time).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}
export function matchCounter(secret, code, now = Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30000);
  for (const counter of [current, current - 1, current + 1]) {
    if (crypto.timingSafeEqual(Buffer.from(totp(secret, counter)), Buffer.from(code)))
      return counter;
  }
  return null;
}
function key(value = process.env.TOTP_ENCRYPTION_KEY) {
  if (!/^[a-fA-F0-9]{64}$/.test(value || ''))
    throw new Error('TOTP_ENCRYPTION_KEY must contain 64 hex characters');
  return Buffer.from(value, 'hex');
}
export function seal(secret, encryptionKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(encryptionKey), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}
export function unseal(value, encryptionKey) {
  const buffer = Buffer.from(value, 'base64');
  const cipher = crypto.createDecipheriv('aes-256-gcm', key(encryptionKey), buffer.subarray(0, 12));
  cipher.setAuthTag(buffer.subarray(12, 28));
  return Buffer.concat([cipher.update(buffer.subarray(28)), cipher.final()]).toString('utf8');
}
export const hashCode = code =>
  crypto.createHash('sha256').update(code.toUpperCase().replace(/\s|-/g, '')).digest('hex');
export function recoveryCodes() {
  return Array.from({ length: 10 }, () => crypto.randomBytes(8).toString('hex').toUpperCase());
}
