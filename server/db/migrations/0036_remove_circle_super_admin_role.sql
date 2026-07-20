ALTER TABLE incircle_circle_members ALTER COLUMN role SET DEFAULT '成员';
ALTER TABLE incircle_member_cards ALTER COLUMN role SET DEFAULT '成员';

WITH normalized_member_roles AS (
  SELECT
    member.id,
    CASE
      WHEN circle.owner_user_id = member.user_id THEN '圈主'
      ELSE '成员'
    END AS role
  FROM incircle_circle_members member
  LEFT JOIN incircle_circles circle ON circle.id = member.circle_id
)
UPDATE incircle_circle_members member
SET role = normalized.role
FROM normalized_member_roles normalized
WHERE member.id = normalized.id
  AND member.role IS DISTINCT FROM normalized.role;

WITH normalized_member_card_roles AS (
  SELECT
    card.id,
    CASE
      WHEN circle.owner_user_id = card.user_id THEN '圈主'
      ELSE '成员'
    END AS role
  FROM incircle_member_cards card
  LEFT JOIN incircle_circles circle ON circle.id = card.circle_id
)
UPDATE incircle_member_cards card
SET role = normalized.role
FROM normalized_member_card_roles normalized
WHERE card.id = normalized.id
  AND card.role IS DISTINCT FROM normalized.role;

ALTER TABLE incircle_circle_members ALTER COLUMN role SET NOT NULL;
ALTER TABLE incircle_member_cards ALTER COLUMN role SET NOT NULL;

ALTER TABLE incircle_circle_members DROP CONSTRAINT IF EXISTS chk_incircle_circle_member_role;
ALTER TABLE incircle_circle_members
  ADD CONSTRAINT chk_incircle_circle_member_role CHECK (role IN ('圈主', '成员'));

ALTER TABLE incircle_member_cards DROP CONSTRAINT IF EXISTS chk_incircle_member_card_role;
ALTER TABLE incircle_member_cards
  ADD CONSTRAINT chk_incircle_member_card_role CHECK (role IN ('圈主', '成员'));
