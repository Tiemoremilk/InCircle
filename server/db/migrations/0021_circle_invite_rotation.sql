ALTER TABLE incircle_circles
  ADD COLUMN IF NOT EXISTS invite_token text;

ALTER TABLE incircle_circle_qr_codes
  ADD COLUMN IF NOT EXISTS invite_token text;

ALTER TABLE incircle_circles
  DROP CONSTRAINT IF EXISTS incircle_circles_join_code_key;
DROP INDEX IF EXISTS uq_incircle_circles_join_code;

DO $$
DECLARE
  target record;
  candidate text;
  token_candidate text;
BEGIN
  FOR target IN
    SELECT id
    FROM incircle_circles
  LOOP
    LOOP
      candidate := substr(
        regexp_replace(encode(gen_random_bytes(12), 'base64'), '[^A-Za-z0-9]', '', 'g'),
        1,
        8
      );
      EXIT WHEN char_length(candidate) = 8 AND NOT EXISTS (
        SELECT 1
        FROM incircle_circles
        WHERE (join_code COLLATE "C") = (candidate COLLATE "C")
      );
    END LOOP;
    LOOP
      token_candidate := encode(gen_random_bytes(16), 'hex');
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM incircle_circles WHERE invite_token = token_candidate
      );
    END LOOP;
    UPDATE incircle_circles
    SET join_code = candidate, invite_token = token_candidate
    WHERE id = target.id;
  END LOOP;
END $$;

ALTER TABLE incircle_circles
  ALTER COLUMN join_code SET NOT NULL,
  ALTER COLUMN invite_token SET NOT NULL;

ALTER TABLE incircle_circles
  DROP CONSTRAINT IF EXISTS chk_incircle_circle_join_code;
ALTER TABLE incircle_circles
  ADD CONSTRAINT chk_incircle_circle_join_code
  CHECK (char_length(join_code) = 8 AND join_code ~ '^[A-Za-z0-9@#￥%&]{8}$');

ALTER TABLE incircle_circles
  DROP CONSTRAINT IF EXISTS chk_incircle_circle_invite_token;
ALTER TABLE incircle_circles
  ADD CONSTRAINT chk_incircle_circle_invite_token
  CHECK (invite_token ~ '^[a-f0-9]{32}$');

ALTER TABLE incircle_circle_qr_codes
  DROP CONSTRAINT IF EXISTS chk_incircle_circle_qr_invite_token;
DELETE FROM incircle_circle_qr_codes;
ALTER TABLE incircle_circle_qr_codes
  ALTER COLUMN invite_token SET NOT NULL;
ALTER TABLE incircle_circle_qr_codes
  ADD CONSTRAINT chk_incircle_circle_qr_invite_token
  CHECK (invite_token ~ '^[a-f0-9]{32}$');

CREATE UNIQUE INDEX IF NOT EXISTS uq_incircle_circles_join_code_case
  ON incircle_circles ((join_code COLLATE "C"));

CREATE UNIQUE INDEX IF NOT EXISTS uq_incircle_circles_invite_token
  ON incircle_circles(invite_token);
