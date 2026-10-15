-- phase: expand
-- OpenVibe.Food: plan together (the "Plan together" pillar). A saved plan can be shared with a household: its owner
-- makes a share link (only the SHA-256 of its secret is kept, share_hash), anyone signed in who opens it joins as a
-- member, and every member ticks the shopping list off for everyone. Deleting a plan deletes its members and ticks.
-- Names are the display name a person had when they joined or ticked, shown to the household; nothing here is a
-- credential, a key or a token.

ALTER TABLE food_plans ADD COLUMN share_hash text COLLATE "C";            -- sha256 hex of the share link's secret
CREATE UNIQUE INDEX food_plans_share ON food_plans (share_hash) WHERE share_hash IS NOT NULL;

CREATE TABLE food_plan_members (
    plan_id   text COLLATE "C" NOT NULL REFERENCES food_plans (id) ON DELETE CASCADE,
    member    text COLLATE "C" NOT NULL,                                -- user:usr_…
    name      text,                                                      -- their display name when they joined
    joined_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (plan_id, member)
);
CREATE INDEX food_plan_members_by_member ON food_plan_members (member, joined_at DESC);

CREATE TABLE food_plan_ticks (
    plan_id   text COLLATE "C" NOT NULL REFERENCES food_plans (id) ON DELETE CASCADE,
    item      text COLLATE "C" NOT NULL,                                -- the shopping list item's food slug
    ticked_by text COLLATE "C" NOT NULL,                                -- user:usr_…
    name      text,                                                      -- their display name when they ticked it
    ticked_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (plan_id, item)
);
CREATE INDEX food_plan_ticks_by_person ON food_plan_ticks (ticked_by);
