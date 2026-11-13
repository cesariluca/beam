/* No credentials live here. The page asks the serverless function below for
   short-lived TURN credentials at runtime. The long-term secret stays on the
   server (a Netlify environment variable) and never reaches the browser. */
window.BEAM_RELAY_ENDPOINT = "/api/turn";
// Prefix for this deployment's IDs on the public PeerJS server. The 4-block
// pairing code alone has only 24 values, shared with every PeerJS app in the
// world; a per-deployment prefix keeps other PeerJS apps and casual users out
// of our codes. The page is public, so this is not a secret: the Accept prompt
// and the on-screen verification code are what stop a deliberate hijack.
// Changing it unlinks devices running an older copy of the page until they reload.
window.BEAM_PEER_NAMESPACE = "beam-982801e9c02956d5";
// Optional: if you set BEAM_ACCESS_TOKEN in the function's environment,
// put the SAME VALUE here so the page can authenticate to /api/turn.
// Leave empty to keep the endpoint open. The page is public, so this only
// stops naive scripted use of /api/turn; it is not a secret.
window.BEAM_ACCESS_TOKEN = "b9f8c91731632800334cf6c65219a13fba12aed119fd6f92";
