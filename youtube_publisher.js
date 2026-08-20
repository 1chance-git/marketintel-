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
// A broadcast created with contentDetails.enableAutoStart=true is left
// alone entirely (see maybeTransition below) - verified against production
// that YouTube rejects *both* an API transition call on such a broadcast
// (403 "Invalid transition") *and* rejects turning enableAutoStart off
// after the broadcast has already started receiving a stream (403
// "Modification of enableAutoStart is not allowed in current status"). For
// that case there is nothing safe for this module to do except defer to
// YouTube's own auto-start, which needs a sustained, uninterrupted healthy
// connection to trigger - so avoid redeploying (which restarts FFmpeg and
// resets that connection) once a broadcast is waiting on it.
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
const FETCH_TIMEOUT_MS = 15_000;

// A stalled fetch (network partition, YouTube API hang) would otherwise
// leave tick() in flight indefinitely, silently pausing all polling for a
// process meant to run unattended for weeks - every network call in this
// module goes through this so a hang can't outlast the timeout.
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

let cachedAccessToken = null;
let cachedAccessTokenExpiry = 0;

async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiry - 30_000) {
    return cachedAccessToken;
  }
  const res = await fetchWithTimeout(TOKEN_URL, {
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

// Lists all of the account's broadcasts (mine=true) - callers filter this
// for whatever lifecycle state they care about.
async function listMyBroadcasts(accessToken) {
  // mine and broadcastStatus are mutually exclusive params on this endpoint
  // (YouTube API rejects the combination with "Incompatible parameters" -
  // verified against production) - mine=true alone returns broadcasts across
  // all lifecycle states, which is filtered client-side below anyway.
  const url = `${API_BASE}/liveBroadcasts?part=id,status,contentDetails&mine=true&maxResults=25`;
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new Error(`liveBroadcasts.list failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.items || [];
}

async function transitionBroadcast(accessToken, broadcastId, targetStatus) {
  const url = `${API_BASE}/liveBroadcasts/transition?broadcastStatus=${targetStatus}&id=${encodeURIComponent(broadcastId)}&part=id,status`;
  const res = await fetchWithTimeout(url, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new Error(`liveBroadcasts.transition(${targetStatus}) failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Finds the account's reusable live stream (the "Default stream key" -
// same RTMP destination Railway's YOUTUBE_LIVE_URL already points at, so
// creating a new broadcast here never requires touching that env var).
async function findExistingStreamId(accessToken) {
  const url = `${API_BASE}/liveStreams?part=id&mine=true&maxResults=1`;
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new Error(`liveStreams.list failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.items?.[0]?.id || null;
}

// Creates a fresh broadcast from scratch and binds it to the existing
// stream, instead of trying to keep resuscitating a broadcast whose state
// was left inconsistent by an abrupt encoder disconnect (verified against
// production: a broadcast that straddled a Railway outage never accepted
// any transition, direct or via testing, and never auto-started even after
// several minutes of a genuinely healthy, uninterrupted connection).
// enableMonitorStream and enableAutoStart are both explicitly off so this
// broadcast's lifecycle is driven entirely by our own transition calls -
// ready -> live directly, no testing hop needed, and no auto-start racing
// against us.
async function createFreshBroadcast(accessToken, streamId) {
  const insertRes = await fetchWithTimeout(`${API_BASE}/liveBroadcasts?part=snippet,status,contentDetails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      snippet: {
        title: "LIVE Crypto Market Intelligence | BTC, ETH, SOL & XRP",
        scheduledStartTime: new Date().toISOString(),
      },
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
      contentDetails: {
        enableAutoStart: false,
        enableAutoStop: false,
        enableMonitorStream: false,
        enableDvr: true,
        recordFromStart: true,
      },
    }),
  });
  if (!insertRes.ok) {
    throw new Error(`liveBroadcasts.insert failed: ${insertRes.status} ${await insertRes.text()}`);
  }
  const broadcast = await insertRes.json();

  const bindRes = await fetchWithTimeout(`${API_BASE}/liveBroadcasts/bind?id=${encodeURIComponent(broadcast.id)}&streamId=${encodeURIComponent(streamId)}&part=id,contentDetails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!bindRes.ok) {
    throw new Error(`liveBroadcasts.bind failed: ${bindRes.status} ${await bindRes.text()}`);
  }
  return broadcast.id;
}

// Builds title/description/tags from the real signal that triggered the
// clip - never fixed marketing copy. Falls back to a neutral, non-claim
// default only when a field is genuinely empty, same rule video_clipper.js
// uses for the on-screen overlay text.
function buildShortMetadata({ signal, overlayText }) {
  const hook = overlayText?.[0] || "Market Update";
  const title = `${hook} | Live Terminal Intel`.slice(0, 100);
  const bodyLines = (overlayText || []).slice(0, 3).filter(Boolean);
  const description = [
    ...bodyLines,
    "",
    `Signal timestamp: ${signal?.timestamp || "unknown"}`,
    "Live terminal intel - not financial advice.",
  ].join("\n");
  return {
    snippet: {
      title,
      description,
      tags: ["CryptoMarkets", "MarketIntelligence", "LiveTerminal"],
      categoryId: "28", // Science & Technology
    },
    status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false },
  };
}

// Uploads a rendered short-form clip as an unlisted video for manual
// review before it's ever made public. Uses the multipart/related upload
// protocol Google's API requires (a JSON metadata part followed by the raw
// video bytes) - the web-form-style multipart/form-data that fetch's
// built-in FormData produces is not accepted by this endpoint, so the
// body is built manually.
export async function uploadShort(videoBuffer, { signal, overlayText }) {
  const clientId = process.env.YOUTUBE_OAUTH_CLIENT_ID || null;
  const clientSecret = process.env.YOUTUBE_OAUTH_CLIENT_SECRET || null;
  const refreshToken = process.env.YOUTUBE_OAUTH_REFRESH_TOKEN || null;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("YOUTUBE_OAUTH_CLIENT_ID/YOUTUBE_OAUTH_CLIENT_SECRET/YOUTUBE_OAUTH_REFRESH_TOKEN not configured");
  }

  const accessToken = await getAccessToken({ clientId, clientSecret, refreshToken });
  const metadata = buildShortMetadata({ signal, overlayText });

  const boundary = `yt-upload-${Date.now()}`;
  const metadataPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`;
  const videoPartHeader = `--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`;
  const closing = `\r\n--${boundary}--`;
  const body = Buffer.concat([Buffer.from(metadataPart), Buffer.from(videoPartHeader), videoBuffer, Buffer.from(closing)]);

  const res = await fetch(`${API_BASE}/videos?uploadType=multipart&part=snippet,status`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) {
    throw new Error(`videos.insert failed: ${res.status} ${await res.text()}`);
  }
  const result = await res.json();
  return `https://youtu.be/${result.id}`;
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

  // Once a given broadcast has reached "live" (or is a lost cause we've
  // already logged about), don't keep acting/logging on it every tick - but
  // do keep polling indefinitely so a *new* broadcast (e.g. the next day's)
  // gets picked up automatically too. Bounded so a months-long process can't
  // accumulate these forever: broadcast IDs are short-lived in practice (one
  // per day/session), so a small cap is enough headroom without growing
  // unbounded across weeks of uptime.
  const MAX_TRACKED = 500;
  const alreadyLive = new Set();
  const deferredToAutoStart = new Set();
  const trackBounded = (set, id) => {
    if (set.size >= MAX_TRACKED) {
      set.delete(set.values().next().value);
    }
    set.add(id);
  };

  // Guards against hammering liveBroadcasts.insert every 20s if broadcast
  // creation itself is somehow failing repeatedly (e.g. quota, a bad
  // streamId) - one attempt per minute is plenty for something that should
  // normally succeed on the first try.
  const CREATE_COOLDOWN_MS = 60_000;
  let lastCreateAttemptAt = 0;

  const tick = async () => {
    try {
      const accessToken = await getAccessToken({ clientId, clientSecret, refreshToken });
      const broadcasts = await listMyBroadcasts(accessToken);
      const bound = broadcasts.filter((b) => b.contentDetails?.boundStreamId);

      const liveOne = bound.find((b) => b.status?.lifeCycleStatus === "live");
      if (liveOne) {
        trackBounded(alreadyLive, liveOne.id);
        return;
      }

      // Bug fixed here (caught in review before this shipped further): a
      // deferred/stuck broadcast (enableAutoStart=true, unreachable via the
      // API) still occupies the stream as a bound "ready"/"testing" entry -
      // if it were excluded from *both* this "does anything need a turn"
      // check AND the create-new check below, every tick would see "no
      // candidate" and create ANOTHER new broadcast on top of the stuck one,
      // forever, at 60s intervals - runaway broadcast creation and rapid
      // quota exhaustion (insert+bind cost ~100 quota units per attempt).
      // So: first check whether ANYTHING not-live is bound at all (stuck
      // broadcasts included) - only create a new one if truly nothing is
      // occupying the stream. Only *after* that do we separately exclude
      // deferred ones when picking what to actively transition.
      const anyBoundPending = bound.some((b) =>
        !alreadyLive.has(b.id) &&
        (b.status?.lifeCycleStatus === "ready" || b.status?.lifeCycleStatus === "testing")
      );

      if (!anyBoundPending) {
        // Nothing at all is bound and pending, and nothing is live either -
        // there's genuinely nothing for our healthy RTMP feed to publish
        // to. Create one from scratch rather than waiting indefinitely for
        // a human to make one in Studio.
        if (Date.now() - lastCreateAttemptAt < CREATE_COOLDOWN_MS) {
          return;
        }
        lastCreateAttemptAt = Date.now();
        const streamId = await findExistingStreamId(accessToken);
        if (!streamId) {
          console.error("[YOUTUBE_PUBLISH] No existing live stream found on this account to bind a new broadcast to");
          return;
        }
        console.log(`[YOUTUBE_PUBLISH] No publishable broadcast found - creating a fresh one bound to stream ${streamId}`);
        const newBroadcastId = await createFreshBroadcast(accessToken, streamId);
        console.log(`[YOUTUBE_PUBLISH] Created and bound broadcast ${newBroadcastId} - will transition it to live on a later tick`);
        return;
      }

      const candidate = bound.find((b) =>
        !alreadyLive.has(b.id) &&
        !deferredToAutoStart.has(b.id) &&
        (b.status?.lifeCycleStatus === "ready" || b.status?.lifeCycleStatus === "testing")
      );

      if (!candidate) {
        // Everything currently bound and pending is a known lost cause
        // (already logged about below on the tick it was first seen) -
        // nothing new to do until either it resolves itself or a fresh
        // broadcast created above gets a turn.
        return;
      }

      if (candidate.contentDetails?.enableAutoStart) {
        // Verified against production: YouTube rejects both an API
        // transition call on such a broadcast (403 "Invalid transition")
        // and turning enableAutoStart off after the broadcast has started
        // receiving a stream (403 "enableAutoStartModificationNotAllowed").
        // Nothing safe to do here except wait for YouTube's own auto-start.
        // (Broadcasts this module creates itself always have
        // enableAutoStart=false, so this only applies to broadcasts created
        // outside of this code, e.g. via Studio.)
        if (!deferredToAutoStart.has(candidate.id)) {
          trackBounded(deferredToAutoStart, candidate.id);
          console.log(`[YOUTUBE_PUBLISH] Broadcast ${candidate.id} has enableAutoStart=true, which YouTube won't let us override or transition around via the API - deferring to YouTube's own auto-start (needs a sustained, uninterrupted healthy connection to trigger)`);
        }
        return;
      }

      // YouTube only allows ready -> testing -> live, not ready -> live
      // directly, UNLESS the broadcast has enableMonitorStream=false (as
      // broadcasts created by createFreshBroadcast above always do), in
      // which case ready -> live works directly. For a "ready" broadcast
      // with monitoring enabled (e.g. one created manually via Studio,
      // which defaults it on), hop through "testing" first - the next poll
      // tick will find it there and finish the hop to "live".
      const needsTestingHop = candidate.status.lifeCycleStatus === "ready" && candidate.contentDetails?.enableMonitorStream !== false;
      const targetStatus = needsTestingHop ? "testing" : "live";
      console.log(`[YOUTUBE_PUBLISH] Found broadcast ${candidate.id} in lifeCycleStatus=${candidate.status.lifeCycleStatus} with a bound stream - transitioning to ${targetStatus}`);
      const result = await transitionBroadcast(accessToken, candidate.id, targetStatus);
      if (targetStatus === "live") {
        trackBounded(alreadyLive, candidate.id);
      }
      console.log(`[YOUTUBE_PUBLISH] Transition succeeded: broadcast=${candidate.id} lifeCycleStatus=${result.status?.lifeCycleStatus}`);
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
