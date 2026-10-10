# OpenVibe.Food

> What should we eat?

**Status:** the product works — food near you, a meal planner, the food database and the pantry are live and tested.
Delivery comparison and recipes from the network's AI (the manifests' other pillars) are not built yet.

**Domain:** `openvibe.food` · **Port:** 4970 · **Service id:** `food` · **Env prefix:** `FOOD`
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

OpenVibe.Food answers "what should we eat?" for a household. It finds food banks, soup kitchens, community fridges,
free pantry boxes and budget grocery stores near a place (OpenStreetMap), plans a shop within a budget and renders the
shopping list with an estimated cost, carries a food database with nutrition and typical price bands, and keeps a
pantry with a deterministic "what can I make". Everything is server-rendered and works without JavaScript.

## What it does

| Piece | Where | What it does |
|---|---|---|
| Food near you | [/near](server/http/pages.js), [server/food/places.js](server/food/places.js) | A place name or coordinates → the food banks, soup kitchens, community fridges, free pantry boxes and budget grocery stores around it, from OpenStreetMap through Overpass, with distance, address, opening hours and a link back to the object |
| Meal planner | [/plan](server/http/pages.js), [server/food/planner.js](server/food/planner.js) | One person, a couple or a group, 1–14 days: one item from each of the six USDA MyPlate food groups, cheapest per gram first, then the best calories a dollar, with a shopping list, the cheapest store per line and an estimated cost. Deterministic, and a budget is a hard cap |
| Food database | [/foods, /foods/:slug](server/http/pages.js), [server/food/foods.js](server/food/foods.js) | 42 items with nutrition per serving and per 100 g, the typical price band and the chain-by-chain comparison; server-rendered and in the sitemap |
| Pantry | [/pantry](server/http/pages.js), [server/food/pantry-match.js](server/food/pantry-match.js) | Signed in, keep what is in your cupboard and see which basic recipes you can make now, and what one more item would unlock. Deterministic; no model call |
| The OpenStreetMap client | [server/food/upstream.js](server/food/upstream.js) | The only outbound calls this service makes: paced, cached, identified, bounded |
| Store | [server/food/store.js](server/food/store.js), [migrations/](migrations/) | `food_geo_cache`, `food_plans`, `food_pantry` |
| Platform | the skeleton | Sign-in with OpenVibe.Network, the OpenVibe Frame, limits, readiness, discovery, deploy files |

Everything is server-rendered and works without JavaScript: the search is a GET form, saving a plan and a cupboard is
a plain POST, and every page is complete as it leaves the server.

## Owns

Its own PostgreSQL tables, created by [migrations/](migrations/) and written by nothing else:

- `food_geo_cache` (0002) — every Nominatim geocode and Overpass answer, with its TTL, so OSM is asked once for a place
  and not once per visitor.
- `food_plans` (0002) — a saved meal plan, exactly as the planner returned it, with its spec beside it.
- `food_pantry` (0002) — what one person says is in their cupboard, one row per food in the list.
- `account_data_events` (0003) — the receipts of the ADR-033 account export and deletion deliveries this service
  applied, so a redelivered event changes nothing.

0001 creates no tables. The service is the authority for these rows and for nothing else.

## Does not own

- **Identity and accounts** — OpenVibe.Network: sign-in (OAuth client `food`, PKCE S256), the signing keys (JWKS) and
  the canonical subject. Food holds only `user:usr_…` on its own rows.
- **Event delivery** — OpenVibe.Events: Food receives `network.account.export_requested` and `network.account.deleted`
  and creates its two subscriptions at boot; it does not own the topics or the delivery.
- **The place and store data** — OpenStreetMap through Nominatim and Overpass, © OpenStreetMap contributors under
  ODbL 1.0; Food is a cached, attributed reader.
- **The food list, its prices and its nutrition** — carried over from OpenVibe.Tools' grocery source, not authored or
  live here.

## Depends on

- **OpenVibe.Network** — SSO sign-in and JWKS verification, and the internal routes a part or a confirmation is pushed
  to (`OV_NETWORK_URL`, `OV_NETWORK_INTERNAL_URL`, `OV_OAUTH_CLIENT_ID`, `OV_OAUTH_CLIENT_SECRET`, `FOOD_AUDIENCE`).
- **OpenVibe.Events** — the two account subscriptions created at boot (`FOOD_EVENTS_URL` or `EVENTS_URL`,
  `FOOD_EVENTS_SECRET`, `FOOD_EVENTS_ENDPOINT`).
- **Nominatim and Overpass** (OpenStreetMap, the only two hosts it fetches) — `FOOD_NOMINATIM_URL`,
  `FOOD_OVERPASS_URL`, `FOOD_OSM_USER_AGENT`, `FOOD_OSM_MIN_INTERVAL_MS`, `FOOD_OSM_TIMEOUT_MS`,
  `FOOD_GEO_CACHE_TTL_MS`.
- **PostgreSQL** (`DATABASE_URL`, `DATABASE_DIRECT_URL`) and **Valkey** for shared limit counters (`VALKEY_URL`,
  `VALKEY_PREFIX`).
- **Packages**: `openvibe-contracts` v0.122.1, `openvibe-sdk` v0.42.0 (`db`, `auth`, `account-data`, `limits`,
  `valkey`, `service`) and `openvibe-shared` v3.0.1 (`frame`, `legal`, `serve`, `release`, `metrics`, `ready`,
  `seo`, `shell`, `cache-policy`, `showcase`, `app-icon`).

## Capabilities

The service manifest (`food`, openvibe-contracts) lists four, and [server/http/principal.js](server/http/principal.js)
declares the same four:

- `food.plan.read` — read the plans a caller saved
- `food.plan.write` — save a plan
- `food.pantry.read` — read a caller's pantry
- `food.pantry.write` — replace a caller's pantry

An app, agent or service token needs the one a route names; a person acting for themself needs no capability. The
public routes (`/places`, `/foods`) name none. Food calls no capability on another service.

## API

| Route | Who | |
|---|---|---|
| `GET /api/v1/ping` | anyone | `{ ok: true, service: "food" }` |
| `GET /api/v1/places?q=&kind=foodbank\|grocery\|both[&lat=&lon=&radius=&limit=]` | anyone | food near a place; every answer carries the ODbL attribution |
| `GET /api/v1/foods[?group=&q=]` | anyone | the food list |
| `GET /api/v1/foods/:slug` | anyone | one food, with the chain-by-chain prices |
| `POST /api/v1/plans` | signed in | plan and save: `{ people, days, budget?, title? }` → 201 with the plan |
| `GET /api/v1/plans`, `GET /api/v1/plans/:id` | signed in | your plans, newest first |
| `GET /api/v1/pantry` | signed in | your cupboard, with the "what can I make" suggestions |
| `PUT /api/v1/pantry` | signed in | replace it: `{ items: ["eggs-dozen", …] }` |

Public reads need no token. A person's own data (a plan, a pantry) needs a signed-in caller; an app, agent or service
token needs the route's capability (`food.plan.read|write`,
`food.pantry.read|write` — [server/http/principal.js](server/http/principal.js)). A write made with the session cookie
must come from `openvibe.food` itself. Errors are RFC 9457 `application/problem+json` with a stable `code`.

**Per-caller limits** ([server/http/caller-limits.js](server/http/caller-limits.js)): reads take `FOOD_LIMITS_MINUTE` /
`FOOD_LIMITS_HOUR`; the place search, which spends OpenStreetMap's shared request budget, has its own tighter numbers,
as do saving a plan and replacing a pantry.

## Data sources and their terms

**OpenStreetMap** (food banks, stores) — [openstreetmap.org](https://www.openstreetmap.org/) © OpenStreetMap
contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Read from
[Nominatim](https://nominatim.org/) (a place name → coordinates) and the [Overpass API](https://overpass-api.de/)
(the database). Both have published usage policies, and this service stays inside them:

- it identifies itself with `FOOD_OSM_USER_AGENT` (`OpenVibeFood/0.1 (+https://openvibe.food)`), never a browser's;
- it makes **at most one request a second per host** — calls to the same host queue behind each other, so the service
  cannot burst at Nominatim however many visitors arrive at once;
- it **caches every answer** in `food_geo_cache` for 7 days (`FOOD_GEO_CACHE_TTL_MS`): a place is geocoded once and an
  area is queried once, not once per visitor;
- it only ever asks for a small radius around a point (`around:`), never a bulk download, and never fetches a URL a
  caller typed;
- the attribution and the ODbL link appear on every page that shows a result, and in every API answer.

**The food list and its prices** — carried over unchanged from OpenVibe.Tools' grocery source
(`OpenVibe.Tools/apps/maps/server/sources/grocery.js`), where the food tools live today: typical 2025 US (Washington)
prices for five budget chains and the USDA MyPlate groups. They are a band to plan by, **never a live price**. The
Walmart page scraping that source also did is deliberately not ported: this service never scrapes a retail site.

**Nutrition** — the same source's typical values per serving. "Per 100 g" is arithmetic on the pack size stated in an
item's own name divided by its servings (for example a 15 oz can with 3.5 servings is 121 g a serving). Where a name
states no weight — a dozen eggs, a 12-pack of ramen — no per-100 g figure is given rather than a density guessed.
The nutrition figures are the source's, not analysed here, and are not dietary advice.

**Recipes** — ten simple combinations written for this service in plain words, using only items from the food list.
No copied recipe text. They are labelled "basic suggestions" wherever they appear.

## Configuration

See [.env.example](.env.example). Required in production: `OV_OAUTH_CLIENT_SECRET` (the `food` OAuth client on the
Network), `BASE_URL`, `DATABASE_URL` and `DATABASE_DIRECT_URL`. `FOOD_NOMINATIM_URL` and `FOOD_OVERPASS_URL` default
to the public OSM hosts; tests point them at a stand-in and never reach the internet.

## Development

```bash
npm install
fnm exec --using=22 npm test        # every test/*.test.js, on temp PGlite databases with a mock Network
fnm exec --using=22 npm run dev     # http://localhost:4970
```

Without `DATABASE_URL` development uses an embedded PGlite database in `data/pglite` (one process only). `npm run
test:pg` runs the same suite through PostgreSQL and PgBouncer (see [.github/workflows/ci.yml](.github/workflows/ci.yml)).

## Acceptance

`npm test` runs every `test/*.test.js` in its own process on a temp PGlite database with a mock Network;
`npm run test:pg` runs the same suite through PostgreSQL and PgBouncer. No test reaches the internet — the OSM tests
point at a stand-in ([test/helpers/osm.js](test/helpers/osm.js)). The main files:

- [test/places.test.js](test/places.test.js) — the place search end to end against a stand-in OSM: results and ODbL
  attribution, one request a second per host, the 7-day cache, escaping of a hostile OSM name, the search's budget.
- [test/plan.test.js](test/plan.test.js) — the planner's arithmetic (deterministic, all six groups, a budget is a cap)
  and saving a plan for the person who asked.
- [test/foods.test.js](test/foods.test.js) — the food list, the per-100 g arithmetic and its pages and sitemap entries.
- [test/pantry.test.js](test/pantry.test.js) — the pantry kept per account, the deterministic "what can I make", and
  anonymous callers refused.
- [test/account-data.test.js](test/account-data.test.js) — ADR-033 export and deletion through `/internal/events`,
  applied once and carrying only that person's rows, with a bad signature refused.
- [test/caller-limits.test.js](test/caller-limits.test.js), [test/auth-jwks.test.js](test/auth-jwks.test.js),
  [test/security-secrets.test.js](test/security-secrets.test.js), [test/security-session.test.js](test/security-session.test.js),
  [test/open-redirect.test.js](test/open-redirect.test.js), [test/no-internal-key.test.js](test/no-internal-key.test.js),
  [test/discovery.test.js](test/discovery.test.js), [test/layout.test.js](test/layout.test.js),
  [test/service-kit.test.js](test/service-kit.test.js), [test/nginx-auth-limit.test.js](test/nginx-auth-limit.test.js),
  [test/perf-budget.test.js](test/perf-budget.test.js), [test/asset-cache.test.js](test/asset-cache.test.js) — limits,
  auth, secret-leak and redirect regressions, crawl artifacts, page layout, graceful stop, nginx zones and size
  budgets.

## Deploy (for the lead)

- **Deploy:** `sudo ovhost deploy food` on the host (git checkout at `/opt/openvibe.food`, unit
  `openvibe-food.service` on 127.0.0.1:4970, env `/etc/openvibe/food.env`, database `ov_food` on the data role).
- **nginx:** [deploy/nginx/openvibe.food.conf](deploy/nginx/openvibe.food.conf), installed with `ov-vhost-install`.
- **Rollback:** ovhost puts the previous sha back by itself when `/api/ready` does not answer after the restart.
- Register the service and its capabilities in **OpenVibe.Contracts** (`contracts-service: food` in CI) and with
  **OpenVibe.Services** before the first deploy.

## Account export and deletion

A person's account at OpenVibe.Network can be exported and deleted, and every service holding their rows answers its
part (ADR-033). Food receives `network.account.export_requested` and `network.account.deleted` at `POST /internal/events`
(loopback only) — the two tables are mapped in [server/identity/account-data.js](server/identity/account-data.js), and
the boot-time subscriptions are created by [server/events-consumer.js](server/events-consumer.js):

- **Exported:** the plans a person saved (`plans.json`) and their pantry (`pantry.json`), pushed to
  `POST /internal/account-exports/:id/parts` with this service's own token. Nothing here is a secret — Food stores no
  token, key or credential.
- **Erased:** both tables hold the person's own rows and nothing anyone else's page hangs under them, so they are
  deleted whole and nothing is kept. Food then confirms with `POST /internal/account-deletions/:id/confirmations` and
  the counts.
- **Anonymized:** nothing. There is no row Food keeps that was written by this person for another person to read.

The Nominatim/Overpass cache (`food_geo_cache`) is keyed by the query, not by a person, and is neither exported nor
erased.

Environment: `FOOD_EVENTS_SECRET` (comma-separated for rotation, 32+ characters each; unset makes the route answer
503), `FOOD_EVENTS_URL` (or `EVENTS_URL`) is where the two subscriptions are created at boot (off when unset), and
`FOOD_EVENTS_ENDPOINT` overrides the loopback endpoint; `FOOD_EVENTS_SUBSCRIBE=0` turns the boot-time subscription off.

## Security (threat notes)

Reporting a vulnerability: [SECURITY.md](SECURITY.md).

- Session tokens are httpOnly cookies; a FedCM assertion or an app or service token is never a session.
- Secrets live only in the env file; only environment variable names appear in code and docs, and no secret is logged.
- Request bodies are never logged.
- The only two hosts this service fetches are the OSM ones named in the configuration: a URL built from that base, and
  nothing a caller sends. A place name is data in a query string, never a URL.
- Nothing a person keeps here (a plan, a pantry) is public, cached or crawled.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).

<!-- versions:start -->
- openvibe-contracts: v0.129.0
- openvibe-sdk: v0.42.0
- openvibe-shared: v3.0.1
<!-- versions:end -->
