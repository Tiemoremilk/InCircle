const { loadConfig } = require("./config");
const { createDatabase } = require("./db");
const { beijingDateKey, parseBeijingDateTime } = require("./time");

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return String(value || "").trim();
}

function addToMap(map, key, value) {
  const normalized = text(key);
  if (!normalized) return;
  const values = map.get(normalized) || [];
  if (!values.some((item) => item.id === value.id)) values.push(value);
  map.set(normalized, values);
}

function cardIndex(rows) {
  const index = new Map();
  rows.forEach((row) => {
    [row.id, row.user_id, row.member_id, row.openid, row.name].forEach((key) => addToMap(index, key, row));
  });
  return index;
}

function memberKeys(value) {
  if (!value || typeof value !== "object") return [value];
  return [value.memberId, value.userId, value.openid, value.id, value.memberName, value.name, value.voterName];
}

function resolveCard(index, value) {
  for (const key of memberKeys(value)) {
    const matches = index.get(text(key)) || [];
    if (matches.length === 1) return { card: matches[0], ambiguous: false };
    if (matches.length > 1) return { card: null, ambiguous: true };
  }
  return { card: null, ambiguous: false };
}

function recordDate(record) {
  const explicit = text(record && record.checkinDate);
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  return beijingDateKey(
    (record && (record.createdAtMs || record.createdAt || record.time || record.timestamp)) || ""
  );
}

async function addIssue(db, migrationKey, entityType, entityId, reason, payload) {
  await db.query(
    `
    INSERT INTO incircle_migration_issues (migration_key, entity_type, entity_id, reason, payload)
    VALUES ($1, $2, $3, $4, $5::jsonb)
    ON CONFLICT (migration_key, entity_type, entity_id, reason) DO NOTHING
    `,
    [migrationKey, entityType, String(entityId), reason, JSON.stringify(payload || {})]
  );
}

async function backfillActivities(db, indexes, summary) {
  const result = await db.query("SELECT * FROM incircle_activities ORDER BY created_at");
  for (const row of result.rows) {
    const payload = row.payload || {};
    const index = indexes.get(String(row.circle_id)) || new Map();
    const statuses = [
      ["attendees", "我来"],
      ["pending", "待定"],
      ["absent", "不来"],
      ["waitlist", "候补"],
    ];
    for (const [field, status] of statuses) {
      for (const [position, member] of list(payload[field]).entries()) {
        const resolved = resolveCard(index, member);
        if (!resolved.card) {
          await addIssue(db, "0003-actions", "activity_response", `${row.id}:${field}:${position}`, resolved.ambiguous ? "ambiguous_member" : "member_not_found", { member });
          summary.issues += 1;
          continue;
        }
        await db.query(
          `
          INSERT INTO incircle_activity_responses (circle_id, activity_id, user_id, member_card_id, status, plus_one_count)
          VALUES ($1, $2, $3, $4, $5, 0)
          ON CONFLICT (activity_id, user_id) DO NOTHING
          `,
          [row.circle_id, row.id, resolved.card.user_id, resolved.card.id, status]
        );
        summary.activityResponses += 1;
      }
    }
    if (Number(payload.plusOneCount || 0) > 0) {
      await addIssue(db, "0003-actions", "activity_response", row.id, "legacy_plus_one_unassigned", { plusOneCount: payload.plusOneCount });
      summary.issues += 1;
    }
    const startsAt = parseBeijingDateTime(payload.startsAt || payload.time, row.created_at);
    if (startsAt) await db.query("UPDATE incircle_activities SET starts_at = $2 WHERE id = $1 AND starts_at IS NULL", [row.id, startsAt]);
  }
}

async function backfillVotes(db, indexes, summary) {
  const result = await db.query("SELECT * FROM incircle_votes ORDER BY created_at");
  for (const row of result.rows) {
    const payload = row.payload || {};
    const index = indexes.get(String(row.circle_id)) || new Map();
    for (const [position, record] of list(payload.records).entries()) {
      const resolved = resolveCard(index, record);
      const optionName = text(record && (record.optionName || record.name));
      if (!resolved.card || !optionName) {
        await addIssue(db, "0003-actions", "vote_ballot", `${row.id}:${position}`, !optionName ? "option_missing" : resolved.ambiguous ? "ambiguous_member" : "member_not_found", { record });
        summary.issues += 1;
        continue;
      }
      await db.query(
        `
        INSERT INTO incircle_vote_ballots (circle_id, vote_id, user_id, member_card_id, option_name, weight, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))
        ON CONFLICT (vote_id, user_id, option_name) DO NOTHING
        `,
        [row.circle_id, row.id, resolved.card.user_id, resolved.card.id, optionName, Math.max(1, Number(record.weight || 1)), record.createdAt || null]
      );
      summary.voteBallots += 1;
    }
    for (const [position, record] of list(payload.vetoRecords).entries()) {
      const resolved = resolveCard(index, record);
      const optionName = text(record && (record.optionName || record.name));
      if (!resolved.card || !optionName) {
        await addIssue(db, "0003-actions", "vote_veto", `${row.id}:${position}`, !optionName ? "option_missing" : resolved.ambiguous ? "ambiguous_member" : "member_not_found", { record });
        summary.issues += 1;
        continue;
      }
      await db.query(
        `
        INSERT INTO incircle_vote_vetoes (circle_id, vote_id, user_id, member_card_id, option_name, created_at)
        VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()))
        ON CONFLICT (vote_id, user_id, option_name) DO NOTHING
        `,
        [row.circle_id, row.id, resolved.card.user_id, resolved.card.id, optionName, record.createdAt || null]
      );
      summary.voteVetoes += 1;
    }
    const deadline = parseBeijingDateTime(payload.deadlineAt || payload.deadlineTime || payload.deadline, row.created_at);
    if (deadline) await db.query("UPDATE incircle_votes SET deadline_at = $2 WHERE id = $1 AND deadline_at IS NULL", [row.id, deadline]);
  }
}

async function backfillCheckins(db, indexes, summary) {
  const result = await db.query("SELECT * FROM incircle_checkins ORDER BY created_at");
  for (const row of result.rows) {
    const payload = row.payload || {};
    const index = indexes.get(String(row.circle_id)) || new Map();
    for (const [position, record] of list(payload.records).entries()) {
      const resolved = resolveCard(index, record);
      const dateKey = recordDate(record);
      if (!resolved.card || !dateKey) {
        await addIssue(db, "0003-actions", "checkin_record", `${row.id}:${position}`, !dateKey ? "date_missing" : resolved.ambiguous ? "ambiguous_member" : "member_not_found", { record });
        summary.issues += 1;
        continue;
      }
      const media = list(record.media || record.images || record.photos);
      await db.query(
        `
        INSERT INTO incircle_checkin_records (
          circle_id, checkin_id, user_id, member_card_id, checkin_date, record_type, value, note, media, created_at
        ) VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9::jsonb, COALESCE($10::timestamptz, now()))
        ON CONFLICT (checkin_id, user_id, checkin_date) DO NOTHING
        `,
        [row.circle_id, row.id, resolved.card.user_id, resolved.card.id, dateKey, text(record.type) || "文字", text(record.value) || "已完成", text(record.note), JSON.stringify(media), record.createdAt || null]
      );
      summary.checkinRecords += 1;
    }
  }
}

async function backfillTags(db, indexes, summary) {
  const result = await db.query("SELECT * FROM incircle_member_cards ORDER BY created_at");
  for (const row of result.rows) {
    const payload = row.payload || {};
    const index = indexes.get(String(row.circle_id)) || new Map();
    for (const friendly of list(payload.friendlyTags)) {
      const tag = text(friendly && friendly.tag);
      if (!tag) continue;
      for (const [position, voter] of list(friendly.voters).entries()) {
        const resolved = resolveCard(index, voter);
        if (!resolved.card || resolved.card.user_id === row.user_id) {
          await addIssue(db, "0003-actions", "member_tag_vote", `${row.id}:${tag}:${position}`, resolved.card ? "self_vote_ignored" : resolved.ambiguous ? "ambiguous_voter" : "voter_not_found", { voter });
          summary.issues += 1;
          continue;
        }
        await db.query(
          `
          INSERT INTO incircle_member_tag_votes (circle_id, target_member_card_id, voter_user_id, tag, created_at)
          VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()))
          ON CONFLICT (target_member_card_id, voter_user_id, tag) DO NOTHING
          `,
          [row.circle_id, row.id, resolved.card.user_id, tag, voter.createdAt || null]
        );
        summary.tagVotes += 1;
      }
    }
    for (const proposal of list(payload.tagProposals)) {
      const tag = text(proposal && proposal.tag);
      if (!tag) continue;
      const proposer = resolveCard(index, { memberId: proposal.proposerId, name: proposal.proposerName });
      const fallbackUserId = proposer.card ? proposer.card.user_id : row.user_id;
      const proposalResult = await db.query(
        `
        INSERT INTO incircle_member_tag_proposals (
          circle_id, target_member_card_id, proposed_by_user_id, tag, threshold, status, approved_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now()))
        ON CONFLICT (target_member_card_id, tag) DO UPDATE SET
          threshold = EXCLUDED.threshold,
          status = EXCLUDED.status,
          approved_at = COALESCE(incircle_member_tag_proposals.approved_at, EXCLUDED.approved_at),
          updated_at = now()
        RETURNING id
        `,
        [row.circle_id, row.id, fallbackUserId, tag, Math.max(2, Number(proposal.threshold || 2)), proposal.status === "已上墙" ? "approved" : "voting", proposal.approvedAt || null, proposal.createdAt || null]
      );
      const proposalId = proposalResult.rows[0].id;
      for (const [position, voter] of list(proposal.voters).entries()) {
        const resolved = resolveCard(index, voter);
        if (!resolved.card || resolved.card.user_id === row.user_id) {
          await addIssue(db, "0003-actions", "tag_proposal_vote", `${row.id}:${tag}:${position}`, resolved.card ? "self_vote_ignored" : resolved.ambiguous ? "ambiguous_voter" : "voter_not_found", { voter });
          summary.issues += 1;
          continue;
        }
        await db.query(
          `
          INSERT INTO incircle_member_tag_proposal_votes (proposal_id, voter_user_id, created_at)
          VALUES ($1, $2, COALESCE($3::timestamptz, now()))
          ON CONFLICT (proposal_id, voter_user_id) DO NOTHING
          `,
          [proposalId, resolved.card.user_id, voter.createdAt || null]
        );
        summary.proposalVotes += 1;
      }
    }
  }
}

async function main() {
  const db = createDatabase(loadConfig());
  const summary = {
    activityResponses: 0,
    voteBallots: 0,
    voteVetoes: 0,
    checkinRecords: 0,
    tagVotes: 0,
    proposalVotes: 0,
    issues: 0,
  };
  try {
    await db.withTransaction(async () => {
      const cardsResult = await db.query("SELECT * FROM incircle_member_cards ORDER BY created_at");
      const byCircle = new Map();
      cardsResult.rows.forEach((card) => {
        const key = String(card.circle_id);
        const rows = byCircle.get(key) || [];
        rows.push(card);
        byCircle.set(key, rows);
      });
      const indexes = new Map(Array.from(byCircle.entries()).map(([key, rows]) => [key, cardIndex(rows)]));
      await backfillActivities(db, indexes, summary);
      await backfillVotes(db, indexes, summary);
      await backfillCheckins(db, indexes, summary);
      await backfillTags(db, indexes, summary);
      await db.query(
        `
        WITH candidates AS (
          SELECT bills.id, (bills.payload->>'sourceActivityId')::uuid AS activity_id,
            row_number() OVER (
              PARTITION BY bills.payload->>'sourceActivityId'
              ORDER BY bills.created_at ASC, bills.id ASC
            ) AS position
          FROM incircle_bills bills
          WHERE bills.source_activity_id IS NULL
            AND bills.payload->>'sourceActivityId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            AND EXISTS (SELECT 1 FROM incircle_activities activity WHERE activity.id = (bills.payload->>'sourceActivityId')::uuid)
        )
        UPDATE incircle_bills bills
        SET source_activity_id = candidates.activity_id
        FROM candidates
        WHERE bills.id = candidates.id AND candidates.position = 1
        `
      );
    });
    console.log(JSON.stringify({ ok: true, summary }, null, 2));
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
