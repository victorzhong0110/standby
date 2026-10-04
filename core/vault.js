/**
 * Key vault: the private key on the fan's device, encrypted with a passphrase.
 *
 * A WebCrypto key is extractable here on purpose — it has to be, or the fan
 * could never back it up and losing it would mean losing their whole history.
 * It is therefore wrapped with PBKDF2 + AES-GCM before it touches storage, and
 * the fan is told plainly that the passphrase is the only thing standing
 * between a stolen device file and a forged commitment history.
 *
 * The KDF parameters are stored alongside the ciphertext so a vault stays
 * readable if they are raised later.
 */

import { b64uEncode, b64uDecode } from './canonical.js';

const DEFAULT_KDF = { hash: 'SHA-256', iterations: 310_000, name: 'PBKDF2' };
const SALT_BYTES = 16;
const IV_BYTES = 12;
const VERSION = 1;

async function deriveKey(passphrase, salt, kdf) {
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { ...kdf, salt, iterations: kdf.iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Wrap a private key. Returns a self-describing JSON string safe to store in
 * localStorage or to hand over for backup.
 */
export async function sealPrivateKey(privateKeyB64u, passphrase, { kdf = DEFAULT_KDF } = {}) {
  if (!passphrase || passphrase.length < 8) {
    throw new Error('passphrase must be at least 8 characters');
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, kdf);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    b64uDecode(privateKeyB64u),
  );
  return JSON.stringify({
    v: VERSION,
    kdf: { name: kdf.name, hash: kdf.hash, iterations: kdf.iterations },
    salt: b64uEncode(salt),
    iv: b64uEncode(iv),
    data: b64uEncode(new Uint8Array(ciphertext)),
  });
}

export async function openPrivateKey(vaultJson, passphrase) {
  const vault = typeof vaultJson === 'string' ? JSON.parse(vaultJson) : vaultJson;
  if (vault?.v !== VERSION) throw new Error('unsupported vault version');
  const kdf = { ...DEFAULT_KDF, ...vault.kdf };
  const key = await deriveKey(passphrase, b64uDecode(vault.salt), kdf);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64uDecode(vault.iv) },
      key,
      b64uDecode(vault.data),
    );
    return b64uEncode(new Uint8Array(plain));
  } catch {
    // AES-GCM rejects a wrong passphrase. Do not distinguish "wrong passphrase"
    // from "corrupt file" — both mean the same thing to the caller.
    throw new Error('wrong passphrase, or the vault file is damaged');
  }
}

/** Rough strength read-out for the UI, so the user is warned before choosing. */
export function passphraseStrength(passphrase) {
  const value = String(passphrase ?? '');
  if (!value) return { score: 0, label: '空', advice: '请输入口令' };
  let score = 0;
  if (value.length >= 8) score += 1;
  if (value.length >= 14) score += 1;
  if (value.length >= 20) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/\d/.test(value)) score += 1;
  if (/[^\w\s]/.test(value)) score += 1;
  const labels = ['很弱', '弱', '一般', '较强', '强', '很强', '很强'];
  return {
    score,
    label: labels[score],
    advice: score <= 2
      ? '这个口令保护的是你全部历史站队记录，建议至少 14 位。'
      : '口令强度可以接受。',
  };
}
