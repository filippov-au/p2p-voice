// Web Push for Workers: VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291), WebCrypto only.
const enc = new TextEncoder();
export const b64u = {
  enc(buf) { let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
  dec(str) { const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4)); return Uint8Array.from(s, c => c.charCodeAt(0)); },
};
const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
const jwkFromRaw = (pub, d) => ({ kty: "EC", crv: "P-256", x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33, 65)), ...(d ? { d } : {}), ext: true });

// opts.salt / opts.asPrivate / opts.asPublic only for test vectors.
export async function encryptPayload(plaintext, p256dh, auth, opts = {}) {
  const uaPub = b64u.dec(p256dh), authSecret = b64u.dec(auth);
  let asPriv, asPub;
  if (opts.asPrivate) {
    asPub = b64u.dec(opts.asPublic);
    asPriv = await crypto.subtle.importKey("jwk", jwkFromRaw(asPub, opts.asPrivate), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  } else {
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    asPriv = kp.privateKey; asPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  }
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPriv, 256));
  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, concat(enc.encode("WebPush: info\0"), uaPub, asPub, new Uint8Array([1])));
  const salt = opts.salt ? b64u.dec(opts.salt) : crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, enc.encode("Content-Encoding: aes128gcm\0\x01"))).slice(0, 16);
  const nonce = (await hmac(prk, enc.encode("Content-Encoding: nonce\0\x01"))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const data = typeof plaintext === "string" ? enc.encode(plaintext) : plaintext;
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(data, new Uint8Array([2]))));
  const rs = 4096, header = new Uint8Array(21);
  header.set(salt); new DataView(header.buffer).setUint32(16, rs); header[20] = asPub.length;
  return concat(header, asPub, ct);
}

export async function vapidAuth(endpoint, { publicKey, privateKey, subject }) {
  const aud = new URL(endpoint).origin;
  const h = b64u.enc(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const c = b64u.enc(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", jwkFromRaw(b64u.dec(publicKey), privateKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${h}.${c}`));
  return `vapid t=${h}.${c}.${b64u.enc(sig)}, k=${publicKey}`;
}

export async function sendPush(sub, payload, vapid, ttl = 3600) {
  const body = await encryptPayload(JSON.stringify(payload), sub.keys.p256dh, sub.keys.auth);
  return fetch(sub.endpoint, { method: "POST", body, headers: {
    Authorization: await vapidAuth(sub.endpoint, vapid), "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream", TTL: String(ttl), Urgency: "high" } });
}
