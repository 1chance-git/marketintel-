// ---------------------------------------------------------------------------
// YouTube auto-publish (Block 9)
//
// Pushing a healthy RTMP feed to YouTube never, by itself, makes a broadcast
// public - YouTube's ingest health ("Excellent"/"Good"/"Poor") and the
// broadcast's lifecycle state (created -> ready -> testing -> live) are
// separate systems. Historically this pipeline only did the RTMP push, so
// every broadcast sat in "Preparing stream" until someone opened YouTube
// Studio and clicked "Go Live" by hand - fine for a one-off stream, a
// problem for a pipeline meant to run unattended.
//
// This module closes that gap using the YouTube Data API v3: it polls for
// a broadcast that's bound to a live stream and sitting in a publishable
// lifecycle state (ready/testing), and calls liveBroadcasts.transition to
// take it live automatically. It is entirely additive - if the OAuth
// credentials below aren't configured, this module logs once and does
// nothing, and the pipeline behaves exactly as before (manual Go Live).
//
// Required env vars (Railway service Variables, never committed here):
//   YOUTUBE_OAUTH_CLIENT_ID      - OAuth 2.0 client ID from Google Cloud Console
//   YOUTUBE_OAUTH_CLIENT_SECRET  - matching client secret
//   YOUTUBE_OAUTH_REFRESH_TOKEN  - refresh token for an account with access
//                                  to the channel, scope
//                                  https://www.googleapis.com/auth/youtube
// ---------------------------------------------------------------------------

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://www.googleapis.com/youtube/v3";

let cachedAccessToken = null;
let cachedAccessTokenExpiry = 0;

async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiry - 30_000) {
    return cachedAccessToken;
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`OAuth token refresh failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  cachedAccessToken = data.access_token;
  cachedAccessTokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedAccessToken;
}

// A broadcast is publishable once it has a bound stream (i.e. it's actually
// wired to receive our RTMP feed) and its lifecycle is "ready" or "testing" -
// the two states YouTube allows transitioning to "live" from.
async function findPublishableBroadcast(accessToken) {
  // mine and broadcastStatus are mutually exclusive params on this endpoint
  // (YouTube API rejects the combination with "Incompatible parameters" -
  // verified against production) - mine=true alone returns broadcasts across
  // all lifecycle states, which is filtered client-side below anyway.
  const url = `${API_BASE}/liveBroadcasts?part=id,status,contentDetails&mine=true&maxResults=25`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new Error(`liveBroadcasts.list failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const items = data.items || [];
  return items.find((b) =>
    b.contentDetails?.boundStreamId &&
    (b.status?.lifeCycleStatus === "ready" || b.status?.lifeCycleStatus === "testing")
  ) || null;
}

async function transitionBroadcast(accessToken, broadcastId, targetStatus) {
  const url = `${API_BASE}/liveBroadcasts/transition?broadcastStatus=${targetStatus}&id=${encodeURIComponent(broadcastId)}&part=id,status`;
  const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new Error(`liveBroadcasts.transition(${targetStatus}) failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Starts a background poller that automatically transitions any bound,
// publishable broadcast to "live". Returns the interval timer (or null if
// disabled) so callers can unref it and let the process exit cleanly.
export function startAutoPublish({ intervalMs = 20_000 } = {}) {
  const clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID || null;
  const clientSecret = process.env.YOUTUBE_OAUTH_CLIENT_SECRET || null;
  const refreshToken = process.env.YOUTUBE_OAUTH_REFRESH_TOKEN || null;

  if (!clientId || !clientSecret || !refreshToken) {
    console.log("[YOUTUBE_PUBLISH] Disabled: YOUTUBE_OAUTH_CLIENT_ID/YOUTUBE_OAUTH_CLIENT_SECRET/YOUTUBE_OAUTH_REFRESH_TOKEN not fully configured - broadcasts must be started manually in YouTube Studio");
    return null;
  }

  // Once a given broadcast has reached "live", don't keep retrying it every
  // tick (YouTube would just reject the redundant transition) - but do keep
  // polling indefinitely so a *new* broadcast (e.g. the next day's) gets
  // picked up and published automatically too.
  const alreadyLive = new Set();

  const tick = async () => {
    try {
      const accessToken = await getAccessToken({ clientId, clientSecret, refreshToken });
      const broadcast = await findPublishableBroadcast(accessToken);
      if (!broadcast || alreadyLive.has(broadcast.id)) {
        return;
      }
      // YouTube only allows ready -> testing -> live, not ready -> live
      // directly (verified against production: a direct ready->live call
      // was rejected with 403 "Invalid transition"/invalidTransition). So a
      // broadcast in "ready" needs an intermediate hop to "testing" first;
      // the next tick will find it in "testing" and finish the hop to
      // "live".
      const targetStatus = broadcast.status.lifeCycleStatus === "ready" ? "testing" : "live";
      console.log(`[YOUTUBE_PUBLISH] Found broadcast ${broadcast.id} in lifeCycleStatus=${broadcast.status.lifeCycleStatus} with a bound stream - transitioning to ${targetStatus}`);
      const result = await transitionBroadcast(accessToken, broadcast.id, targetStatus);
      if (targetStatus === "live") {
        alreadyLive.add(broadcast.id);
      }
      console.log(`[YOUTUBE_PUBLISH] Transition succeeded: broadcast=${broadcast.id} lifeCycleStatus=${result.status?.lifeCycleStatus}`);
    } catch (err) {
      // Transient failures (stream health not yet good enough for YouTube to
      // accept the transition, a token refresh hiccup, etc.) are expected and
      // will self-resolve on a later tick - log and keep polling rather than
      // treating this as fatal.
      console.error(`[YOUTUBE_PUBLISH] ${err.message}`);
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  tick();
  return timer;
}
