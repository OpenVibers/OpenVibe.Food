-- phase: expand
-- OpenVibe.Food: Open Food Facts products (source open-food-facts, category food) as label data beside the food list
-- (server/food/off.js). Sources streams the ODbL export and keeps each product's code, name, brands, Nutri-Score and
-- per-100 g nutrients; Food follows Sources' change feed from its food_ingest_cursor and keeps the products that name
-- one of the 42 foods it plans with. The list's own nutrition and typical prices stay in server/food/foods.js and are
-- never replaced. Open Food Facts' ODbL credit and a link to the product are shown wherever these figures appear.

CREATE TABLE food_off_products (
    code                text COLLATE "C" PRIMARY KEY,     -- Open Food Facts' product code, Sources' identity
    item_id             text COLLATE "C" NOT NULL UNIQUE, -- the Sources item
    revision            integer NOT NULL,                 -- the Sources item's revision this row holds
    slug                text COLLATE "C" NOT NULL,        -- the food on the list it labels (server/food/foods.js)
    product_name        text NOT NULL,                    -- product_name, as the label states it
    brands              text,                             -- brands
    product_url         text,                             -- the Open Food Facts product page
    nutriscore_grade    text,                             -- Nutri-Score a-e, upper case, when the product states one
    energy_kcal_100g    double precision,
    fat_100g            double precision,
    saturated_fat_g     double precision,
    carbs_g             double precision,
    sugars_g            double precision,
    protein_g           double precision,
    salt_g              double precision,
    fiber_g             double precision,
    retrieved_at        text COLLATE "C" NOT NULL         -- when Sources last read it, ISO 8601 UTC
);

CREATE INDEX food_off_products_slug ON food_off_products (slug);
