-- phase: expand
-- OpenVibe.Food's USDA ERS prices (server/food/usda-prices.js): the Economic Research Service's annual national-average
-- retail prices for fruits and vegetables, as OpenVibe.Sources collects them (source usda-ers-fruit-vegetable-prices,
-- category food). Food never calls ERS: it follows Sources' change feed from its own cursor in food_ingest_cursor and
-- keeps each row as ERS publishes it. US federal data (public domain in the US); nothing here belongs to a person.
CREATE TABLE food_usda_prices (
    identity     text COLLATE "C" PRIMARY KEY,          -- "Apples | Fresh": Sources' identity (ERS product and form)
    item_id      text COLLATE "C" NOT NULL UNIQUE,      -- the Sources item
    revision     integer NOT NULL,                      -- the Sources item's revision this row holds
    value        numeric(10, 4) NOT NULL CHECK (value > 0),  -- dollars per the row's unit, as ERS states it
    unit         text COLLATE "C" NOT NULL,             -- lb (every row Food maps is priced per pound)
    vintage      text COLLATE "C" NOT NULL,             -- the data year ERS published (2023 today)
    retrieved_at text COLLATE "C" NOT NULL              -- when Sources last read it, ISO 8601 UTC
);
