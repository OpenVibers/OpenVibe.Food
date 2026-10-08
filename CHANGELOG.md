# Changelog

What changed in OpenVibe.Food, newest first. Each site also publishes its patch notes at /updates.

## 0.2.0 — 2026-10-08

The product: everything food, in one service. The food tools move here from OpenVibe.Tools, without the Walmart page
scraping that source also did.

- **Find food near you** (`/near`, `GET /api/v1/places`): a place name (geocoded with Nominatim) or coordinates in,
  food banks, soup kitchens, community fridges, free pantry boxes and budget grocery stores out of OpenStreetMap
  (Overpass), with distance, address, opening hours, operator, phone, website and a link back to the object on OSM.
  Every result page carries the OpenStreetMap attribution and the ODbL link ODbL requires.
- **Inside the OSM usage policies** (`server/food/upstream.js`): we identify with `FOOD_OSM_USER_AGENT`, at most one
  request a second per host (calls to a host queue behind each other), every answer cached in `food_geo_cache` for
  7 days, and only small `around:` radius queries — never a bulk download.
- **Meal planner** (`/plan`, `POST /api/v1/plans`): for one person, a couple or a group, 1–14 days, covering the six
  USDA MyPlate food groups from the ported food list, with a shopping list, the cheapest store per line, and an
  estimated cost. Deterministic; a budget is a hard cap. Signed-in people can save plans (`food_plans`).
- **Food database** (`/foods`, `/foods/:slug`, `GET /api/v1/foods[/:slug]`): the 42-item list ported from
  OpenVibe.Tools' grocery source, with nutrition per serving and per 100 g (derived from the pack size the item's own
  name states — and left out, not guessed, when it states no weight), the typical price band, and the chain-by-chain
  comparison. Server-rendered and in the sitemap.
- **Pantry** (`/pantry`, `GET`/`PUT /api/v1/pantry`): signed-in people keep what is in their cupboard (`food_pantry`)
  and get a deterministic "what can I make" against ten basic recipes written for this service — clearly labelled
  basic suggestions, no model call anywhere in this version.
- **Discovery**: the sitemap now carries every food page, `/near`, `/plan` and `/foods`; llms.txt and llms-full.txt
  list the same set; a pantry and a saved plan are never crawled.
- **Capabilities and limits**: `food.place.read`, `food.food.read`, `food.plan.read|write`, `food.pantry.read|write`;
  the place search has the tightest per-caller budget because it spends OpenStreetMap's shared request budget.
- **Tests**: a stand-in Nominatim + Overpass (`test/helpers/osm.js`) — the suite never calls the internet — covering
  the results and the attribution, the one-request-a-second queue, cache hits, the per-caller limit on the search, the
  meal-plan arithmetic, the pantry match, signed-in saves, anonymous refusals and the escaping of an OSM name.

Also:

- `test/skeleton.test.js` now skips itself inside a generated service. It asserts that the skeleton's generator
  rewrites its placeholders, which a generated service has none of; it was already failing before this change.
- `test/helpers/boot.js` points the two OSM hosts at a closed local port unless a test names a stand-in, so no test
  can reach the real Nominatim or Overpass.
- The home page's CSS budget was raised from 16.5 to 18 KB: the product's own pages brought their stylesheet with them
  (search and plan forms, place cards, the pantry tick list).

## 0.1.0 — 2026-10-08

- **First release:** the service starts from the OpenVibe skeleton — sign-in with OpenVibe.Network (OAuth 2 + PKCE), server-rendered pages through the OpenVibe Frame, the `/api/v1` mount with per-caller limits, crawl artifacts, PostgreSQL migrations, the deploy files and the test suite.
