ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS theme_key text;

UPDATE incircle_users
SET theme_key = regexp_replace(lower(theme_key), '^theme-', '')
WHERE theme_key IS NOT NULL
  AND regexp_replace(lower(theme_key), '^theme-', '')
    IN ('forest', 'ocean', 'berry', 'graphite', 'coral', 'peacock', 'iris', 'cyan', 'mint', 'sky', 'apricot', 'lilac');

UPDATE incircle_users
SET theme_key = CASE
  WHEN regexp_replace(lower(COALESCE(raw_data->>'themeKey', raw_data->>'theme_key', raw_data->>'theme', '')), '^theme-', '')
    IN ('forest', 'ocean', 'berry', 'graphite', 'coral', 'peacock', 'iris', 'cyan', 'mint', 'sky', 'apricot', 'lilac')
    THEN regexp_replace(lower(COALESCE(raw_data->>'themeKey', raw_data->>'theme_key', raw_data->>'theme', '')), '^theme-', '')
  WHEN COALESCE(raw_data->>'themeIndex', '') ~ '^\d{1,2}$'
    AND (raw_data->>'themeIndex')::integer BETWEEN 0 AND 11
    THEN (ARRAY['forest', 'ocean', 'berry', 'graphite', 'coral', 'peacock', 'iris', 'cyan', 'mint', 'sky', 'apricot', 'lilac'])[(raw_data->>'themeIndex')::integer + 1]
  WHEN COALESCE(raw_data->>'theme_index', '') ~ '^\d{1,2}$'
    AND (raw_data->>'theme_index')::integer BETWEEN 1 AND 12
    THEN (ARRAY['forest', 'ocean', 'berry', 'graphite', 'coral', 'peacock', 'iris', 'cyan', 'mint', 'sky', 'apricot', 'lilac'])[(raw_data->>'theme_index')::integer]
  ELSE NULL
END
WHERE theme_key IS NULL;

UPDATE incircle_users
SET theme_key = NULL
WHERE theme_key IS NOT NULL
  AND theme_key NOT IN ('forest', 'ocean', 'berry', 'graphite', 'coral', 'peacock', 'iris', 'cyan', 'mint', 'sky', 'apricot', 'lilac');

ALTER TABLE incircle_users ALTER COLUMN theme_key SET DEFAULT 'forest';
ALTER TABLE incircle_users DROP CONSTRAINT IF EXISTS chk_incircle_user_theme_key;
ALTER TABLE incircle_users
  ADD CONSTRAINT chk_incircle_user_theme_key CHECK (
    theme_key IS NULL
    OR theme_key IN ('forest', 'ocean', 'berry', 'graphite', 'coral', 'peacock', 'iris', 'cyan', 'mint', 'sky', 'apricot', 'lilac')
  );
