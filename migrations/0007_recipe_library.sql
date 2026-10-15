-- phase: expand
-- OpenVibe.Food's recipe library (server/food/library.js): budget recipes OpenVibe.AI wrote from Food's own food list
-- (workflow food.suggest_recipes with an empty cupboard and a theme), each costed by Food from its typical prices.
-- Labelled as AI; noindex until a member of staff marks it reviewed; staff may hide one.

CREATE TABLE food_library_recipes (
    id            text COLLATE "C" PRIMARY KEY,           -- lib_<random>
    slug          text COLLATE "C" NOT NULL UNIQUE,
    title         text NOT NULL,
    theme         text NOT NULL,                          -- what the AI was asked for
    serves        integer,
    minutes       integer,
    ingredients   jsonb NOT NULL,                         -- [{ name, amount, food }] food = a food list slug
    steps         jsonb NOT NULL,                         -- [text]
    notes         text,
    to_buy        jsonb NOT NULL,                         -- [{ slug, name, price }] from the food list, whole packages
    cost          numeric(10,2),                          -- the sum of the typical prices of to_buy
    cost_partial  boolean NOT NULL DEFAULT false,         -- some food had no typical price
    ai_run_id     text,
    status        text NOT NULL DEFAULT 'published' CHECK (status IN ('published','hidden')),
    reviewed_by   text,                                   -- usr_… of the staff member who checked it
    reviewed_at   text,
    hidden_reason text,
    created_at    text COLLATE "C" NOT NULL               -- ISO 8601, UTC
);
CREATE INDEX food_library_recipes_listing ON food_library_recipes (status, created_at DESC);

-- One row per theme run, so a theme is not asked again before the others have had their turn.
CREATE TABLE food_library_runs (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    theme      text NOT NULL,
    ai_run_id  text,
    made       integer NOT NULL DEFAULT 0,
    error      text,
    created_at text COLLATE "C" NOT NULL
);
CREATE INDEX food_library_runs_theme ON food_library_runs (theme, created_at DESC);
