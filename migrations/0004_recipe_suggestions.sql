-- phase: expand
-- OpenVibe.Food: recipe ideas a person asked OpenVibe.AI for from their pantry (workflow food.suggest_recipes,
-- server/food/recipes.js). The row holds the validated output plus Food's own to-buy costs, and Food keeps the last
-- 20 per person. Nothing here is ever a credential, a key or a token.

CREATE TABLE food_recipe_suggestions (
    id         text COLLATE "C" PRIMARY KEY,          -- rcp_<ULID>
    subject_id text COLLATE "C" NOT NULL,             -- user:usr_…
    created_at text COLLATE "C" NOT NULL,             -- ISO 8601, UTC
    ask        text,                                  -- what the person felt like (at most 500 chars)
    people     integer,                               -- how many to feed (1–12), when given
    ai_run_id  text,                                  -- the OpenVibe.AI run id, for the authorship record
    recipes    jsonb NOT NULL                         -- the validated recipes, with to_buy and to_buy_cost
);
CREATE INDEX food_recipe_suggestions_by_subject ON food_recipe_suggestions (subject_id, id DESC);
