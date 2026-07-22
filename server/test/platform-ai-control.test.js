const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { AiService } = require("../src/services/ai");
const { InCircleService } = require("../src/services/incircle");

const ROOT = path.resolve(__dirname, "../..");
function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("platform AI control uses a new singleton migration and is wired through the admin API", () => {
  const migration = read("server/db/migrations/0026_platform_circle_ai_control.sql");
  const schema = read("server/db/schema.sql");
  const routes = read("server/src/routes/incircle.js");
  const api = read("inCircleClient/utils/api.js");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS incircle_platform_settings/);
  assert.match(migration, /circle_ai_enabled boolean NOT NULL DEFAULT true/);
  assert.match(migration, /CHECK \(singleton_id = 1\)/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS incircle_platform_settings/);
  assert.match(read("server/src/services/ai.js"), /\), false\) AS platform_ai_enabled/);
  assert.match(routes, /incircleAdminUpdatePlatformAi/);
  assert.match(api, /function adminUpdatePlatformAi\(circleAiEnabled\)/);
  assert.match(api, /incircleAdminUpdatePlatformAi:\s*\[/);
});

test("platform-off state is enforced by AI member and manager guards", async () => {
  const service = new AiService({ db: {}, config: {} }, {});
  service.accessContext = async () => ({
    isMember: true,
    canManage: true,
    platformAiEnabled: false,
    circle: { status: "active" },
  });

  await assert.rejects(
    service.requireMember({}),
    (error) => error && error.errCode === "AI_PLATFORM_DISABLED" && error.statusCode === 403
  );
  await assert.rejects(
    service.requireManager({}),
    (error) => error && error.errCode === "AI_PLATFORM_DISABLED" && error.statusCode === 403
  );
});

test("AI status stays readable but cannot chat while the platform switch is off", async () => {
  const service = new AiService({ db: {}, config: {} }, {});
  service.accessContext = async () => ({
    auth: { user: { id: "user-1" } },
    circleId: "circle-1",
    circle: { name: "测试圈", status: "active" },
    isMember: true,
    isSuperAdmin: false,
    canManage: true,
    platformAiEnabled: false,
  });
  service.readSettings = async () => ({ enabled: true, assistant_name: "圈内 AI" });
  service.enabledModels = async () => { throw new Error("models must not load while platform AI is off"); };
  service.usageCounts = async () => { throw new Error("usage must not load while platform AI is off"); };

  const status = await service.status({});
  assert.equal(status.platformEnabled, false);
  assert.equal(status.enabled, true);
  assert.equal(status.canChat, false);
  assert.equal(status.modelCount, 0);
  assert.match(status.unavailableReason, /平台当前未开放/);
});

test("only a platform super admin can persist the global AI switch and the change is audited", async () => {
  const queries = [];
  const logs = [];
  const db = {
    async withTransaction(callback) { return callback(); },
    async query(sql, params) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      queries.push({ sql: normalized, params });
      if (normalized.startsWith("INSERT INTO incircle_platform_settings")) {
        return {
          rows: [{
            circle_ai_enabled: params[0],
            updated_by_user_id: params[1],
            updated_at: "2026-07-17T00:00:00.000Z",
          }],
        };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    },
  };
  const service = new InCircleService({ db, config: { superAdminOpenids: [] } }, {});
  service.requireSuperAdmin = async () => ({
    identity: { openid: "admin-openid" },
    user: { id: "admin-user", nickname: "超管" },
  });
  service.logOperation = async (...args) => logs.push(args);

  const result = await service.adminUpdatePlatformAi({ circleAiEnabled: false });
  assert.equal(result.platformSettings.circleAiEnabled, false);
  assert.equal(queries[0].params[0], false);
  assert.match(logs[0][2], /关闭平台圈内AI/);
  assert.deepEqual(logs[0][5], { circleAiEnabled: false });
});

test("platform switch hides circle AI settings and forces the five-tab FAB to refresh", () => {
  const adminTemplate = read("inCircleClient/pages/admin/index.wxml");
  const adminStyles = read("inCircleClient/pages/admin/index.wxss");
  const circleTemplate = read("inCircleClient/pages/circle-settings/index.wxml");
  const circleScript = read("inCircleClient/pages/circle-settings/index.js");
  const fabScript = read("inCircleClient/components/ai-fab/index.js");

  assert.match(adminTemplate, /class="capability-group card/);
  assert.equal((adminTemplate.match(/class="capability-item(?:\s[^"]*)?"/g) || []).length, 2);
  assert.equal((adminTemplate.match(/>联网搜索</g) || []).length, 1);
  assert.equal(adminTemplate.indexOf(">平台能力<") < adminTemplate.indexOf(">联网搜索<"), true);
  assert.equal(adminTemplate.indexOf(">圈内 AI<") < adminTemplate.indexOf(">联网搜索<"), true);
  assert.match(adminTemplate, /checked="\{\{platformSettings\.circleAiEnabled\}\}"/);
  assert.match(adminTemplate, /disabled="\{\{platformSearchBusy \|\| !platformSettings\.circleAiEnabled \|\| !platformSettings\.webSearchConfigured\}\}"/);
  assert.match(adminTemplate, /color="\{\{themePrimary\}\}"/);
  assert.match(adminStyles, /\.capability-icon image\s*\{[^}]*var\(--theme-icon-filter/s);
  assert.match(adminStyles, /\.capability-divider\s*\{/);
  assert.match(adminStyles, /\.capability-dependent\s*\{[^}]*padding-left:\s*21rpx/s);
  assert.doesNotMatch(adminTemplate, /capability-relation/);
  assert.match(circleTemplate, /wx:if="\{\{platformAiEnabled && aiStatus && aiStatus\.canManage\}\}"/);
  assert.match(circleScript, /getCircleSettings\(this\.data\.circleId, \{ force: true \}\)/);
  assert.match(fabScript, /getAiStatus\(circleId, \{ force: true \}\)/);
});

test("legal text describes third-party model boundaries without disclaiming platform governance", () => {
  const legal = read("inCircleClient/utils/legal.js");
  assert.match(legal, /不自行研发、训练或部署生成式人工智能模型/);
  assert.match(legal, /自主配置其已合法开通且有权使用的第三方模型服务/);
  assert.match(legal, /不提供图片、音频或视频生成/);
  assert.match(legal, /仍会按照本协议及《InCircle 隐私政策》履行权限控制和安全治理责任/);
});
