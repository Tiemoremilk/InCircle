const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { InCircleService, __test } = require("../src/services/incircle");
const clientInvite = require("../../inCircleClient/utils/invite");

const ROOT = path.resolve(__dirname, "../..");
const CIRCLE_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OLD_CODE = "ABCDEFGH";
const NEW_CODE = "Ab1#￥%&2";
const OLD_TOKEN = "0123456789abcdef0123456789abcdef";
const NEW_TOKEN = "fedcba9876543210fedcba9876543210";

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function normalizedSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function rotationHarness(t, options) {
  const source = options || {};
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "incircle-invite-rotate-"));
  t.after(() => fs.rmSync(uploadDir, { recursive: true, force: true }));
  const oldRelativePath = `qrcodes/${CIRCLE_ID}-invite-${OLD_TOKEN.slice(0, 12)}-wxacode.png`;
  const oldAbsolutePath = path.join(uploadDir, ...oldRelativePath.split("/"));
  fs.mkdirSync(path.dirname(oldAbsolutePath), { recursive: true });
  fs.writeFileSync(oldAbsolutePath, Buffer.alloc(128, 2));

  let circle = {
    id: CIRCLE_ID,
    name: "测试圈子",
    join_code: OLD_CODE,
    invite_token: OLD_TOKEN,
  };
  let qrRow = { circle_id: CIRCLE_ID, relative_path: oldRelativePath };
  let uniqueConflictsRemaining = Number(source.uniqueConflictCount || 0);
  let joinCodeGenerationCount = 0;
  let inviteTokenGenerationCount = 0;
  const logs = [];
  const queries = [];
  const db = {
    async withTransaction(callback) {
      return callback();
    },
    async query(sql, params) {
      const normalized = normalizedSql(sql);
      queries.push({ sql: normalized, params });
      if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) /.test(normalized)) {
        return { rows: [] };
      }
      if (normalized === "SELECT id, name, join_code, invite_token FROM incircle_circles WHERE id = $1 FOR UPDATE") {
        return { rows: [Object.assign({}, circle)] };
      }
      if (normalized.startsWith("SELECT role FROM incircle_circle_members")) {
        return { rows: source.role ? [{ role: source.role }] : [] };
      }
      if (normalized === "SELECT relative_path FROM incircle_circle_qr_codes WHERE circle_id = $1 LIMIT 1") {
        return { rows: qrRow ? [Object.assign({}, qrRow)] : [] };
      }
      if (normalized.startsWith("UPDATE incircle_circles SET join_code = $2, invite_token = $3")) {
        if (uniqueConflictsRemaining > 0) {
          uniqueConflictsRemaining -= 1;
          const error = new Error("duplicate invite credential");
          error.code = "23505";
          throw error;
        }
        circle = Object.assign({}, circle, { join_code: params[1], invite_token: params[2] });
        return { rows: [{ join_code: params[1], invite_token: params[2] }] };
      }
      if (normalized === "DELETE FROM incircle_circle_qr_codes WHERE circle_id = $1") {
        qrRow = null;
        return { rows: [] };
      }
      if (normalized === "SELECT * FROM incircle_circles WHERE invite_token = $1 LIMIT 1") {
        return { rows: params[0] === circle.invite_token ? [Object.assign({}, circle)] : [] };
      }
      if (normalized.includes('WHERE (join_code COLLATE "C") = ($1::text COLLATE "C") LIMIT 1')) {
        return { rows: params[0] === circle.join_code ? [Object.assign({}, circle)] : [] };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    },
  };
  const service = new InCircleService({
    db,
    config: { uploadDir, superAdminOpenids: source.platformSuperAdmin ? ["platform-admin"] : [] },
  }, {});
  service.requireUser = async () => ({
    identity: { openid: source.platformSuperAdmin ? "platform-admin" : "member-openid" },
    user: { id: USER_ID, nickname: "测试用户", is_super_admin: !!source.platformSuperAdmin },
  });
  service.createUniqueJoinCode = async () => {
    joinCodeGenerationCount += 1;
    return source.uniqueConflictCount && joinCodeGenerationCount === 1 ? "aB3@C4#D" : NEW_CODE;
  };
  service.createUniqueInviteToken = async () => {
    inviteTokenGenerationCount += 1;
    return source.uniqueConflictCount && inviteTokenGenerationCount === 1
      ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      : NEW_TOKEN;
  };
  service.logOperation = async (circleId, auth, action, targetType, targetId, payload) => {
    logs.push({ circleId, action, targetType, targetId, payload });
  };
  service.circleSettings = async () => ({
    circle: { id: CIRCLE_ID, name: circle.name },
    members: [],
    canManage: true,
    canExit: false,
    canDissolve: source.role === "圈主",
    inviteCode: circle.join_code,
    inviteToken: circle.invite_token,
    invitePath: `/pages/circle-join/index?token=${circle.invite_token}`,
  });
  return {
    service,
    logs,
    queries,
    oldAbsolutePath,
    circle: () => Object.assign({}, circle),
    qrRow: () => qrRow,
    joinCodeGenerationCount: () => joinCodeGenerationCount,
    inviteTokenGenerationCount: () => inviteTokenGenerationCount,
  };
}

test("invite codes use the full case-sensitive eight-character alphabet", () => {
  assert.equal(__test.isValidJoinCode(NEW_CODE), true);
  assert.equal(__test.isValidJoinCode("ab1#￥%&2"), true);
  assert.equal(__test.isValidJoinCode("Ab1#￥%&"), false);
  assert.equal(__test.isValidJoinCode("Ab1#￥%+2"), false);
  for (let index = 0; index < 200; index += 1) {
    assert.match(__test.createJoinCode(), /^[A-Za-z0-9@#￥%&]{8}$/);
  }
  assert.match(__test.createInviteToken(), /^[a-f0-9]{32}$/);
});

test("special-character invite codes survive login route handoffs without URL ambiguity", () => {
  const joinCode = "A%26#￥&b";
  const query = clientInvite.inviteQuery(joinCode, "");
  const encoded = query.replace(/^\?codeHex=/, "");

  assert.match(query, /^\?codeHex=[a-f0-9]{32}$/);
  assert.equal(clientInvite.decodeJoinCodeHex(encoded), joinCode);
  assert.deepEqual(clientInvite.parseInviteOptions({ codeHex: encoded }), {
    inviteToken: "",
    joinCode,
  });
});

test("legacy code-based share options are ignored while manual handoffs remain supported", () => {
  assert.deepEqual(clientInvite.parseInviteOptions({ code: OLD_CODE }), {
    inviteToken: "",
    joinCode: "",
  });
  assert.deepEqual(clientInvite.parseInviteOptions({ scene: OLD_CODE }), {
    inviteToken: "",
    joinCode: "",
  });
  assert.equal(clientInvite.parseInviteOptions({ token: NEW_TOKEN }).inviteToken, NEW_TOKEN);
});

for (const access of [
  { label: "circle owner", role: "圈主" },
  { label: "circle super admin", role: "超管" },
  { label: "platform super admin", platformSuperAdmin: true },
]) {
  test(`${access.label} rotates both credentials and invalidates the old QR`, async (t) => {
    const harness = rotationHarness(t, access);
    const result = await harness.service.rotateInviteCode({ circleId: CIRCLE_ID });

    assert.equal(result.inviteCode, NEW_CODE);
    assert.equal(result.inviteToken, NEW_TOKEN);
    assert.equal(result.invitePath, `/pages/circle-join/index?token=${NEW_TOKEN}`);
    assert.equal(harness.circle().join_code, NEW_CODE);
    assert.equal(harness.circle().invite_token, NEW_TOKEN);
    assert.equal(harness.qrRow(), null);
    assert.equal(fs.existsSync(harness.oldAbsolutePath), false);

    assert.equal((await harness.service.findCircleByInvite({ joinCode: OLD_CODE })).circle, null);
    assert.equal((await harness.service.findCircleByInvite({ inviteToken: OLD_TOKEN })).circle, null);
    assert.equal((await harness.service.findCircleByInvite({ joinCode: NEW_CODE })).circle.id, CIRCLE_ID);
    assert.equal((await harness.service.findCircleByInvite({ inviteToken: NEW_TOKEN })).circle.id, CIRCLE_ID);
    assert.equal((await harness.service.findCircleByInvite({ joinCode: NEW_CODE.toLowerCase() })).circle, null);

    assert.equal(harness.logs[0].action, "更换圈子邀请码");
    assert.deepEqual(harness.logs[0].payload, { hadQrCode: true });
    assert.doesNotMatch(JSON.stringify(harness.logs), new RegExp(`${OLD_CODE}|${NEW_CODE}|${OLD_TOKEN}|${NEW_TOKEN}`));
  });
}

for (const access of [
  { label: "ordinary members", role: "成员" },
  { label: "non-members", role: null },
]) {
  test(`${access.label} cannot rotate credentials or delete the current QR`, async (t) => {
    const harness = rotationHarness(t, access);
    await assert.rejects(
      harness.service.rotateInviteCode({ circleId: CIRCLE_ID }),
      (error) => error && error.errCode === "FORBIDDEN"
    );
    assert.equal(harness.circle().join_code, OLD_CODE);
    assert.equal(harness.circle().invite_token, OLD_TOKEN);
    assert.notEqual(harness.qrRow(), null);
    assert.equal(fs.existsSync(harness.oldAbsolutePath), true);
  });
}

test("rotation cleanup removes only the old tokenized file", (t) => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "incircle-invite-race-"));
  t.after(() => fs.rmSync(uploadDir, { recursive: true, force: true }));
  const folder = path.join(uploadDir, "qrcodes");
  fs.mkdirSync(folder, { recursive: true });
  const oldRelative = `qrcodes/${CIRCLE_ID}-invite-${OLD_TOKEN.slice(0, 12)}-wxacode.png`;
  const nextRelative = `qrcodes/${CIRCLE_ID}-invite-${NEW_TOKEN.slice(0, 12)}-wxacode.png`;
  fs.writeFileSync(path.join(uploadDir, ...oldRelative.split("/")), Buffer.alloc(128, 1));
  fs.writeFileSync(path.join(uploadDir, ...nextRelative.split("/")), Buffer.alloc(128, 2));

  const cleanup = __test.cleanupManagedUploads({ uploadDir }, { relativePaths: [oldRelative] });
  assert.deepEqual(cleanup.failed, []);
  assert.equal(fs.existsSync(path.join(uploadDir, ...oldRelative.split("/"))), false);
  assert.equal(fs.existsSync(path.join(uploadDir, ...nextRelative.split("/"))), true);
});

test("a database uniqueness conflict regenerates both invite credentials", async (t) => {
  const harness = rotationHarness(t, { role: "圈主", uniqueConflictCount: 1 });
  const result = await harness.service.rotateInviteCode({ circleId: CIRCLE_ID });

  assert.equal(result.inviteCode, NEW_CODE);
  assert.equal(result.inviteToken, NEW_TOKEN);
  assert.equal(harness.joinCodeGenerationCount(), 2);
  assert.equal(harness.inviteTokenGenerationCount(), 2);
});

test("migration, routes and clients expose tokenized invite rotation without cached stale QR", () => {
  const migration = read("server/db/migrations/0021_circle_invite_rotation.sql");
  const schema = read("server/db/schema.sql");
  const route = read("server/src/routes/incircle.js");
  const api = read("inCircleClient/utils/api.js");
  const joinPage = read("inCircleClient/pages/circle-join/index.js");
  const inviteClient = read("inCircleClient/utils/invite.js");
  const joinTemplate = read("inCircleClient/pages/circle-join/index.wxml");
  const login = read("inCircleClient/pages/login/index.js");
  const persistedReadTypes = api.match(/const PERSISTED_READ_TYPES\s*=\s*\{[\s\S]*?\n\};/);

  assert.match(migration, /ADD COLUMN IF NOT EXISTS invite_token text/);
  assert.match(migration, /join_code COLLATE "C"/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS incircle_circles_join_code_key/);
  assert.match(migration, /DROP INDEX IF EXISTS uq_incircle_circles_join_code/);
  assert.match(migration, /FOR target IN\s+SELECT id\s+FROM incircle_circles\s+LOOP/);
  assert.match(migration, /SET join_code = candidate, invite_token = token_candidate/);
  assert.match(migration, /DELETE FROM incircle_circle_qr_codes;/);
  assert.match(migration, /\^\[A-Za-z0-9@#￥%&\]\{8\}\$/);
  assert.match(schema, /uq_incircle_circles_invite_token/);
  assert.match(route, /case "incircleRotateInviteCode"/);
  assert.match(api, /incircleJoinPreview:\s*0/);
  assert.match(api, /incircleGetInviteQrCode:\s*0/);
  assert.ok(persistedReadTypes, "PERSISTED_READ_TYPES should remain a static object");
  assert.doesNotMatch(persistedReadTypes[0], /incircleGetInviteQrCode/);
  assert.match(api, /incircleRotateInviteCode:\s*\[[^\]]*incircleGetInviteQrCode/);
  assert.doesNotMatch(joinPage, /toUpperCase\(\)/);
  assert.match(joinPage, /invite\.normalizeJoinCode/);
  assert.match(joinPage, /inviteToken/);
  assert.match(inviteClient, /JOIN_CODE_CHARACTER = \/\^\[A-Za-z0-9@#￥%&\]\$\//);
  assert.match(inviteClient, /\?codeHex=/);
  assert.match(joinTemplate, /8 位邀请码，区分大小写/);
  assert.match(joinTemplate, /maxlength="8"/);
  assert.match(login, /nextInviteToken/);
  assert.match(login, /invite\.inviteQuery\(this\.data\.nextCode/);
});
