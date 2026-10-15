-- phase: expand
-- OpenVibe.Food: a household's chat (server/food/household-chat.js). The owner of a shared plan can open a private
-- room for it on OpenVibe.Chat with an AI member, Pantry, that knows the plan and the household's cupboards; this is
-- the room's address there (openvibe.chat/r/<chat_room>). Nothing here is a credential.
ALTER TABLE food_plans ADD COLUMN IF NOT EXISTS chat_room text COLLATE "C";
