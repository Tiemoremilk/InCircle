ALTER TABLE incircle_circle_members ALTER COLUMN role SET DEFAULT '成员';
ALTER TABLE incircle_member_cards ALTER COLUMN role SET DEFAULT '成员';

WITH normalized_member_roles AS (
  SELECT
    member.id,
    CASE
      WHEN circle.owner_user_id = member.user_id
        OR lower(btrim(member.role)) IN ('圈主', 'owner', 'circle_owner', 'circle-owner', 'creator')
        THEN '圈主'
      WHEN lower(btrim(member.role)) IN (
        '超管', '管理员', '超级管理员', 'admin', 'administrator', 'manager',
        'circle_admin', 'circle-admin', 'super_admin', 'super-admin', 'superadmin'
      )
        THEN '超管'
      ELSE '成员'
    END AS role
  FROM incircle_circle_members member
  JOIN incircle_circles circle ON circle.id = member.circle_id
)
UPDATE incircle_circle_members member
SET role = normalized.role
FROM normalized_member_roles normalized
WHERE member.id = normalized.id
  AND member.role IS DISTINCT FROM normalized.role;

UPDATE incircle_member_cards card
SET role = member.role
FROM incircle_circle_members member
WHERE member.circle_id = card.circle_id
  AND member.user_id = card.user_id
  AND card.role IS DISTINCT FROM member.role;

UPDATE incircle_member_cards card
SET role = '圈主'
FROM incircle_circles circle
WHERE circle.id = card.circle_id
  AND circle.owner_user_id = card.user_id
  AND card.role IS DISTINCT FROM '圈主';

UPDATE incircle_member_cards
SET role = CASE
  WHEN lower(btrim(role)) IN ('圈主', 'owner', 'circle_owner', 'circle-owner', 'creator') THEN '圈主'
  WHEN lower(btrim(role)) IN (
    '超管', '管理员', '超级管理员', 'admin', 'administrator', 'manager',
    'circle_admin', 'circle-admin', 'super_admin', 'super-admin', 'superadmin'
  ) THEN '超管'
  ELSE '成员'
END
WHERE role NOT IN ('圈主', '超管', '成员');

ALTER TABLE incircle_circle_members DROP CONSTRAINT IF EXISTS chk_incircle_circle_member_role;
ALTER TABLE incircle_circle_members
  ADD CONSTRAINT chk_incircle_circle_member_role CHECK (role IN ('圈主', '超管', '成员'));
ALTER TABLE incircle_member_cards DROP CONSTRAINT IF EXISTS chk_incircle_member_card_role;
ALTER TABLE incircle_member_cards
  ADD CONSTRAINT chk_incircle_member_card_role CHECK (role IN ('圈主', '超管', '成员'));

WITH refreshed_manual AS (
  SELECT
    docs.id,
    jsonb_agg(
      CASE
        WHEN entry.value #>> '{}' = '圈主和管理员可以维护圈子资料、移除成员、删除圈内业务；圈主不能退出，只能解散圈子。'
          THEN to_jsonb('圈主和超管可以维护圈子资料、移除成员、删除圈内业务；圈主不能退出，只能解散圈子。'::text)
        ELSE entry.value
      END
      ORDER BY entry.ordinality
    ) AS body
  FROM incircle_docs docs
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(docs.payload->'body') = 'array' THEN docs.payload->'body' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS entry(value, ordinality)
  WHERE docs.payload->>'systemKey' = 'incircle-manual'
    AND jsonb_typeof(docs.payload->'body') = 'array'
  GROUP BY docs.id
)
UPDATE incircle_docs docs
SET payload = jsonb_set(docs.payload, '{body}', refreshed_manual.body, true),
    updated_at = now()
FROM refreshed_manual
WHERE docs.id = refreshed_manual.id
  AND docs.payload->'body' IS DISTINCT FROM refreshed_manual.body;
