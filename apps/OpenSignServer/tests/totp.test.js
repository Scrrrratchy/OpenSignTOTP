import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newSecret,
  totp,
  matchCounter,
  seal,
  unseal,
  recoveryCodes,
  hashCode,
} from '../utils/totpCrypto.js';

test('RFC 6238 SHA-1 reference vectors', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  for (const [time, expected] of [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ]) {
    assert.equal(totp(secret, Math.floor(time / 30), 8), expected);
  }
});
test('six digits, bounded clock drift and malformed input', () => {
  const secret = newSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  const counter = 123456;
  const now = counter * 30000;
  assert.equal(matchCounter(secret, totp(secret, counter), now), counter);
  assert.equal(matchCounter(secret, totp(secret, counter - 1), now), counter - 1);
  assert.equal(matchCounter(secret, totp(secret, counter + 1), now), counter + 1);
  assert.equal(matchCounter(secret, '12345', now), null);
  assert.equal(matchCounter(secret, 123456, now), null);
  assert.equal(matchCounter(secret, 'abcdef', now), null);
});
test('authenticated encryption, key validation and recovery code normalization', () => {
  process.env.TOTP_ENCRYPTION_KEY = 'ab'.repeat(32);
  const secret = newSecret();
  const encrypted = seal(secret);
  assert.notEqual(encrypted, secret);
  assert.equal(unseal(encrypted), secret);
  const tampered = Buffer.from(encrypted, 'base64');
  tampered[30] ^= 1;
  assert.throws(() => unseal(tampered.toString('base64')));
  process.env.TOTP_ENCRYPTION_KEY = 'cd'.repeat(32);
  assert.throws(() => unseal(encrypted));
  process.env.TOTP_ENCRYPTION_KEY = '';
  assert.throws(() => seal(secret), /TOTP_ENCRYPTION_KEY/);
  const codes = recoveryCodes();
  assert.equal(new Set(codes).size, 10);
  assert.equal(hashCode(codes[0]), hashCode(codes[0].toLowerCase()));
});
