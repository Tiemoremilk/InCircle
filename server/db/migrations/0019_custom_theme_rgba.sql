ALTER TABLE incircle_users
  ADD COLUMN IF NOT EXISTS custom_theme_rgba jsonb NOT NULL
  DEFAULT '{"r":47,"g":130,"b":89,"a":1}'::jsonb;

UPDATE incircle_users SET theme_key = 'forest' WHERE theme_key = 'iris';

ALTER TABLE incircle_users DROP CONSTRAINT IF EXISTS chk_incircle_user_theme_key;
ALTER TABLE incircle_users
  ADD CONSTRAINT chk_incircle_user_theme_key CHECK (
    theme_key IS NULL
    OR theme_key IN ('forest', 'ocean', 'berry', 'graphite', 'coral', 'peacock', 'cyan', 'mint', 'sky', 'apricot', 'lilac', 'custom')
  );
