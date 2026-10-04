/**
 * Identity: one Ed25519 keypair per fan, held by the fan.
 *
 * The private key never leaves the device. The server — if there ever is one —
 * only ever sees signatures. That is the whole point: a receipt is worth
 * something precisely because nobody else, including whoever runs the site, can
 * mint one on a fan's behalf.
 *
 * Keys are stored as 32 raw bytes in base64url rather than PEM. PEM is a Node
 * format; raw keys are the thing WebCrypto speaks in every runtime, so the
 * browser and the test suite operate on identical bytes.
 *
 * Signatures are domain-separated. The type tag is part of the signed bytes,
 * so a rank-snapshot signature can never be replayed as a stance commitment.
 */

import { canonicalJson, utf8, sha256Hex, b64uEncode, b64uDecode } from './canonical.js';

const DOMAIN = 'fanverify/v2';
const CURVE = { name: 'Ed25519' };

export async function generateIdentity() {
  const pair = await crypto.subtle.generateKey(CURVE, true, ['sign', 'verify']);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    publicKey: b64uEncode(publicRaw),
    privateKey: b64uEncode(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))),
    fingerprint: await fingerprintOf(b64uEncode(publicRaw)),
  };
}

export async function importPrivateKey(privateKeyB64u) {
  const pkcs8 = b64uDecode(privateKeyB64u);
  return crypto.subtle.importKey('pkcs8', pkcs8, CURVE, true, ['sign']);
}

export async function importPublicKey(publicKeyB64u) {
  const raw = b64uDecode(publicKeyB64u);
  return crypto.subtle.importKey('raw', raw, CURVE, true, ['verify']);
}

/**
 * Identity handle that travels on the wire. The fingerprint is a hash of the
 * public key, so it is checkable: give me the key, I recompute this.
 */
export async function fingerprintOf(publicKeyB64u) {
  return `fv2_${(await sha256Hex(utf8(publicKeyB64u))).slice(0, 32)}`;
}

export async function verifyFingerprint(publicKeyB64u, claimedFingerprint) {
  return (await fingerprintOf(publicKeyB64u)) === claimedFingerprint;
}

/** The exact bytes that get signed, including the domain separator. */
export function signingPayload(type, fields) {
  return utf8(`${DOMAIN}/${type}\n${canonicalJson(fields)}`);
}

export async function signFields(type, fields, privateKey) {
  const sig = await crypto.subtle.sign(CURVE, privateKey, signingPayload(type, fields));
  return b64uEncode(new Uint8Array(sig));
}

export async function verifySignature(type, fields, signatureB64u, publicKeyB64u) {
  try {
    const key = await importPublicKey(publicKeyB64u);
    return await crypto.subtle.verify(
      CURVE,
      key,
      b64uDecode(signatureB64u),
      signingPayload(type, fields),
    );
  } catch {
    // A malformed key or signature is a failed verification, never a crash.
    return false;
  }
}
