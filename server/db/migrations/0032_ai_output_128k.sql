ALTER TABLE incircle_ai_settings
  DROP CONSTRAINT IF EXISTS chk_incircle_ai_settings_output_tokens;

ALTER TABLE incircle_ai_settings
  ADD CONSTRAINT chk_incircle_ai_settings_output_tokens
  CHECK (max_output_tokens BETWEEN 128 AND 131072);
