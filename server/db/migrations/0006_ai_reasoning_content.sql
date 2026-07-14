ALTER TABLE incircle_ai_messages
  ADD COLUMN IF NOT EXISTS reasoning_content text NOT NULL DEFAULT '';
