// Netlify Function: relay (TURN) credentials for the training room's public drop page (drop.html).
// Only for today's room code: the code is shown as a QR inside the training room only, and changes every day.
//   code = first 10 base32 chars (a-z2-7) of HMAC-SHA256(DROP_SECRET, "beam-drop:" + UTC date YYYY-MM-DD)
// The room PC computes the same code from the same secret.
//
// Environment: DROP_SECRET (the same secret the room PC uses) plus the variables
// turn-credentials.js already uses (TURN_PROVIDER, METERED_* or TURN_*; BEAM_ACCESS_TOKEN if you set one).
const crypto = require("crypto");
const base = require("./turn-credentials");

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function dayCode(secret, day) {
  const buf = crypto.createHmac("sha256", secret).update("beam-drop:" + day).digest();
  let bits = 0, v = 0, out = "";
  for (const b of buf) { v = (v << 8) | b; bits += 8; while (bits >= 5 && out.length < 10) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  return out;
}
function safeEqual(a, b) {
  const ah = crypto.createHash("sha256").update(String(a || "")).digest();
  const bh = crypto.createHash("sha256").update(String(b || "")).digest();
  return crypto.timingSafeEqual(ah, bh);
}

exports.handler = async function (event) {
  const secret = process.env.DROP_SECRET || "";
  if (secret.length < 16) return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: "Set DROP_SECRET in the environment." }) };
  const code = String((event.queryStringParameters || {}).c || "").toLowerCase();
  const now = Date.now();
  // today's code, or yesterday's for the first 6 hours of a UTC day (a QR read just before midnight)
  const days = [new Date(now).toISOString().slice(0, 10)];
  if (new Date(now).getUTCHours() < 6) days.push(new Date(now - 86400000).toISOString().slice(0, 10));
  const ok = days.some((d) => safeEqual(code, dayCode(secret, d)));
  if (!ok) return { statusCode: 401, headers: JSON_HEADERS, body: JSON.stringify({ error: "expired" }) };
  // same credentials as /api/turn, asked for on the caller's behalf (the access token never reaches the phone)
  return base.handler({ httpMethod: "GET", headers: { "x-beam-token": process.env.BEAM_ACCESS_TOKEN || "" } });
};
