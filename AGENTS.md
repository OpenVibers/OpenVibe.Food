# AGENTS.md — OpenVibe.Food

## Project Overview

OpenVibe.Food answers "what should we eat?" for a household. It finds food banks, soup kitchens, community fridges,
free pantry boxes and budget grocery stores near a place (OpenStreetMap), plans a shop within a budget, carries a food
database with nutrition and typical prices, keeps a pantry with a deterministic "what can I make", and adds barcode,
photo/receipt and AI recipe features. It also follows FDA food recalls from OpenVibe.Sources, compares delivery apps
by opening their own searches, keeps a shared meal plan with a household Chat room, and runs a reviewed recipe library.

- **Domain:** `openvibe.food` · **Port:** 4970 · **Service id:** `food` · **Env prefix:** `FOOD`
- **Runtime:** Node 22, Express 4, PostgreSQL 18 through `openvibe-sdk/db` (PGlite in development/tests), Valkey 9 for
  shared limits.
- **Read first:** [README.md](README.md), [STATUS.json](STATUS.json), [.env.example](.env.example).

**Network context:** identity/accounts are OpenVibe.Network (OAuth client `food`, PKCE S256). Place data is
OpenStreetMap (Nominatim/Overpass, ODbL, attributed); barcode products are Open Food Facts (ODbL, only the barcode is
sent, answers cached a day); FDA recalls, BLS average prices, USDA ERS prices and Open Food Facts product rows are
read from OpenVibe.Sources. AI recipe ideas and pantry-photo recognition call OpenVibe.AI
(`food.suggest_recipes`, `food.read_pantry_photo`). Household chat creates a room through OpenVibe.Chat and reads it
through `food.household.read`. Checked recipes are OpenVibe.Search documents. Event delivery is OpenVibe.Events. Food
stores no accounts, no money and no third-party data beyond the cached public rows.

## Commands

```bash
npm ci                         # install (contracts/sdk/shared/publishing pinned by tag)
npm run dev                    # http://localhost:4970, PGlite under data/pglite
npm start                      # node server/index.js
npm test                       # every test/*.test.js on temp PGlite, mock Network/AI/Sources, no internet
npm run test:pg                # the same through PostgreSQL + PgBouncer
npm test -- pantry             # only test files whose name contains the word
node --check <file.js>         # syntax check (no linter configured)
```

No build step: pages are server-rendered; assets [public/css/](public/css/) and [public/js/](public/js/)
(`barcode-scan.js`, `pantry-photo.js`). Every page works without JavaScript; the barcode/photo pages are the only
camera-assisted paths.

## Architecture at a Glance

- **Entry:** [server/index.js](server/index.js) — listener, telemetry/retention, the Events subscriptions, the recipe
  library, Search index, recall/price/Open-Food-Facts followers and the "food near" warm-up; graceful stop. `FOOD_DRILL`
  keeps boot-time work off.
- **App factory:** [server/app.js](server/app.js) — CSP, SSO, `/auth`, `/internal/events`, `/internal/households/:id/chat-context`,
  static/`/shared`, the share API, `/api/v1`, agent layer, pages, 404/error handler.
- **Config:** [server/config.js](server/config.js) — `load(env)` is pure; production `/etc/openvibe/food.env`.
- **Product logic:** [server/food/](server/food/) — `foods.js`, `planner.js`, `pantry-match.js`, `recipes.js`,
  `library.js`, `recalls.js`, `official-prices.js`, `usda-prices.js`, `off.js`, `barcode.js`, `places.js`,
  `upstream.js` (the only OSM client), `delivery.js`, `household-chat.js`, `box-links.js`, `search-index.js`,
  `sharing.js`, `store.js`, `near-warm.js`.
- **HTTP:** [server/http/](server/http/) — `api.js`, `pages.js`, `library-routes.js`, `recall-pages.js`,
  `box-pages.js`, `principal.js`, `caller-limits.js`, `router.js`, `discovery.js`.
- **Auth/account data:** [server/auth/sso.js](server/auth/sso.js), [server/auth/keys.js](server/auth/keys.js),
  [server/identity/account-data.js](server/identity/account-data.js).
- **Rendering:** [server/render/](server/render/) (`layout.js`, `html.js`, `markdown.js`, `short.js`), agent twins
  [server/agent-pages.js](server/agent-pages.js), [server/agent-descriptor.js](server/agent-descriptor.js).
- **Database:** [server/db.js](server/db.js) and [migrations/](migrations/): `food_geo_cache`, `food_plans`,
  `food_pantry`, `account_data_events`, `food_recipe_suggestions`, `telemetry_samples`, `food_library_recipes`,
  `food_library_runs`, `food_recalls`, `food_ingest_cursor`, `food_off_products`, `food_official_prices`,
  `food_usda_prices`, sharing tables and the household/plan share rows.
- **Deploy:** [deploy/systemd/openvibe-food.service](deploy/systemd/openvibe-food.service) (127.0.0.1:4970,
  `/etc/openvibe/food.env`, `/opt/openvibe.food`, database `ov_food`) and
  [deploy/nginx/openvibe.food.conf](deploy/nginx/openvibe.food.conf) (TLS, www→apex, auth/API/forms zones, 4 MB on the
  photo route, `/internal` and `/metrics` closed). `sudo ovhost deploy food`; rollback on a failed `/api/ready`.

## Ownership and Boundaries

Food owns its plans, pantry, recipe suggestions/library, recall rows and cursor, cached OSM/price/Open-Food-Facts data,
share rows and event receipts. It is **not** the authority for identity (Network), place/store data (OSM), products
(Open Food Facts), recall/price source records (Sources), AI output (AI), the wallet (Network), Chat rooms (Chat), the
search index (Search) or event delivery (Events). The food list, prices and nutrition are carried from Tools' grocery
source, not authored here. Food never calls the FDA, never fetches a delivery app, and never returns raw rows.

## Auth and Capabilities

- A person is the session cookie or a Network user token; a cookie-authenticated write must come from
  `openvibe.food` itself. Per-caller limits are in [server/http/caller-limits.js](server/http/caller-limits.js)
  (`FOOD_LIMITS_MINUTE`/`HOUR`); the place search has a tighter budget, recipe suggestions 10/person/day.
- Capabilities (Contracts): `food.plan.read|write`, `food.pantry.read|write`, `food.recipes.suggest` (proposed), and
  the internal `food.household.read` granted to Chat. Public reads (`/places`, `/foods`) need none. A service token
  needs the route's capability; a person acting for themself needs none.
- Food calls **no** capability on another service for its public reads. Outbound: OSM, and the named OpenVibe
  services (Network, Events, AI, Sources, Chat, Search, Coupons/Reviews for a food box's codes/score).
- Errors are RFC 9457 problem+json with stable `food.*` codes. With `OV_AI_INTERNAL_URL` unset, recipe ideas answer
  503 `food.ai_off`; a photo outside the AI/pantry limits is refused before upload.

## Pages and API

Pages: `/`, `/near`, `/plan`, `/plans/p/:id`, `/foods`, `/foods/:slug`, `/pantry`, `/pantry/barcode`, `/pantry/photo`,
`/recipes`, `/recipes/library`, `/recalls`, `/recalls/:number`, `/delivery`, `/updates`, plus discovery (`/llms.txt`,
sitemap, robots, Markdown twins) and `/openapi.json`.
API `/api/v1`: `GET /ping`, `GET /places`, `GET /foods[/:slug]`, `POST /plans`, `GET /plans[/:id]`, `GET /pantry`,
`PUT /pantry`, `POST /recipes/suggest`, `GET /recipes`; the one Share sheet's API
(`/api/v1/plans/:id/share`, requests/transfer, `/share/people`, `/shared-with-me`). `/internal/events` is loopback;
`/internal/households/:id/chat-context` is loopback + `food.household.read`; `/api/health`, `/api/ready`,
`/release.json`, `/metrics` are machine endpoints.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; no linter/formatter. Async handlers through
  [server/http/router.js](server/http/router.js); never log request bodies or a person's photo/pantry content.
- New schema = a new `migrations/NNNN_name.sql`; never edit one that has run. Keep `food_` prefixes (plus the shared
  `account_data_events`/`telemetry_samples`/share tables).
- **The only outbound clients** are [server/food/upstream.js](server/food/upstream.js) (Nominatim + Overpass — paced
  once a second per host, identified with `FOOD_OSM_USER_AGENT`, cached `FOOD_GEO_CACHE_TTL_MS`, bounded, stale
  fallback, ODbL attribution on every answer) and the named OpenVibe service clients. Never fetch a user URL (a
  delivery link, a listing, an image).
- AI output is validated against the food list and priced with Food's own typical prices; it is labelled
  AI-suggested. A photo sends only the picture to AI; AI keeps the photo's hash, and a receipt's prices/card/store
  details are never read out.
- Barcode: only the barcode is sent to Open Food Facts with Food's User-Agent; the picture never leaves the device;
  answers cached a day and capped. A person confirms the match before anything is added.
- Recalls are shown exactly as Sources holds the report, with openFDA's note (unvalidated, not for medical decisions,
  no FDA endorsement); `/recalls/:number` is noindex because the source's registry entry asks.
- Delivery pages open each app's own search in a new tab — Food fetches none of them and shows no invented prices or
  fees. The meal planner is deterministic and a budget is a hard cap.
- CSP: add origins to `helmet` in [server/app.js](server/app.js). Phone first: every page fits 390 px; no Font
  Awesome (shared glyphs).
- "Calm reduces, only Off removes": a household/share preference reduces visibility; only an explicit delete removes.
- Empty states use the shared kit; plans/about pages must show real content first (no placeholders).

## Key Pitfalls

- **OSM policy:** one request a second per host, a contact User-Agent, cached answers, an around-query bound, and
  attribution. A test points the client at a stand-in; a real call in a test is a bug
  ([test/places.test.js](test/places.test.js), [test/helpers/osm.js](test/helpers/osm.js)).
- **A household plan's Chat room** is created as the owner through Chat's room API, with members added by subject and
  the AI member linked to the plan; Chat reads the plan through `food.household.read` (loopback, service token). Never
  read a Chat room directly or post as the AI yourself.
- **Recipe library:** one theme every six hours; every ingredient must be a food slug or the recipe is dropped; only
  staff-checked recipes are indexable; `/recipes/library.json?since=` (oldest first, ≤100) is Blog's feed.
- **Search documents** are written through `openvibe-publishing/search-relay`; a hide/unpublish writes a tombstone.
  The library's AI text is labelled and noindex until checked.
- **Photo route** allows 4 MB at nginx and resizes to 1280 px on the device first; ten photos a person a day. Do not
  raise either without the owner's decision.
- **Account export/deletion** runs through `/internal/events` only, is signature-verified and idempotent; the export
  carries the person's plans/pantry/suggestions and the deletion erases them (shared plans stay for the others).
- **Drill mode** (`FOOD_DRILL`) keeps the OSM warm-up, followers, library, search sync and timers off.
- A **share** is revoked by the owner immediately; `canView` is checked on every read path, not only the share route.

## Testing

`npm test` runs each file in its own process on temp PGlite with a mock Network and fixture OSM/AI/Sources: places and
attribution, planner arithmetic and budget cap, food pages/sitemap, pantry and deterministic matches, recipes/AI
validation/limits, barcode, Open Food Facts, official/USDA prices, recalls, recipe library and Search, household chat,
sharing, boxes, delivery links, account data, SSO/JWKS, limits, secret-leak/session/redirect, layout, cache, nginx
zones and perf budgets. `npm run test:pg` for PostgreSQL. Run the narrowest file first, then the suite; always
`node --check` changed files.

## Documentation

- [README.md](README.md) — purpose, what it does, owns/does-not-own, dependencies, capabilities, API, data sources and
  their terms, configuration, development, acceptance, deploy, account data, security.
- [STATUS.json](STATUS.json) — stage, deployed flag, features and not-yet list.
- [.env.example](.env.example) — variable names only.
- [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md).
