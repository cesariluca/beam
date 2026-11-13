# Beam

Direct, device-to-device file transfer in the browser. No accounts, no file ever touches a server,
no app to install (though it can be installed as a PWA if you want). Open the page on two devices,
pair them, drag in a file.

> This README describes the app as currently deployed. If your local checkout looks thinner than
> this (no `manifest.webmanifest`, no `icons/`, a simpler pairing screen), run `git pull` — those
> files live on `main` upstream but may not be in your working copy yet.

## What it is

Beam is a static page (`index.html` with its scripts in `js/`, no build step, no inline JavaScript) plus
one small Netlify serverless function (`functions/turn-credentials.js`). Two browsers find each other
through a public signaling service (PeerJS), then open a direct WebRTC connection and stream the file
straight from one device to the other. Netlify never sees the file; the signaling server never sees
the file; nothing is uploaded or stored anywhere. Files stay on your two devices, end to end.

## How it works technically

### 1. Pairing — scan the QR code

The computer opens straight to a large QR code. It encodes a link with a **private 16-character random
code** (80 bits, new every time the page opens). Scan it with the phone's camera app, or with the
**Scan QR code** button inside Beam (handy when Beam is installed as an app), and the two devices link
immediately — no Accept tap, because only someone who can see the screen can have that code. The code is
removed from the phone's address bar once used. **Copy private link** shares the same private code.

Can't scan? Under **Can't scan? Use blocks or a short code** the classic fallback appears: four shapes
(●▲■★) whose order is a 4-digit short code — swipe them into the same order on the other device, or type
the digits. Because only 24 such codes exist, the short code is registered only while that section is
open, and links made through it still need the other side to tap **Accept**.

Either way, both screens then show the same **6-digit verification code** (derived from the connection's
encryption keys); if the two numbers differ, someone is in the middle — disconnect.

Only one active connection is allowed per device — a second incoming connection attempt gets a
`busy` control message and is immediately closed.

### 2. The transfer itself

Once linked, files move as raw binary chunks (64 KB each) over the PeerJS `DataConnection`, framed by
small JSON control messages (`{__ctrl:true, t:"meta"|"end"|"role"|...}`) sent through the same
channel. On top of that:

- **Resumable** — each transfer carries an `xferId`; if the link drops mid-transfer, reconnecting
  resumes rather than restarts.
- **Integrity-checked** — a CRC32 is computed across the whole file and verified by the receiver
  against the value the sender announced.
- **Backpressured** — the sender watches `dataChannel.bufferedAmount` and waits for the
  `bufferedamountlow` event (with a timeout fallback) before queuing more, so a fast sender can't
  overrun a slow receiver.
- **Memory-safe for large files** — above ~150 MB the receiver streams straight to disk via the File
  System Access API (`showSaveFilePicker`) instead of buffering the whole file in memory; smaller
  files still just assemble into a `Blob` and offer a normal download link.
- **Self-healing** — a best-effort `RTCPeerConnection.restartIce()` fires automatically on transient
  disconnects (a brief Wi-Fi hiccup, a NAT rebind), so most short drops recover without the user
  re-entering a code.

Files travel encrypted by WebRTC's standard DTLS transport encryption — that's the browser's one
layer, not an additional application-level layer Beam adds on top.

### 3. Optical (QR) fallback — sending to a phone with no Wi-Fi

Files always go over the connection by default. When a computer is linked to a phone, the computer
also offers **Send by QR broadcast instead**, which shows the file as a rapid loop of
animated, fountain-coded QR frames on-screen instead of sending it over the data channel; the phone's
camera decodes them (via a self-hosted copy of `zxing-wasm`, loaded only when needed) and verifies the CRC.
The already-open WebRTC link is only used to say "here comes a file" and "got it" / "give up" — the
bytes themselves never touch the data channel for this path. Any camera/permission failure falls back
to the connection automatically (and the computer says so), and there's always a "Use Wi-Fi instead"
escape hatch.

### 4. ICE/TURN routing

Three routing modes — `auto`, `relay` (always via TURN), `direct` (STUN only) — persisted in
`localStorage`. In `auto`, the page runs a short ICE probe on load (and periodically, and right after
the OS reports the network came back online) to classify the network as `open` or `restricted` (no
`srflx` candidate ⇒ treated as a restrictive/corporate network) and switches to relay-only
(`iceTransportPolicy:"relay"`) automatically. The same probe backs the manual "Run connectivity test"
diagnostic under **Network & relay**.

### 5. Credentials, never client-held

`index.html` fetches ICE servers from `/api/turn` on load and every 45 minutes, never holding a
long-lived TURN secret client-side. `functions/turn-credentials.js` reads `TURN_PROVIDER` from the
Netlify environment (`coturn`, using short-lived HMAC credentials against `TURN_SECRET`; or `metered`,
minting expiring credentials through Metered's API with `METERED_SECRET_KEY`) and returns a fresh,
short-TTL `{iceServers, ttl}`.
If `BEAM_ACCESS_TOKEN` is set server-side, the function requires a matching `X-Beam-Token` header
(constant-time compared) before it will hand out credentials at all.

### 6. Installable PWA

`manifest.webmanifest` + `sw.js` let the page be added to a phone's home screen or installed as a
standalone desktop app. The service worker only ever caches the static app shell (the page, manifest,
icons) — it deliberately never caches `/api/*` (TURN credentials must always be fetched fresh) or
cross-origin CDN requests.

## Using it

1. Open the site on both devices (same URL).
2. Scan the computer's QR code with the phone (camera app, or **Scan QR code** in Beam) — it links by
   itself. Check that both screens show the same 6-digit code.
3. No camera? Open **Can't scan?** on both devices: swipe the shapes into the order shown on the
   computer (or type the 4 digits), tap **Connect**, then **Accept** on the computer.
4. Once linked, drag a file onto either device — either side can send once paired.
5. To send to a phone with no network, tap **Send by QR broadcast instead** on the computer and hold the
   phone's camera up to the screen.
6. Large incoming files (roughly 150 MB+) will prompt you to choose a save location up front and
   stream to disk as they arrive; smaller files just show a "Save / open" link when done.
7. **Network & relay** (bottom of the page) shows whether you're on an open or restrictive network,
   lets you force a routing mode, and has a one-tap connectivity test for diagnosing a network before
   you rely on it.
8. Optionally, install it: most browsers offer "Add to Home Screen" / "Install app" once the PWA
   manifest loads.

## Deploying your own instance

See [`serverless-setup.md`](serverless-setup.md) for the full walkthrough (Netlify project setup,
`coturn` vs. Metered TURN backends, environment variables, verifying `/api/turn`, and the optional
`BEAM_ACCESS_TOKEN` gate). In short: this is a static site plus one Netlify Function
(`netlify.toml` wires `/api/turn` to it); `_headers` sets the security headers (CSP etc.). The site is
public by design — the Accept prompt and the verification code on both screens protect a link.
`turnserver.conf` is a reference `coturn` config if you're self-hosting the TURN relay rather than
using a managed provider like Metered.

## Repository layout

- `index.html` — markup and styles; `js/app.js` is the client application, `js/config.js` its settings
  (relay endpoint, access token, PeerJS namespace). `drop.html` + `js/drop.js` — the training-room drop page.
- `vendor/zxing-wasm/` — self-hosted QR reader (zxing-wasm 3.1.2, MIT) for the camera transfer.
- `functions/turn-credentials.js` — the Netlify Function behind `/api/turn`.
- `manifest.webmanifest`, `sw.js`, `icons/` — PWA installability.
- `netlify.toml` — publish/functions config and the `/api/turn` redirect.
- `_headers` — security headers (CSP, nosniff, referrer/permissions policy).
- `turnserver.conf` — reference `coturn` config for self-hosting the relay.
- `serverless-setup.md` — full deployment/configuration walkthrough.

There is no build step, test suite, or linter — verify changes by opening the page (or the deployed
URL) in two browser contexts/devices and actually pairing and transferring a file.
