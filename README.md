# ig-autoposter

A free, self-hosted Instagram auto-poster. Drop photos, reels or carousels into a GitHub folder and they post themselves on your schedule. No paid scheduling service.

It runs on two free pieces:

- **GitHub** holds your posts. A GitHub Action makes every file Instagram-ready (crops, resizes, re-encodes video) and writes `manifest.json`.
- **A Cloudflare Worker** wakes up every hour, reads the manifest, works out what is due, and publishes it through the official Instagram API.

Built by Denzel Rigaud ([@thewatercheck](https://www.instagram.com/thewatercheck/)), who runs it for two of his own Instagram accounts.

## How you schedule a post

Put files in `images/` and push.

| You add | It posts |
|---|---|
| `images/sunset.jpg` | a photo |
| `images/sunset.txt` | (optional) the caption for `sunset.jpg` |
| `images/launch.mp4` | a reel |
| `images/my-carousel/` with 2 to 10 images + `caption.txt` | one carousel, slides in filename order |
| `2026-11-03__anything.jpg` or `2026-11-03__my-carousel/` | pins that exact date |

Captions can also come from `plan.json` (`{"posts":[{"file":"sunset","date":"2026-11-03","caption":"…"}]}`) or rotate from `captions.txt` for anything without one.

## How the timing works

This is the part worth reading.

1. **Every post gets a date.** A pinned date (`YYYY-MM-DD__name`) always wins. Everything else fills the next open slot of your weekly rhythm (`CADENCE_DAYS` at `CADENCE_HOUR`), in filename order. The same files always produce the same schedule, so nothing reshuffles between runs.
2. **The hourly check.** A post is due when its date has passed, or it is today and the posting hour has arrived. If today's hour has not passed yet, today still counts as an open slot.
3. **No double posts.** Once Instagram confirms a post, its name is marked in KV storage and it is never sent again, even if the run is repeated.
4. **No flood after downtime.** Anything more than 2 days late is skipped, so an outage never dumps a week of posts at once.
5. **Self-healing.** A failed hour just retries on the next hour. The access token refreshes itself 10 days before it expires.

Pinned dates ignore the weekly rhythm, so you can post daily by pinning each day.

## Setup (about 20 minutes)

You need: a GitHub account, a free Cloudflare account, Node.js, and an Instagram **Business or Creator** account.

1. **Copy this repo** to your own GitHub (Use this template, or fork). Keep it **public**, because Instagram fetches your images from it.
2. **Make a Meta app:** at [developers.facebook.com](https://developers.facebook.com/apps) create an app, add the **Instagram** product with **Instagram Login** (the "API setup with Instagram login" flow), and note the **Instagram app ID** and **app secret**. Add your Instagram account as a tester (or take the app live).
3. **Deploy the worker:**
   ```bash
   cd worker
   npx wrangler login
   npx wrangler kv namespace create KV        # paste the id into wrangler.jsonc
   npx wrangler secret put IG_APP_ID
   npx wrangler secret put IG_APP_SECRET
   npx wrangler secret put ADMIN_KEY          # any long random string, your password for admin links
   npx wrangler deploy
   ```
   Set `GITHUB_REPO`, `TIMEZONE`, `CADENCE_DAYS` and `CADENCE_HOUR` in `wrangler.jsonc` first.
4. **Allow the login redirect:** in the Meta app's Instagram Login settings, add `https://<your-worker>.workers.dev/callback` as a valid OAuth redirect URI.
5. **Connect Instagram:** open `https://<your-worker>.workers.dev/auth` while logged into the Instagram account and approve.
6. **Turn it on:** open `https://<your-worker>.workers.dev/publish?key=<ADMIN_KEY>&enable=1`. It starts **off**, so nothing posts until you say so.

Check it any time at `/status` (account, next posts, last run, errors, recent history) and `/plan` (the full schedule).

## Handy admin links

All need `?key=<ADMIN_KEY>`:

- `/publish?dry=1`: what would post right now, without posting
- `/publish?file=<name>&probe=1`: let Instagram check one post (format, size, URL) without publishing it
- `/publish?file=<name>`: post one item right now
- `/cadence?days=1,3,5&hour=15`: change the weekly rhythm without redeploying
- `/tick`: run the hourly job now

## Limits worth knowing

- Instagram caps how many posts an account can publish through the API in 24 hours; check Meta's current limit if you post a lot.
- Feed images must be between 4:5 and 1.91:1; `prepare.py` crops to fit. Carousels take 2 to 10 slides.
- Instagram downloads your media from the public `raw.githubusercontent.com` URLs, so the repo must stay public. Don't put anything private in it.
- The schedule uses one Instagram account per worker. For a second account, deploy a second copy with its own name.

## License

MIT. Use it, change it, share it.
