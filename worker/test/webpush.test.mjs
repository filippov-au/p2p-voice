// RFC 8291 Appendix A test vector + VAPID signature check. Run: node test/webpush.test.mjs
import { encryptPayload, vapidAuth, b64u } from "../src/webpush.js";
import assert from "node:assert";
const out = await encryptPayload("When I grow up, I want to be a watermelon",
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", "BTBZMqHH6r4Tts7J_aSIgg",
  { salt: "DGv6ra1nlYgDCS1FRnbzlw", asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8" });
assert.equal(b64u.enc(out), "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
console.log("RFC 8291 vector: OK");
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = b64u.enc(await crypto.subtle.exportKey("raw", kp.publicKey)), { d } = await crypto.subtle.exportKey("jwk", kp.privateKey);
const hdr = await vapidAuth("https://fcm.googleapis.com/fcm/send/x", { publicKey: pub, privateKey: d, subject: "mailto:a@b.c" });
const [h, c, s] = hdr.match(/t=([^,]+)/)[1].split(".");
assert(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, kp.publicKey, b64u.dec(s), new TextEncoder().encode(`${h}.${c}`)));
assert.equal(JSON.parse(atob(c.replace(/-/g,"+").replace(/_/g,"/"))).aud, "https://fcm.googleapis.com");
console.log("VAPID JWT signature: OK");
