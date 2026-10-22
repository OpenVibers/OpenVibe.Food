-- phase: expand
-- OpenVibe.Food's food recalls (server/food/recalls.js): the FDA's food enforcement reports, as OpenVibe.Sources collects
-- them (source openfda-food-enforcement, category food). Food never calls the FDA: it follows Sources' change feed from
-- its cursor here (openvibe-publishing/ingest, prefix food) and keeps each recall as the report states it. The reports
-- are public domain (CC0, openFDA); nothing here belongs to a person.

-- The DDL is openvibe-publishing lib/ingest.js schema('food').
CREATE TABLE IF NOT EXISTS food_ingest_cursor (
    name       text COLLATE "C" NOT NULL,
    cursor     bigint NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (name)
);

CREATE TABLE food_recalls (
    recall_number  text COLLATE "C" PRIMARY KEY,          -- the FDA's own number (F-0123-2027), Sources' identity
    item_id        text COLLATE "C" NOT NULL UNIQUE,      -- the Sources item
    revision       integer NOT NULL,                      -- the Sources item's revision this row holds
    product        text NOT NULL,                         -- product_description, as stated
    reason         text,                                  -- reason_for_recall
    firm           text,                                  -- recalling_firm
    classification text,                                  -- Class I, Class II or Class III
    status         text,                                  -- Ongoing, Completed, Terminated
    state          text,                                  -- the recalling firm's state
    distribution   text,                                  -- distribution_pattern
    voluntary      text,                                  -- voluntary_mandated
    initiated_on   text COLLATE "C",                      -- YYYY-MM-DD
    reported_on    text COLLATE "C",                      -- YYYY-MM-DD, the enforcement report's date
    retrieved_at   text COLLATE "C" NOT NULL              -- when Sources last read it, ISO 8601 UTC
);
CREATE INDEX food_recalls_reported ON food_recalls (reported_on DESC, recall_number);
