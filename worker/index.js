// ig-autoposter: a free, self-hosted Instagram scheduler on a Cloudflare Worker.
//
// Every hour (cron):
//   1. refreshes the long-lived Instagram token when it is within 10 days of expiring
//   2. reads manifest.json from your GitHub repo (built by scripts/prepare.py)
//   3. gives every post a date: a pinned date (YYYY-MM-DD__name) wins, the rest fill your
//      weekly rhythm (CADENCE_DAYS at CADENCE_HOUR) in filename order
//   4. publishes anything that is due: its date has passed, or it is today and the hour has come
//   Every post is marked in KV once published, so nothing ever posts twice.
//
// Endpoints:
//   GET /status                    public: account, rhythm, last run, last error, recent history
//   GET /plan[?refresh=1]          public: the computed schedule
//   GET /auth                      connect your Instagram account (open while logged into it)
//   GET /callback                  Instagram sends you back here
//   GET /publish?key=…&enable=1|0  turn auto-publish on or off (starts OFF)
//   GET /publish?key=…&dry=1       preview what would post right now
//   GET /publish?key=…&file=<stem>[&probe=1]   post one item now (probe = let Instagram check it, never post)
//   GET /cadence?key=…[&days=1,3,5&hour=15]    read or change the weekly rhythm
//   GET /tick?key=…                run the hourly job now
//
// Secrets (wrangler secret put …): IG_APP_ID, IG_APP_SECRET, ADMIN_KEY
// Vars (wrangler.jsonc): GITHUB_REPO, GITHUB_BRANCH, TIMEZONE, CADENCE_DAYS, CADENCE_HOUR

const IG = "https://graph.instagram.com";
const SCOPE = "instagram_business_basic,instagram_business_content_publish";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,OPTIONS" };
const J = (o, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });
const HTML = (b, s = 200) => new Response(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:system-ui;padding:32px;text-align:center">${b}</body>`, { status: s, headers: { "content-type": "text/html; charset=utf-8" } });
const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const errText = (e) => (e && e.message ? e.message : String(e));

// ---- config ----
const cfg = (env) => ({
  repo: env.GITHUB_REPO,
  branch: env.GITHUB_BRANCH || "main",
  tz: env.TIMEZONE || "America/New_York",
  days: String(env.CADENCE_DAYS || "1,3,5").split(",").map(Number).filter((d) => d >= 0 && d <= 6),
  hour: Number(env.CADENCE_HOUR ?? 15),
});

// ---- time in your timezone ----
const localDate = (tz, offsetDays = 0) => new Date(Date.now() + offsetDays * 864e5).toLocaleDateString("en-CA", { timeZone: tz });
const localHour = (tz) => Number(new Date().toLocaleString("en-US", { timeZone: tz, hour: "2-digit", hour12: false })) % 24;
const weekdayOf = (ymd) => new Date(ymd + "T12:00:00Z").getUTCDay();
const addDays = (ymd, n) => new Date(new Date(ymd + "T12:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);

// ---- KV helpers ----
async function kvJson(env, key, fallback) { const v = await env.KV.get(key); if (!v) return fallback; try { return JSON.parse(v); } catch (_) { return fallback; } }
async function pushHistory(env, entry) { const h = await kvJson(env, "history", []); h.unshift(entry); await env.KV.put("history", JSON.stringify(h.slice(0, 40))); }
async function recordError(env, where, e) { const entry = { at: new Date().toISOString(), where, message: errText(e).slice(0, 600) }; await env.KV.put("last_error", JSON.stringify(entry)); await pushHistory(env, { ...entry, ok: false }); }
async function getCadence(env) { const c = cfg(env); return { days: c.days, hour: c.hour, ...((await kvJson(env, "cadence", null)) || {}) }; }

// ---- token ----
async function saveToken(env, token, user_id, expires_in) { await env.KV.put("token", JSON.stringify({ token, user_id, expires_at: Date.now() + (expires_in || 5184000) * 1000 })); }
const getToken = (env) => kvJson(env, "token", null);
async function maybeRefresh(env) {
  const t = await getToken(env);
  if (!t || t.expires_at - Date.now() > 10 * 864e5) return;
  const r = await fetch(`${IG}/refresh_access_token?grant_type=ig_refresh_token&access_token=${t.token}`).then((x) => x.json());
  if (!r.access_token) throw new Error("token refresh failed: " + JSON.stringify(r));
  await saveToken(env, r.access_token, t.user_id, r.expires_in);
}

// ---- Instagram login ----
const redirectUri = (req) => new URL("/callback", req.url).toString();
async function handleCallback(env, req) {
  const code = new URL(req.url).searchParams.get("code");
  if (!code) return HTML("<h2>Missing code.</h2><p>Start again at <a href='/auth'>/auth</a>.</p>", 400);
  const form = new URLSearchParams({ client_id: env.IG_APP_ID, client_secret: env.IG_APP_SECRET, grant_type: "authorization_code", redirect_uri: redirectUri(req), code });
  const short = await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", body: form }).then((r) => r.json());
  if (!short.access_token) return HTML(`<h2>Login failed.</h2><p>Restart at <a href='/auth'>/auth</a> (codes work once).</p><pre style="text-align:left">${esc(JSON.stringify(short, null, 2))}</pre>`, 400);
  const long = await fetch(`${IG}/access_token?grant_type=ig_exchange_token&client_secret=${env.IG_APP_SECRET}&access_token=${short.access_token}`).then((r) => r.json());
  await saveToken(env, long.access_token || short.access_token, String(short.user_id), long.expires_in);
  await pushHistory(env, { at: new Date().toISOString(), ok: true, where: "connect", message: `connected (user ${short.user_id})` });
  return HTML("<h2>Connected.</h2><p>Your Instagram account is linked. You can close this tab.</p>");
}

// ---- manifest → schedule ----
async function loadManifest(env, fresh) {
  if (!fresh) { const c = await kvJson(env, "manifest_cache", null); if (c) return c.items || []; }
  const { repo, branch } = cfg(env);
  if (!repo) throw new Error("set GITHUB_REPO in wrangler.jsonc");
  const tries = [
    { url: `https://api.github.com/repos/${repo}/contents/manifest.json?ref=${branch}`, headers: { accept: "application/vnd.github.raw+json" } },
    { url: `https://raw.githubusercontent.com/${repo}/${branch}/manifest.json`, headers: {} },
  ];
  let last = null;
  for (const t of tries) {
    try {
      const r = await fetch(t.url, { headers: { "user-agent": "ig-autoposter", ...t.headers }, cf: { cacheTtl: 0 } });
      if (r.status === 404) return [];
      if (!r.ok) throw new Error(`manifest ${r.status}`);
      const j = await r.json();
      await env.KV.put("manifest_cache", JSON.stringify(j));
      return j.items || [];
    } catch (e) { last = e; }
  }
  const c = await kvJson(env, "manifest_cache", null);
  if (c) return c.items || [];
  throw last;
}
const isVideo = (u) => /\.(mp4|mov|m4v)(\?|$)/i.test(u || "");
// Pinned dates win. Everything else fills the next open rhythm slot, in filename order.
// Deterministic: the same manifest always produces the same schedule.
async function schedule(env, fresh = false) {
  const { tz } = cfg(env);
  const cad = await getCadence(env);
  const out = [], taken = new Set();
  for (const it of (await loadManifest(env, fresh)).filter((x) => x && x.url)) {
    const stem = String(it.stem);
    const e = { stem, url: it.url, children: Array.isArray(it.children) ? it.children : null, caption: it.caption || "",
      type: it.type === "CAROUSEL" ? "CAROUSEL" : it.type === "REEL" || isVideo(it.url) ? "REEL" : "IMAGE",
      date: /^\d{4}-\d{2}-\d{2}$/.test(it.date || "") ? it.date : null, posted: (await env.KV.get("posted_" + stem)) || null };
    if (e.date) taken.add(e.date);
    out.push(e);
  }
  // The timing window: if today's posting hour has not passed yet, today is still a candidate slot.
  let d = localHour(tz) <= cad.hour ? localDate(tz) : localDate(tz, 1);
  for (const e of out) {
    if (e.date || e.posted) continue;
    for (let i = 0; i < 400; i++, d = addDays(d, 1)) {
      if (cad.days.includes(weekdayOf(d)) && !taken.has(d)) { e.date = d; taken.add(d); d = addDays(d, 1); break; }
    }
  }
  return out.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
}
// Due = not posted, and its date is in the past, or it is today and the posting hour has arrived.
// Items more than 2 days late are skipped instead of flooding your feed after an outage.
async function dueItems(env, items) {
  const { tz } = cfg(env);
  const cad = await getCadence(env);
  const today = localDate(tz), hour = localHour(tz);
  return items.filter((e) => !e.posted && e.date && (e.date < today || (e.date === today && hour >= cad.hour)) && e.date >= localDate(tz, -2));
}

// ---- Instagram publishing ----
const post = (url, params) => fetch(url, { method: "POST", body: new URLSearchParams(params) }).then((x) => x.json());
async function waitReady(id, token, tries = 30) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await fetch(`${IG}/${id}?fields=status_code,status&access_token=${token}`).then((x) => x.json());
    if (last.status_code === "FINISHED") return last;
    if (last.status_code === "ERROR" || last.status_code === "EXPIRED") throw new Error("container " + last.status_code + ": " + JSON.stringify(last));
    await new Promise((r) => setTimeout(r, 8000));
  }
  throw new Error("container not ready: " + JSON.stringify(last));
}
async function buildContainer(token, e) {
  if (e.type === "CAROUSEL") {
    const urls = (e.children || []).filter(Boolean);
    if (urls.length < 2 || urls.length > 10) throw new Error(`carousel needs 2 to 10 slides, got ${urls.length}`);
    const ids = [];
    for (const u of urls) {
      const r = await post(`${IG}/me/media`, isVideo(u) ? { is_carousel_item: "true", media_type: "VIDEO", video_url: u, access_token: token } : { is_carousel_item: "true", image_url: u, access_token: token });
      if (!r.id) throw new Error("slide: " + JSON.stringify(r));
      await waitReady(r.id, token);
      ids.push(r.id);
    }
    const r = await post(`${IG}/me/media`, { media_type: "CAROUSEL", children: ids.join(","), caption: e.caption, access_token: token });
    if (!r.id) throw new Error("carousel: " + JSON.stringify(r));
    return r.id;
  }
  const params = e.type === "REEL"
    ? { media_type: "REELS", video_url: e.url, share_to_feed: "true", caption: e.caption, access_token: token }
    : { image_url: e.url, caption: e.caption, access_token: token };
  const r = await post(`${IG}/me/media`, params);
  if (!r.id) throw new Error("container: " + JSON.stringify(r));
  return r.id;
}
// mode: "publish" | "dry" | "probe" (probe builds the post and lets Instagram check it, but never publishes)
async function publishItem(env, e, mode) {
  if (mode === "publish" && (await env.KV.get("posted_" + e.stem))) return { stem: e.stem, skipped: "already posted" };
  if (mode === "dry") return { stem: e.stem, date: e.date, type: e.type, dry: true };
  try {
    const t = await getToken(env);
    if (!t) throw new Error("Instagram not connected: open /auth");
    const cid = await buildContainer(t.token, e);
    await waitReady(cid, t.token);
    if (mode === "probe") return { stem: e.stem, probe: true, note: "Instagram accepted it; nothing was posted" };
    const pub = await post(`${IG}/me/media_publish`, { creation_id: cid, access_token: t.token });
    if (!pub.id) throw new Error("publish: " + JSON.stringify(pub));
    const link = (await fetch(`${IG}/${pub.id}?fields=permalink&access_token=${t.token}`).then((x) => x.json()).catch(() => ({}))).permalink || null;
    await env.KV.put("posted_" + e.stem, pub.id);
    await pushHistory(env, { at: new Date().toISOString(), ok: true, where: "publish", message: `${e.date} ${e.type} ${e.stem} published`, permalink: link });
    return { stem: e.stem, published: pub.id, permalink: link };
  } catch (err) {
    await recordError(env, `publish:${e.stem}`, err);
    return { stem: e.stem, error: errText(err) };
  }
}

async function autoPublish(env, mode = "publish") {
  if (mode === "publish" && (await env.KV.get("publish_enabled")) !== "1") return { skipped: "auto-publish is off (turn on with /publish?key=…&enable=1)" };
  const items = await schedule(env, true);
  const results = [];
  for (const e of await dueItems(env, items)) results.push(await publishItem(env, e, mode));
  return { due: results.length, results };
}
async function runTick(env) {
  const { tz } = cfg(env);
  const out = { at: new Date().toISOString(), local: `${localDate(tz)} ${String(localHour(tz)).padStart(2, "0")}:00` };
  try { await maybeRefresh(env); } catch (e) { await recordError(env, "refresh", e); }
  try { out.publish = await autoPublish(env); } catch (e) { out.publish = { error: errText(e) }; await recordError(env, "tick", e); }
  await env.KV.put("last_run", JSON.stringify(out));
  return out;
}
async function status(env) {
  const { tz, repo } = cfg(env);
  const t = await getToken(env);
  let next = [];
  try { next = (await schedule(env)).filter((e) => !e.posted).slice(0, 5).map((e) => ({ date: e.date, type: e.type, stem: e.stem })); } catch (e) { next = [{ error: errText(e) }]; }
  return {
    app_configured: !!(env.IG_APP_ID && env.IG_APP_SECRET), connected: !!t, token_expires: t ? new Date(t.expires_at).toISOString() : null,
    auto_publish: (await env.KV.get("publish_enabled")) === "1", repo, timezone: tz, now: `${localDate(tz)} ${String(localHour(tz)).padStart(2, "0")}:00`,
    cadence: await getCadence(env), next, last_run: await kvJson(env, "last_run", null), last_error: await kvJson(env, "last_error", null),
    history: (await kvJson(env, "history", [])).slice(0, 12),
  };
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (u.pathname === "/" || u.pathname === "/status") return J(await status(env));
    if (u.pathname === "/plan") { try { return J({ cadence: await getCadence(env), items: await schedule(env, u.searchParams.get("refresh") === "1") }); } catch (e) { return J({ error: errText(e) }, 500); } }
    if (u.pathname === "/auth") {
      if (!env.IG_APP_ID) return HTML("<h2>Set the IG_APP_ID and IG_APP_SECRET secrets first.</h2>", 400);
      const p = new URLSearchParams({ client_id: env.IG_APP_ID, redirect_uri: redirectUri(req), response_type: "code", scope: SCOPE });
      return Response.redirect(`https://www.instagram.com/oauth/authorize?${p}`, 302);
    }
    if (u.pathname === "/callback") return handleCallback(env, req);

    const key = u.searchParams.get("key") || req.headers.get("x-admin-key");
    if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return J({ error: "unauthorized" }, 401);
    try {
      if (u.pathname === "/tick") return J(await runTick(env));
      if (u.pathname === "/publish") {
        const en = u.searchParams.get("enable");
        if (en === "1" || en === "0") { await env.KV.put("publish_enabled", en); return J({ auto_publish: en === "1" }); }
        const mode = u.searchParams.get("dry") === "1" ? "dry" : u.searchParams.get("probe") === "1" ? "probe" : "publish";
        const file = u.searchParams.get("file");
        if (file) {
          const e = (await schedule(env, true)).find((x) => x.stem === file);
          return e ? J(await publishItem(env, e, mode)) : J({ error: "no item with that stem" }, 404);
        }
        return J(await autoPublish(env, mode));
      }
      if (u.pathname === "/cadence") {
        const days = u.searchParams.get("days"), hour = u.searchParams.get("hour");
        if (days || hour) {
          const c = await getCadence(env);
          if (days) c.days = days.split(",").map(Number).filter((d) => d >= 0 && d <= 6);
          if (hour) c.hour = Math.min(23, Math.max(0, Number(hour) || 0));
          await env.KV.put("cadence", JSON.stringify(c));
        }
        return J({ cadence: await getCadence(env) });
      }
      return J({ error: "not found" }, 404);
    } catch (e) { await recordError(env, u.pathname, e); return J({ error: errText(e) }, 500); }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(runTick(env)); },
};
