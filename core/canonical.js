/**
 * Canonical JSON + digests. Isomorphic: runs in the browser and in Node.
 *
 * Every signed or hashed object goes through canonicalJson() so a signature
 * produced in one runtime verifies in the other. Keys are sorted, insignificant
 * whitespace is dropped, and undefined members are removed. Unicode is kept
 * literal (no \uXXXX escaping) so the ledger stays readable in a diff — the
 * chain hash covers the exact text a human can inspect.
 */

const textEncoder = new TextEncoder();

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('non-finite number cannot be canonicalized');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    out[key] = canonicalize(value[key]);
  }
  return out;
}

export function utf8(input) {
  return textEncoder.encode(input);
}

export async function sha256Hex(input) {
  const data = typeof input === 'string' ? utf8(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(digest));
}

export function toHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** base64url without padding — safe in URLs and in both runtimes. */
export function b64uEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(str) {
  const b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
