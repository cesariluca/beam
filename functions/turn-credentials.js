// Netlify Function: returns short-lived TURN credentials as an ICE servers array.
// The long-term secret stays here (a Netlify environment variable) and is never
// sent to the browser — the page only ever receives temporary credentials.
//
// Choose a backend with the TURN_PROVIDER env var: "coturn" (default) or "metered".
//
//   coturn  (your own server, using use-auth-secret):
//     TURN_PROVIDER = coturn
//     TURN_HOST     = turn.yourdomain.com          (FQDN on the TLS cert, no scheme/port)
//     TURN_SECRET   = <same value as coturn's static-auth-secret>
//     TURN_TTL      = 3600                          (optional, seconds; default 3600)
//
//   metered  (managed service; mints expiring credentials through Metered's API):
//     TURN_PROVIDER      = metered
//     METERED_APP_DOMAIN = yourapp.metered.live      (your Metered app domain, no scheme)
//     METERED_SECRET_KEY = <Secret Key from the dashboard's Developers page>
//     METERED_DOMAIN     = standard.relay.metered.ca (FREE plan; use global.relay.metered.ca only on paid plans)
//     TURN_TTL           = 3600                       (optional)

const crypto = require("crypto");

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
  // No Access-Control-Allow-Origin: the page only ever calls this endpoint
  // same-origin (via the netlify.toml redirect). Don't add "*" back - that
  // would let any origin mint TURN credentials from here.
};

// Constant-time string compare (avoids timing leaks on the token). Both sides are
// hashed to a fixed-size digest first so the comparison time never varies with the
// caller-supplied token's length, not just its content.
function safeEqual(a, b) {
  const ah = crypto.createHash("sha256").update(String(a || "")).digest();
  const bh = crypto.createHash("sha256").update(String(b || "")).digest();
  return crypto.timingSafeEqual(ah, bh);
}

exports.handler = async function (event) {
  // CORS preflight (kept for compatibility; no ACAO header is returned - see above).
  if (event && event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: Object.assign({}, JSON_HEADERS, {
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "X-Beam-Token"
      }),
      body: ""
    };
  }

  // Optional endpoint auth: if BEAM_ACCESS_TOKEN is set, require a matching header.
  const need = process.env.BEAM_ACCESS_TOKEN;
  if (need) {
    const h = (event && event.headers) || {};
    const got = h["x-beam-token"] || h["X-Beam-Token"] || "";
    if (!safeEqual(got, need)) {
      return { statusCode: 401, headers: JSON_HEADERS, body: JSON.stringify({ error: "unauthorized" }) };
    }
  }

  const provider = (process.env.TURN_PROVIDER || "coturn").toLowerCase();
  const ttlRaw = parseInt(process.env.TURN_TTL || "3600", 10);
  const ttl = (Number.isFinite(ttlRaw) && ttlRaw > 0) ? ttlRaw : 3600;

  try {
    if (provider === "metered") {
      return await metered(ttl);
    }
    return coturn(ttl);
  } catch (err) {
    // Details go to the function log only: upstream errors can embed request URLs
    // (and the Metered call carries the secret key in its query string).
    console.error("turn-credentials:", err);
    return {
      statusCode: 502,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: "relay credential provider unavailable" })
    };
  }
};

// --- coturn: time-limited HMAC credential (TURN REST API / use-auth-secret) ---
function coturn(ttl) {
  const host = process.env.TURN_HOST;
  const secret = process.env.TURN_SECRET;
  if (!host || !secret) {
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: "Set TURN_HOST and TURN_SECRET (coturn) in the environment." })
    };
  }
  const expiry = Math.floor(Date.now() / 1000) + ttl;
  const username = expiry + ":beam";
  const credential = crypto.createHmac("sha1", secret).update(username).digest("base64");

  const iceServers = [
    { urls: "turns:" + host + ":443?transport=tcp", username, credential },
    { urls: "turn:"  + host + ":443?transport=tcp", username, credential },
    { urls: "turn:"  + host + ":3478",              username, credential }
  ];
  return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ iceServers, ttl }) };
}

// --- metered: expiring credential minted via Metered's REST API ---
// Never hands out a long-lived credential: each one is created with a hard expiry.
// Metered says a new credential can take up to ~2 minutes to propagate, so this
// warm instance reuses one for all callers while it still has at least `ttl`
// seconds left (it's minted with 2*ttl of life), instead of minting per request.
let meteredCache = null; // { user, pass, expiresAt (ms) }

function cleanHost(v) {
  return String(v || "").trim().replace(/^\w+:\/\//, "").replace(/[:/].*$/, "");
}

async function meteredCredential(ttl) {
  const now = Date.now();
  if (meteredCache && meteredCache.expiresAt - now >= ttl * 1000) return meteredCache;

  const appDomain = cleanHost(process.env.METERED_APP_DOMAIN);
  const secretKey = process.env.METERED_SECRET_KEY;
  if (!appDomain || !secretKey) return null;

  const life = ttl * 2;
  const res = await fetch(
    "https://" + appDomain + "/api/v1/turn/credential?secretKey=" + encodeURIComponent(secretKey),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expiryInSeconds: life, label: "beam" })
    }
  );
  if (!res.ok) throw new Error("Metered credential API returned HTTP " + res.status);
  const data = await res.json();
  if (!data || !data.username || !data.password) throw new Error("Metered credential API returned no credential");
  meteredCache = { user: data.username, pass: data.password, expiresAt: now + life * 1000 };
  return meteredCache;
}

async function metered(ttl) {
  // Free plan → standard.relay.metered.ca. Paid plans can use global.relay.metered.ca.
  const domain = cleanHost(process.env.METERED_DOMAIN || "standard.relay.metered.ca");
  const cred = await meteredCredential(ttl);
  if (!cred) {
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: "Set METERED_APP_DOMAIN and METERED_SECRET_KEY in the environment." })
    };
  }
  const user = cred.user, pass = cred.pass;
  const iceServers = [
    { urls: "stun:" + domain + ":80" },
    { urls: "turn:"  + domain + ":80",                username: user, credential: pass },
    { urls: "turn:"  + domain + ":80?transport=tcp",  username: user, credential: pass },
    { urls: "turn:"  + domain + ":443",               username: user, credential: pass },
    { urls: "turns:" + domain + ":443?transport=tcp", username: user, credential: pass }
  ];
  return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ iceServers, ttl }) };
}
