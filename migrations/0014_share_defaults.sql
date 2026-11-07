-- phase: expand
-- Visibility step 3 (design 2026-11-06): the person's default audience for new meal plans, and one share row for every
-- plan that already exists. The old household link maps to Anyone with the link (any signed-in person holding its
-- secret could already join and read the plan); a plan without one was Only me. Members of a household stay members
-- through food_plan_members, so they keep editing the shopping list.
-- New plans are registered as they are made (server/food/sharing.js); a plan without a row is still its owner's,
-- because every read asks canView and a missing row falls back to the old columns. Repeating this file is a no-op.

CREATE TABLE IF NOT EXISTS food_share_defaults (
    subject    text COLLATE "C" PRIMARY KEY,
    audience   text COLLATE "C" NOT NULL CHECK (audience IN ('public', 'link', 'people', 'private')),
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO shares (service, kind, resource_id, owner_subject, audience)
SELECT
    'food', 'plan', p.id,
    jsonb_build_object('type', 'user', 'id', regexp_replace(p.owner, '^user:', '')),
    CASE WHEN p.share_hash IS NOT NULL THEN 'people' ELSE 'private' END
FROM food_plans p
ON CONFLICT (service, kind, resource_id) DO NOTHING;
