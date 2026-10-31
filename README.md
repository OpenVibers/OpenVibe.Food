# OpenVibe.Food

> What should we eat?

**Status:** the product works — food near you, a meal planner, the food database, the pantry, recipe ideas from the network's AI and plan together (a saved plan shared with a household, with a shopping list everyone ticks off) are live and tested.
Delivery is compared the permitted way: one search opens every delivery app's own search (`/delivery`), with the meal kits side by side; prices and fees stay on each app, where the person is signed in.

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
| Pantry by barcode | [/pantry/barcode](server/http/pages.js), [server/food/barcode.js](server/food/barcode.js), [public/js/barcode-scan.js](public/js/barcode-scan.js) | Type a product's barcode, or scan it with the camera where the browser can read barcodes (the picture stays on the device). Open Food Facts names the product, and Food matches it to the item on its list it is (peanut butter is not butter, apple juice is not apples). The person confirms or picks another item before anything is added. Only the barcode is sent, with Food's User-Agent; answers are cached a day and capped at `FOOD_BARCODE_PER_MINUTE` (60) |
| Pantry by photo or receipt | [/pantry/photo](server/http/pages.js), [public/js/pantry-photo.js](public/js/pantry-photo.js) | A photo of a cupboard, fridge or shelf, or a grocery receipt. The page makes it at most 1280 px on the device. OpenVibe.AI (`food.read_pantry_photo`) names the items from Food's list it clearly shows, and the person ticks what to add (unsure ones start unticked). AI keeps only the photo's hash; a receipt's prices, card and store details are never read out. Ten photos a person a day; nginx allows 4 MB on this one route |
| Recipe ideas | [/recipes](server/http/pages.js), [server/food/recipes.js](server/food/recipes.js) | Signed in, ask OpenVibe.AI's `food.suggest_recipes` workflow for ideas from your pantry; Food validates the answer against its own food list and prices the to-buy items from its typical prices. Clearly labelled AI-suggested |
| Recipe library | [/recipes/library](server/http/library-routes.js), [server/food/library.js](server/food/library.js) | Every six hours the next of 35 themes goes to `food.suggest_recipes` with an empty cupboard, so every ingredient must be a food from the list (a recipe with anything else is dropped); Food prices what to buy from its typical prices. Labelled as written by AI, noindex until a member of staff marks one checked (then indexed with Recipe JSON-LD and in the sitemap); staff can hide one. `/recipes/library.json?since=` lists the published ones added since a time (oldest first, up to 100): OpenVibe.Blog's budget-recipes desk reads it. Checked recipes are OpenVibe.Search documents (owner `food`, type `recipe`) through Search's owner API ([server/food/search-index.js](server/food/search-index.js), `FOOD_SEARCH_URL`, `search.document.write`) |
| Food recalls | [/recalls](server/http/recall-pages.js), [server/food/recalls.js](server/food/recalls.js) | The FDA's food enforcement reports, read from OpenVibe.Sources (source `openfda-food-enforcement`, category `food`, `sources.item.read`): Food follows Sources' change feed hourly from its cursor (`openvibe-publishing/ingest`) and keeps each recall as the report states it (product, reason, company, class, status, where it was sold, dates). `/recalls` filters by words, class and the company's state; `/recalls/:number` is one recall (noindex, as the source's registry entry asks). Every page carries openFDA's note: unvalidated, not for medical decisions, no FDA endorsement. Food never calls the FDA; `OV_SOURCES_INTERNAL_URL` (default `http://127.0.0.1:4720`, empty turns it off) |
| Food boxes | [/boxes, /boxes/:slug, /boxes/compare](server/http/box-pages.js), [server/food/boxes.js](server/food/boxes.js), [server/food/box-links.js](server/food/box-links.js) | Every meal kit, ready-meal service and food box (produce, meat and fish, snacks, coffee, baby, pets), weekly or monthly, side by side: 38 of them in 8 kinds, a tab per kind, diets as chips, a search row, a box's plans, what its stated price comes to for your plan size, and boxes side by side. Each fact was read on the service's own public pages by a person and carries that page and the day (2026-10-28); nothing is fetched from the services (the 2026-09-28 rule), and a fact nobody checked says so. A box shows its codes from OpenVibe.Coupons and its score from OpenVibe.Reviews (read from their public APIs on the loopback, 10 minutes, 1.5 s at most; off unless `FOOD_COUPONS_URL`/`FOOD_REVIEWS_URL` are set outside production), and links to OpenVibe.Watch for its prices. The same data is `GET /api/v1/boxes`, `/boxes/:slug` and `/boxes/:slug/cost`. |
| Delivery, compared | [/delivery](server/http/pages.js), [server/food/delivery.js](server/food/delivery.js) | One query opens DoorDash, Uber Eats, Grubhub, Seamless, Caviar and Instacart's own searches in new tabs (URL forms checked in a real browser on 2026-10-15; Postmates is Uber Eats now, Gopuff, Slice and ezCater have no stable search link). Meal kits and prepared meals (EveryPlate, Dinnerly, HelloFresh, Home Chef, Marley Spoon, Blue Apron, Hungryroot, Green Chef, Purple Carrot, Factor) by tier, each with its plans page and an OpenVibe.Watch link for price changes. Food fetches none of them; published per-serving prices conflict between sources, so none are shown |
| The OpenStreetMap client | [server/food/upstream.js](server/food/upstream.js) | Paced, cached, identified, bounded. With the Open Food Facts barcode lookup (one product read per barcode, cached a day; data under the Open Database License, credited on the page), these are the only outbound calls besides OpenVibe's own services |
| Household chat | [/plan/p/:id](server/http/pages.js), [server/food/household-chat.js](server/food/household-chat.js) | The owner of a shared plan starts a private room on OpenVibe.Chat for the household, made through Chat's room API as the owner, with every member added by account subject (and anyone who joins later, when the owner opens the plan) and **Pantry**, an AI member linked to the plan. Writing `@pantry` there asks it: Chat reads the household from `GET /internal/households/:id/chat-context` (`food.household.read`, Chat's service token) — the plan, what is still to buy and every member's cupboard — and OpenVibe.AI answers. The plan's page links the room for everyone |
| Store | [server/food/store.js](server/food/store.js), [migrations/](migrations/) | `food_geo_cache`, `food_plans`, `food_pantry`, `food_recipe_suggestions` |
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
- `food_recipe_suggestions` (0004) — a person's recipe ideas from OpenVibe.AI (the validated output plus Food's own
  to-buy costs), keeping the last 20 per person.
- `telemetry_samples` (0006) — request telemetry (openvibe-sdk 0.46, `platform.telemetry-sample@1`): each HTTP request by
  route template, method and status class, never raw URL; one `http.request` sample a minute per key plus active-
  requests, p95 latency and event-loop-lag gauges; `/shared`, static assets, health, readiness and `/metrics` excluded;
  rows older than 14 days deleted daily ([server/app.js](server/app.js) mounts it, [server/index.js](server/index.js) flushes and prunes).

- `food_library_recipes`, `food_library_runs` (0007) — the recipe library: each kept recipe with its ingredients (food
  list slugs), steps, what to buy and its typical cost, the AI run, and who checked it; one row per theme run.

- `food_recalls`, `food_ingest_cursor` (0009) — the FDA's food recall reports as OpenVibe.Sources holds them, one row
  per recall number, and the cursor in Sources' change feed. Public domain data; nothing about a person.

- `food_off_products` (0011) — Open Food Facts products matched to the list, one row per product code with the label
  figures, the food slug they label and the Sources item and revision they came from. ODbL data, credited on the food
  page; nothing about a person ([migrations/0011_open_food_facts.sql](migrations/0011_open_food_facts.sql)).

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
- **OpenVibe.AI** — the `food.suggest_recipes` workflow for recipe ideas from a pantry (`OV_AI_INTERNAL_URL`, plus
  Food's OAuth client id and secret; the feature is off when `OV_AI_INTERNAL_URL` is unset).
- **Nominatim and Overpass** (OpenStreetMap, the only two hosts it fetches) — `FOOD_NOMINATIM_URL`,
  `FOOD_OVERPASS_URL`, `FOOD_OSM_USER_AGENT`, `FOOD_OSM_MIN_INTERVAL_MS`, `FOOD_OSM_TIMEOUT_MS`,
  `FOOD_GEO_CACHE_TTL_MS`.
- **PostgreSQL** (`DATABASE_URL`, `DATABASE_DIRECT_URL`) and **Valkey** for shared limit counters (`VALKEY_URL`,
  `VALKEY_PREFIX`).
- **Packages**: `openvibe-contracts` v0.122.1, `openvibe-sdk` v0.74.0 (`db`, `auth`, `account-data`, `limits`,
  `valkey`, `service`), `openvibe-publishing` (`ai`) and `openvibe-shared` v4.19.0 (`frame`, `legal`, `serve`,
  `release`, `metrics`, `ready`, `seo`, `shell`, `cache-policy`, `showcase`, `app-icon`).

## Capabilities

The service manifest (`food`, openvibe-contracts) lists four, and [server/http/principal.js](server/http/principal.js)
declares the same four plus one proposed:

- `food.plan.read` — read the plans a caller saved
- `food.plan.write` — save a plan
- `food.pantry.read` — read a caller's pantry
- `food.pantry.write` — replace a caller's pantry
- `food.household.read` — a household's pantry and plan as text for its OpenVibe.Chat room's AI member (internal,
  loopback only, a service token; granted to Chat)
- `food.recipes.suggest` — ask the network's AI for recipe ideas from a caller's pantry (proposed; not yet registered
  in openvibe-contracts, so an app token cannot be granted it until the manifest ships)

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
| `POST /api/v1/recipes/suggest` | signed in | ask the AI for recipes from your pantry: `{ ask?, people? }` → 201 with the saved suggestion |
| `GET /api/v1/recipes` | signed in | your recent recipe suggestions, newest first |

Public reads need no token. A person's own data (a plan, a pantry, recipe ideas) needs a signed-in caller; an app,
agent or service token needs the route's capability (`food.plan.read|write`,
`food.pantry.read|write`, `food.recipes.suggest` — [server/http/principal.js](server/http/principal.js)). A write made
with the session cookie must come from `openvibe.food` itself. Errors are RFC 9457 `application/problem+json` with a
stable `code`. With `OV_AI_INTERNAL_URL` unset, asking for recipes answers 503 `food.ai_off`.

**Per-caller limits** ([server/http/caller-limits.js](server/http/caller-limits.js)): reads take `FOOD_LIMITS_MINUTE` /
`FOOD_LIMITS_HOUR`; the place search, which spends OpenStreetMap's shared request budget, has its own tighter numbers,
as do saving a plan and replacing a pantry. Recipe suggestions are capped at 10 a person a day (429
`food.recipes_daily_limit`).

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

**Official prices** — for the 13 items the U.S. Bureau of Labor Statistics prices (eggs, boneless chicken breast,
ground beef, white bread, rice, spaghetti, dried beans, bananas, oranges, strawberries, potatoes, whole milk, cheddar),
an item's page also shows BLS's US city average for the newest month and that figure worked out for the item's pack
([server/food/official-prices.js](server/food/official-prices.js)). Food never calls BLS: OpenVibe.Sources reads BLS's
published average-price file once a day (source `bls-average-prices`) and Food follows its change feed into
`food_official_prices`. BLS is cited with its note that it cannot vouch for data once they leave BLS.gov. The list's
own band stays as it is.

**Open Food Facts labels** — Open Food Facts' daily product export (ODbL), read by OpenVibe.Sources as a streamed
bulk dataset (source `open-food-facts`), is matched by product name to the 42 foods on the list. A food's page shows
the most complete matching product's per-100 g figures, its Nutri-Score and a link to the product, in a separate
section credited "Open Food Facts (ODbL)" ([server/food/off.js](server/food/off.js), `food_off_products`), beside
the list's own nutrition and prices and never replacing them.

**Nutrition** — the same source's typical values per serving. "Per 100 g" is arithmetic on the pack size stated in an
item's own name divided by its servings (for example a 15 oz can with 3.5 servings is 121 g a serving). Where a name
states no weight — a dozen eggs, a 12-pack of ramen — no per-100 g figure is given rather than a density guessed.
The nutrition figures are the source's, not analysed here, and are not dietary advice.

**Recipes** — ten simple combinations written for this service in plain words, using only items from the food list.
No copied recipe text. They are labelled "basic suggestions" wherever they appear.

**Recipe ideas** — a signed-in person can ask OpenVibe.AI's `food.suggest_recipes` workflow for ideas from their
pantry. Food sends the pantry and the rows of its own food list as sources, validates what comes back (an ingredient
must be from the pantry or cite one of those sources), and prices only the to-buy items from its own typical prices —
never from anything the AI said. The page says plainly the recipes were suggested by AI and should be checked.

## Configuration

See [.env.example](.env.example). Required in production: `OV_OAUTH_CLIENT_SECRET` (the `food` OAuth client on the
Network), `BASE_URL`, `DATABASE_URL` and `DATABASE_DIRECT_URL`. `OV_AI_INTERNAL_URL` (the internal OpenVibe.AI URL)
turns the recipe ideas feature on; unset, the recipe routes answer 503 `food.ai_off`. `FOOD_NOMINATIM_URL` and
`FOOD_OVERPASS_URL` default to the public OSM hosts; tests point them at a stand-in and never reach the internet.
`FOOD_CHAT_INTERNAL_URL` (default `http://127.0.0.1:4400`) is where the household chat calls OpenVibe.Chat's room API,
and `FOOD_CHAT_PUBLIC_URL` (`https://openvibe.chat`) what the plan's page links.

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
- [test/recipes.test.js](test/recipes.test.js) — the AI recipe request and output validation, Food's own to-buy cost,
  the last-20 cap, the daily limit, the AI-off and empty-pantry problems, AiRunError pass-through, the capability
  check, and the page signed in and out.
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
(loopback only) — the three tables are mapped in [server/identity/account-data.js](server/identity/account-data.js), and
the boot-time subscriptions are created by [server/events-consumer.js](server/events-consumer.js):

- **Exported:** the plans a person saved (`plans.json`), their pantry (`pantry.json`) and their recipe suggestions
  (`recipe-suggestions.json`), pushed to `POST /internal/account-exports/:id/parts` with this service's own token.
  Nothing here is a secret — Food stores no token, key or credential.
- **Erased:** all three tables hold the person's own rows and nothing anyone else's page hangs under them, so they are
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
- The only hosts this service fetches are the OSM ones and OpenVibe.AI named in the configuration: a URL built from
  those bases, and nothing a caller sends. A place name is data in a query string, never a URL.
- Nothing a person keeps here (a plan, a pantry, recipe ideas) is public, cached or crawled.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).

<!-- versions:start -->
- openvibe-contracts: v0.222.0
- openvibe-sdk: v0.74.0
- openvibe-shared: v4.67.0
- openvibe-publishing: v1.4.0
<!-- versions:end -->
