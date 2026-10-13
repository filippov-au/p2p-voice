// Generates a VAPID key pair (base64url). Usage: node scripts/gen-vapid.mjs
// Public key -> wrangler.toml [vars] VAPID_PUBLIC_KEY; private key -> `npx wrangler secret put VAPID_PRIVATE_KEY`.
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
const raw = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64url");
const { d } = await crypto.subtle.exportKey("jwk", kp.privateKey);
if (process.argv.includes("--private-only")) process.stdout.write(d);
else console.log(`VAPID_PUBLIC_KEY=${raw}\nVAPID_PRIVATE_KEY=${d}`);
