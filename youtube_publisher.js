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
//
// Optional env vars, for the post-upload review-email notification
// (sendReviewNotification below) - without these, uploadShort() still
// works, it just skips sending an email:
//   RESEND_API_KEY    - API key from resend.com
//   NOTIFICATION_EMAIL - where to send the "review this Short" email
//   RESEND_FROM_EMAIL  - optional; defaults to Resend's own unverified
//                        sender address, which works without owning/
//                        verifying a domain
// ---------------------------------------------------------------------------

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://www.googleapis.com/youtube/v3";
const FETCH_TIMEOUT_MS = 15_000;
// The videos.insert upload body is a full-length rendered clip, not a JSON
// API call - a real upload can legitimately take well over 15s on a slow
// or congested connection, so it needs its own, longer timeout rather than
// FETCH_TIMEOUT_MS. Still bounded, though: an unbounded fetch here would
// leave a dangling promise forever if the connection genuinely hangs mid
// upload (distinct from just being slow).
const UPLOAD_FETCH_TIMEOUT_MS = 300_000;

// A stalled fetch (network partition, YouTube API hang) would otherwise
// leave tick() in flight indefinitely, silently pausing all polling for a
// process meant to run unattended for weeks - every network call in this
// module goes through this so a hang can't outlast the timeout.
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    const bindErrorText = await bindRes.text();
    // A broadcast that's inserted but never bound is invisible to the
    // "anything bound?" check every other tick does - left alone, it would
    // sit there forever while the 60s creation cooldown lets a fresh one
    // get created and potentially abandoned the same way, repeating
    // indefinitely and burning liveBroadcasts.insert/bind quota (~100 units
    // per attempt). Delete it rather than leak it. A failure here is logged
    // but never allowed to replace/mask the original bind error below - the
    // bind failure is the one callers need to see and react to.
    try {
      const deleteRes = await fetchWithTimeout(`${API_BASE}/liveBroadcasts?id=${encodeURIComponent(broadcast.id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!deleteRes.ok) {
        console.error(`[YOUTUBE_PUBLISH] Cleanup failed: could not delete orphaned broadcast ${broadcast.id} after a failed bind (${deleteRes.status} ${await deleteRes.text()}) - it will need manual deletion in YouTube Studio`);
      }
    } catch (cleanupErr) {
      console.error(`[YOUTUBE_PUBLISH] Cleanup failed: could not delete orphaned broadcast ${broadcast.id} after a failed bind (${cleanupErr.message}) - it will need manual deletion in YouTube Studio`);
    }
    throw new Error(`liveBroadcasts.bind failed: ${bindRes.status} ${bindErrorText}`);
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

const RESEND_API_URL = "https://api.resend.com/emails";

// Notifies the operator by email once a Short is uploaded so it can be
// reviewed from a phone without opening YouTube Studio. Purely additive
// like the OAuth-gated features above: without RESEND_API_KEY and
// NOTIFICATION_EMAIL both set, this logs once and does nothing. A failure
// here is never allowed to make the upload itself look like it failed -
// the video is already live on YouTube (as unlisted) by the time this
// runs, so this only ever logs and swallows its own errors.
async function sendReviewNotification({ title, watchUrl }) {
  const apiKey = process.env.RESEND_API_KEY || null;
  const toEmail = process.env.NOTIFICATION_EMAIL || null;
  if (!apiKey || !toEmail) {
    console.log("[YOUTUBE_PUBLISH] Review email skipped: RESEND_API_KEY/NOTIFICATION_EMAIL not fully configured");
    return;
  }
  const fromEmail = process.env.RESEND_FROM_EMAIL || "MarketIntel Shorts <onboarding@resend.dev>";

  try {
    const res = await fetchWithTimeout(RESEND_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject: `🚨 REVIEW SHORT: ${title}`,
        html: `
          <p>A new unlisted Short just finished uploading and is ready for review.</p>
          <p style="margin: 24px 0;">
            <a href="${watchUrl}" style="display: inline-block; padding: 12px 24px; background: #d02a2a; color: #ffffff; font-weight: bold; text-decoration: none; border-radius: 6px;">
              &#9654; Review on YouTube
            </a>
          </p>
          <p><strong>${watchUrl}</strong></p>
        `,
      }),
    });
    if (!res.ok) {
      throw new Error(`Resend API failed: ${res.status} ${await res.text()}`);
    }
    console.log("[YOUTUBE_PUBLISH] Review email sent");
  } catch (err) {
    console.error(`[YOUTUBE_PUBLISH] Review email failed to send: ${err.message}`);
  }
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

  // Verified against production: a hand-rolled multipart/related body
  // (manual "--boundary\r\nContent-Type...\r\n\r\n..." string concatenation)
  // was rejected by YouTube with 400 "Invalid JSON payload received. Unable
  // to parse number" pointing at the boundary line itself - the framing
  // looked byte-for-byte spec-correct under manual inspection, which is
  // exactly the risk of hand-rolling this instead of using a runtime-
  // guaranteed-correct multipart builder. Using the built-in
  // FormData/Blob here instead: fetch computes a correct boundary and
  // Content-Type itself (never set Content-Type manually when passing a
  // FormData body - doing so would use a wrong/missing boundary param).
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json; charset=UTF-8" }));
  form.append("file", new Blob([videoBuffer], { type: "video/mp4" }));

  const res = await fetchWithTimeout(`${API_BASE}/videos?uploadType=multipart&part=snippet,status`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  }, UPLOAD_FETCH_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`videos.insert failed: ${res.status} ${await res.text()}`);
  }
  const result = await res.json();
  const watchUrl = `https://youtu.be/${result.id}`;

  await sendReviewNotification({ title: metadata.snippet.title, watchUrl });

  return watchUrl;
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

  // Reentrancy guard: tick() chains several sequential network calls, each
  // individually capped at 15s via fetchWithTimeout, but the chain as a
  // whole (token refresh -> list -> maybe create+bind, or list -> transition)
  // can exceed the 20s setInterval period. Without this, two ticks could run
  // concurrently and both observe "nothing bound" before either one acts,
  // both creating a broadcast, or both transitioning the same candidate.
  let tickInProgress = false;

  const tick = async () => {
    if (tickInProgress) {
      console.log("[YOUTUBE_PUBLISH] Skipped: previous tick still in progress");
      return;
    }
    tickInProgress = true;
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
    } finally {
      tickInProgress = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  tick();
  return timer;
}
