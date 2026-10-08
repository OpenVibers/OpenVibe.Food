-- phase: expand
-- OpenVibe.Food: where the product's own data lives. Nothing here is ever a credential, a key or a token.
--
--   food_geo_cache  every Nominatim geocode and Overpass answer, with its TTL (7 days), so the two OSM services are
--                   asked once for a place and not once per visitor (their usage policies; server/food/upstream.js)
--   food_plans      a saved meal plan, as the planner returned it (server/food/planner.js), with the spec beside it
--   food_pantry     what one person says is in their cupboard, one row per food in the list (server/food/foods.js)

CREATE TABLE food_geo_cache (
    key        text COLLATE "C" PRIMARY KEY,           -- 'nominatim:<query>' | 'overpass:<sha256 of the query>'
    body       jsonb NOT NULL,                         -- the upstream answer, as it came
    fetched_at text COLLATE "C" NOT NULL,              -- when it was fetched (ISO 8601, UTC)
    expires_at text COLLATE "C" NOT NULL               -- ISO 8601, UTC: past it the row is ignored and replaced
);
CREATE INDEX food_geo_cache_expires ON food_geo_cache (expires_at);

CREATE TABLE food_plans (
    id         text COLLATE "C" PRIMARY KEY,           -- pln_<ULID>
    owner      text COLLATE "C" NOT NULL,              -- user:usr_…
    title      text,
    people     integer NOT NULL,
    days       integer NOT NULL,
    budget     double precision,                       -- the caller's budget, when one was given
    plan       jsonb NOT NULL,                         -- the plan the planner returned, unchanged
    created_at text COLLATE "C" NOT NULL
);
CREATE INDEX food_plans_by_owner ON food_plans (owner, id DESC);

CREATE TABLE food_pantry (
    owner    text COLLATE "C" NOT NULL,               -- user:usr_…
    item     text COLLATE "C" NOT NULL,               -- the food's slug in server/food/foods.js
    added_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (owner, item)
);
