-- phase: expand
-- OpenVibe.Food's official prices (server/food/official-prices.js): the Bureau of Labor Statistics' monthly US city
-- average retail prices for the items on the food list that BLS prices, as OpenVibe.Sources collects them (source
-- bls-average-prices, category food). Food never calls BLS: it follows Sources' change feed from its own cursor in
-- food_ingest_cursor and keeps each series' newest month as BLS states it. US federal data (public domain); nothing
-- here belongs to a person.
CREATE TABLE food_official_prices (
    series_id    text COLLATE "C" PRIMARY KEY,          -- BLS's series (APU0000708111), Sources' identity
    item_id      text COLLATE "C" NOT NULL UNIQUE,      -- the Sources item
    revision     integer NOT NULL,                      -- the Sources item's revision this row holds
    value        numeric(10, 3) NOT NULL CHECK (value > 0),  -- dollars per the series' unit, as BLS states it
    year         integer NOT NULL,
    period       text COLLATE "C" NOT NULL,             -- M01 … M12
    retrieved_at text COLLATE "C" NOT NULL              -- when Sources last read it, ISO 8601 UTC
);
