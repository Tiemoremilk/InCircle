const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { InCircleService, __test } = require("../src/services/incircle");

const ROOT = path.join(__dirname, "..", "..");
const CIRCLE_ID = "22222222-2222-4222-8222-222222222222";
const INVITE_TOKEN = "0123456789abcdef0123456789abcdef";

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function pngBuffer(fill) {
  const buffer = Buffer.alloc(256, fill || 1);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  return buffer;
}

function createQrHarness(t) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "incircle-qr-"));
  t.after(() => fs.rmSync(uploadDir, { recursive: true, force: true }));
  let qrRow = null;
  let generationCount = 0;
  let transactionTail = Promise.resolve();
  const db = {
    withTransaction(callback) {
      const result = transactionTail.then(() => callback());
      transactionTail = result.catch(() => {});
      return result;
    },
    async query(sql, params) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      if (normalized === "SELECT id, join_code, invite_token FROM incircle_circles WHERE id = $1 FOR UPDATE") {
        return { rows: [{ id: CIRCLE_ID, join_code: "ABCDEFGH", invite_token: INVITE_TOKEN }] };
      }
      if (normalized === "SELECT * FROM incircle_circle_qr_codes WHERE circle_id = $1 LIMIT 1") {
        return { rows: qrRow ? [Object.assign({}, qrRow)] : [] };
      }
      if (normalized.startsWith("INSERT INTO incircle_circle_qr_codes")) {
        qrRow = {
          circle_id: params[0],
          join_code: params[1],
          invite_token: params[2],
          page: params[3],
          env_version: params[4],
          relative_path: params[5],
          created_at: qrRow ? qrRow.created_at : "2026-07-14T00:00:00.000Z",
          updated_at: "2026-07-14T00:00:00.000Z",
        };
        return { rows: [Object.assign({}, qrRow)] };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    },
  };
  const service = new InCircleService({
    db,
    config: {
      uploadDir,
      publicBaseUrl: "https://api.example.com",
      wechatQrEnvVersion: "release",
    },
    async createMiniProgramCode(config, options) {
      generationCount += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return { buffer: pngBuffer(), extension: "png", envVersion: options.envVersion };
    },
  }, {});
  service.circleSettings = async () => ({
    circle: { id: CIRCLE_ID, name: "测试圈子" },
    inviteCode: "ABCDEFGH",
    inviteToken: INVITE_TOKEN,
  });
  return {
    service,
    uploadDir,
    generationCount: () => generationCount,
    qrRow: () => qrRow,
  };
}

test("one circle generates one persisted QR code and concurrent requests reuse it", async (t) => {
  const harness = createQrHarness(t);
  const oldFolder = path.join(harness.uploadDir, "qrcodes");
  fs.mkdirSync(oldFolder, { recursive: true });
  fs.writeFileSync(path.join(oldFolder, `${CIRCLE_ID}-ABCDEFGH-wxacode.png`), Buffer.alloc(128, 2));

  const [first, second] = await Promise.all([
    harness.service.inviteQrCode({ circleId: CIRCLE_ID, envVersion: "develop" }),
    harness.service.inviteQrCode({ circleId: CIRCLE_ID, envVersion: "trial" }),
  ]);

  assert.equal(harness.generationCount(), 1);
  assert.equal(first.imageUrl, second.imageUrl);
  assert.deepEqual([first.reused, second.reused].sort(), [false, true]);
  assert.equal(first.envVersion, "release", "the server environment controls the stored QR code");
  assert.equal(first.scene, INVITE_TOKEN);
  assert.equal(first.path, `/pages/circle-join/index?token=${INVITE_TOKEN}`);
  assert.match(harness.qrRow().relative_path, new RegExp(`invite-${INVITE_TOKEN.slice(0, 12)}-wxacode\\.png$`));
  assert.equal(fs.readdirSync(oldFolder).length, 1, "legacy duplicate files are removed");
  assert.equal(__test.usableQrCodeFile({ uploadDir: harness.uploadDir }, harness.qrRow().relative_path), true);
});

test("a missing persisted QR file is repaired on the next request", async (t) => {
  const harness = createQrHarness(t);
  const first = await harness.service.inviteQrCode({ circleId: CIRCLE_ID });
  const relativePath = harness.qrRow().relative_path;
  fs.rmSync(path.join(harness.uploadDir, ...relativePath.split("/")), { force: true });

  const repaired = await harness.service.inviteQrCode({ circleId: CIRCLE_ID });
  assert.equal(first.imageUrl, repaired.imageUrl);
  assert.equal(repaired.reused, false);
  assert.equal(harness.generationCount(), 2);
  assert.equal(__test.usableQrCodeFile({ uploadDir: harness.uploadDir }, relativePath), true);
});

test("circle cleanup physically removes every QR variant owned by that circle", (t) => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "incircle-qr-cleanup-"));
  t.after(() => fs.rmSync(uploadDir, { recursive: true, force: true }));
  const folder = path.join(uploadDir, "qrcodes");
  fs.mkdirSync(folder, { recursive: true });
  const current = `${CIRCLE_ID}-invite-wxacode.png`;
  const legacy = `${CIRCLE_ID}-ABCDEFGH-wxacode.png`;
  const other = "44444444-4444-4444-8444-444444444444-invite-wxacode.png";
  [current, legacy, other].forEach((filename) => fs.writeFileSync(path.join(folder, filename), Buffer.alloc(128, 3)));

  const cleanup = __test.cleanupManagedUploads({ uploadDir }, { circleIds: [CIRCLE_ID] });
  assert.deepEqual(cleanup.failed, []);
  assert.equal(fs.existsSync(path.join(folder, current)), false);
  assert.equal(fs.existsSync(path.join(folder, legacy)), false);
  assert.equal(fs.existsSync(path.join(folder, other)), true);
});

test("QR metadata cascades with circle deletion and all delete flows collect its file", () => {
  const migration = read("server/db/migrations/0020_circle_invite_qr_codes.sql");
  const schema = read("server/db/schema.sql");
  const service = read("server/src/services/incircle.js");

  assert.match(migration, /circle_id uuid PRIMARY KEY REFERENCES incircle_circles\(id\) ON DELETE CASCADE/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS incircle_circle_qr_codes/);
  assert.match(service, /SELECT relative_path FROM incircle_circle_qr_codes/);
  assert.match(service, /async dissolveCircle[\s\S]*bestEffortCleanupManagedUploads\(this\.config, \{ relativePaths: mediaPaths, circleIds: \[circleId\] \}\)/);
});
