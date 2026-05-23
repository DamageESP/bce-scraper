// Uses Web Crypto (subtle) so it runs in both Node and the Edge runtime
// the Next.js middleware uses. No `node:crypto` import.

const COOKIE_NAME = "bde_crm_session";
const SEVEN_DAYS = 7 * 24 * 60 * 60;

function secret(): string {
  return (
    process.env.SESSION_SECRET ??
    process.env.APP_PASSWORD ??
    "fallback-secret-please-set-SESSION_SECRET"
  );
}

const enc = new TextEncoder();

async function importKey(material: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(material),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : "0" + hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

async function sign(payload: string): Promise<string> {
  const key = await importKey(secret());
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return toHex(sig);
}

export async function buildSessionCookieValue(): Promise<string> {
  const payload = `v1.${Date.now()}`;
  const mac = await sign(payload);
  return `${payload}.${mac}`;
}

export async function verifySessionCookieValue(
  value: string | undefined,
): Promise<boolean> {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [v, ts, mac] = parts;
  if (v !== "v1") return false;
  const issued = Number(ts);
  if (!Number.isFinite(issued)) return false;
  if (Date.now() - issued > SEVEN_DAYS * 1000) return false;
  const key = await importKey(secret());
  const sigBytes = fromHex(mac);
  // Copy into a fresh ArrayBuffer so TS narrows the BufferSource correctly
  // (Uint8Array<ArrayBufferLike> isn't assignable to BufferSource in TS 5.6).
  const sigBuf = new ArrayBuffer(sigBytes.byteLength);
  new Uint8Array(sigBuf).set(sigBytes);
  return crypto.subtle.verify(
    "HMAC",
    key,
    sigBuf,
    enc.encode(`${v}.${ts}`),
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function checkPassword(input: string): boolean {
  const expected = process.env.APP_PASSWORD;
  if (!expected || !input) return false;
  return constantTimeEqual(expected, input);
}

export { COOKIE_NAME, SEVEN_DAYS };
