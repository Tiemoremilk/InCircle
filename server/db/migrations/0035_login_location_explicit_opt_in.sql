ALTER TABLE incircle_users
  ALTER COLUMN precise_login_location_enabled SET DEFAULT false;

UPDATE incircle_users
SET precise_login_location_enabled = false,
    updated_at = now()
WHERE precise_login_location_enabled IS DISTINCT FROM false;

UPDATE incircle_account_sessions
SET login_location_source = '',
    login_latitude = NULL,
    login_longitude = NULL,
    login_accuracy_m = NULL,
    login_location_province = '',
    login_location_city = '',
    login_location_district = '',
    login_location_detail = '',
    login_location_captured_at = NULL,
    updated_at = now()
WHERE login_location_captured_at IS NOT NULL
   OR login_latitude IS NOT NULL
   OR login_longitude IS NOT NULL
   OR login_location_source <> '';
