const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");

const {
  decryptCredential,
  encryptCredential,
  maskedCredential,
} = require("../src/services/ai/credentials");
const { blockedIp, parseHttpsUrl, requestOnce } = require("../src/services/ai/network");
const { catalogModelCapabilities } = require("../src/services/ai/model-capabilities");
const {
  completionRequest,
  consumeEventStream,
  jsonDelta,
  listProviderPresets,
  normalizeProviderStreamError,
  providerModelMetadata,
  providerModelTokenCapabilities,
  providerOutputLimitRejected,
  providerOutputTokenLimit,
  providerFinishReason,
  reasoningCapability,
  resolveReasoningMode,
  streamProviderCompletion,
} = require("../src/services/ai/providers");
const { validEncryptionKey } = require("../src/config");
const {
  aiAccessFlags,
  AiService,
  publicModel,
  publicProvider,
  recoverExpiredAiGenerations,
  registerActiveGeneration,
} = require("../src/services/ai");
const { exchangeWechatLoginCode } = require("../src/services/wechat");
const { AppError } = require("../src/errors");
const { streamFrame, watchClientDisconnect } = require("../src/routes/ai");

async function withPublicDns(callback) {
  const originalLookup = dns.lookup;
  dns.lookup = async () => [{ address: "8.8.8.8", family: 4 }];
  try {
    return await callback();
  } finally {
    dns.lookup = originalLookup;
  }
}

function providerRow(overrides) {
  return Object.assign({
    id: "11111111-1111-4111-8111-111111111111",
    circle_id: "22222222-2222-4222-8222-222222222222",
    protocol: "openai",
    preset_key: "openai",
    name: "OpenAI",
    base_url: "https://api.openai.com/v1",
    credential_ciphertext: "encrypted",
    credential_last_four: "1234",
    privacy_url: "https://openai.com/policies/privacy-policy/",
    privacy_version: 1,
    api_version: "",
    azure_deployment: "",
    enabled: true,
    archived: false,
    is_custom: false,
    last_test_status: "success",
    last_test_error_code: "",
  }, overrides || {});
}

test("AI credentials use authenticated encryption and never expose plaintext", () => {
  const config = { aiCredentialsEncryptionKey: crypto.randomBytes(32).toString("hex") };
  const secret = "test-credential-value-1234";
  const first = encryptCredential(config, secret);
  const second = encryptCredential(config, secret);
  assert.notEqual(first, second);
  assert.equal(first.includes(secret), false);
  assert.equal(decryptCredential(config, first), secret);
  assert.equal(maskedCredential("1234"), "••••••••1234");
});

test("tampered AI credential ciphertext is rejected", () => {
  const config = { aiCredentialsEncryptionKey: crypto.randomBytes(32).toString("base64") };
  const encrypted = encryptCredential(config, "secret-value");
  const last = encrypted.slice(-1) === "A" ? "B" : "A";
  assert.throws(() => decryptCredential(config, `${encrypted.slice(0, -1)}${last}`), /无法解密/);
});

test("AI encryption key accepts only exactly 32 bytes", () => {
  assert.equal(validEncryptionKey(crypto.randomBytes(32).toString("hex")), true);
  assert.equal(validEncryptionKey(crypto.randomBytes(32).toString("base64")), true);
  assert.equal(validEncryptionKey("short"), false);
});

test("provider URL validation blocks local and credential-bearing targets", () => {
  assert.throws(() => parseHttpsUrl("http://api.example.com/v1"), /HTTPS/);
  assert.throws(() => parseHttpsUrl("https://127.0.0.1/v1"), /本机或内网/);
  assert.throws(() => parseHttpsUrl("https://169.254.169.254/latest/meta-data"), /本机或内网/);
  assert.throws(() => parseHttpsUrl("https://[::1]/v1"), /本机或内网/);
  assert.throws(() => parseHttpsUrl("https://[::ffff:7f00:1]/v1"), /本机或内网/);
  assert.throws(() => parseHttpsUrl("https://user:pass@example.com/v1"), /账号或密码/);
  assert.equal(parseHttpsUrl("https://api.example.com/v1").hostname, "api.example.com");
});

test("private and link-local IP ranges are blocked", () => {
  ["10.0.0.1", "172.16.0.1", "192.168.1.1", "127.0.0.1", "100.64.0.1", "::1", "::ffff:7f00:1", "fd00::1", "fe80::1", "ff02::1"].forEach(
    (address) => assert.equal(blockedIp(address), true, address)
  );
  assert.equal(blockedIp("8.8.8.8"), false);
  assert.equal(blockedIp("2606:4700:4700::1111"), false);
});

test("custom provider preset visibility follows the explicit custom-provider permission", () => {
  assert.equal(listProviderPresets(false).some((item) => item.key === "custom"), false);
  assert.equal(listProviderPresets(true).some((item) => item.key === "custom"), true);
});

test("AI configuration permission allows only circle owners and global super admins", () => {
  const owner = aiAccessFlags(
    { owner_user_id: "user-owner", membership_id: "member-1", membership_status: "active", membership_role: "圈主" },
    "user-owner",
    false
  );
  const circleSuperAdmin = aiAccessFlags(
    { owner_user_id: "user-owner", membership_id: "member-2", membership_status: "active", membership_role: "超管" },
    "user-circle-super",
    false
  );
  const legacyAdmin = aiAccessFlags(
    { owner_user_id: "user-owner", membership_id: "member-3", membership_status: "active", membership_role: "管理员" },
    "user-legacy-admin",
    false
  );
  const member = aiAccessFlags(
    { owner_user_id: "user-owner", membership_id: "member-4", membership_status: "active", membership_role: "成员" },
    "user-member",
    false
  );
  const platformSuperAdmin = aiAccessFlags(
    { owner_user_id: "user-owner", membership_id: null, membership_status: null, membership_role: null },
    "user-super",
    true
  );
  assert.equal(owner.canManage, true);
  assert.equal(owner.canUseCustomProvider, true);
  assert.equal(circleSuperAdmin.isMember, true);
  assert.equal(circleSuperAdmin.isOwner, false);
  assert.equal(circleSuperAdmin.isCircleSuperAdmin, false);
  assert.equal(circleSuperAdmin.isSuperAdmin, false);
  assert.equal(circleSuperAdmin.canManage, false);
  assert.equal(circleSuperAdmin.canUseCustomProvider, false);
  assert.equal(legacyAdmin.isMember, true);
  assert.equal(legacyAdmin.canManage, false);
  assert.equal(legacyAdmin.canUseCustomProvider, false);
  assert.equal(member.canManage, false);
  assert.equal(member.canUseCustomProvider, false);
  assert.equal(platformSuperAdmin.isMember, false);
  assert.equal(platformSuperAdmin.isCircleSuperAdmin, false);
  assert.equal(platformSuperAdmin.isSuperAdmin, true);
  assert.equal(platformSuperAdmin.canManage, true);
  assert.equal(platformSuperAdmin.canUseCustomProvider, true);
});

test("AI manager gate rejects circle admin roles and accepts a non-member global super admin", async () => {
  const service = new AiService({ db: {}, config: {} }, {});
  const baseContext = {
    circleId: "22222222-2222-4222-8222-222222222222",
    circle: { status: "active" },
    platformAiEnabled: true,
    auth: { user: { id: "user-current" } },
  };

  for (const membershipRole of ["超管", "管理员"]) {
    service.accessContext = async () => ({
      ...baseContext,
      ...aiAccessFlags({
        owner_user_id: "user-owner",
        membership_id: `member-${membershipRole}`,
        membership_status: "active",
        membership_role: membershipRole,
      }, "user-current", false),
    });
    await assert.rejects(
      () => service.requireManager({ circleId: baseContext.circleId }),
      (error) => error.statusCode === 403 && error.errCode === "AI_CONFIG_FORBIDDEN",
      membershipRole
    );
  }

  service.accessContext = async () => ({
    ...baseContext,
    ...aiAccessFlags({
      owner_user_id: "user-owner",
      membership_id: null,
      membership_status: null,
      membership_role: null,
    }, "user-current", true),
  });
  const context = await service.requireManager({ circleId: baseContext.circleId });
  assert.equal(context.isMember, false);
  assert.equal(context.isSuperAdmin, true);
  assert.equal(context.canManage, true);
});

test("custom provider preset is visible to circle owners and platform super admins only", async () => {
  const cases = [
    {
      label: "circle owner",
      access: {
        isOwner: true,
        isSuperAdmin: false,
        canManage: true,
        canUseCustomProvider: true,
      },
      expected: true,
    },
    {
      label: "platform super admin",
      access: {
        isOwner: false,
        isSuperAdmin: true,
        canManage: true,
        canUseCustomProvider: true,
      },
      expected: true,
    },
  ];

  for (const item of cases) {
    const service = new AiService({ db: {}, config: {} }, {});
    service.requireManager = async () => ({
      circleId: "22222222-2222-4222-8222-222222222222",
      auth: { user: { id: "33333333-3333-4333-8333-333333333333" } },
      ...item.access,
    });
    service.providerRows = async () => ({ rows: [] });

    const result = await service.listProviders({ circleId: "22222222-2222-4222-8222-222222222222" });
    assert.equal(
      result.presets.some((preset) => preset.key === "custom"),
      item.expected,
      `${item.label} custom preset visibility`
    );
    assert.equal(result.canUseCustomBaseUrl, item.expected, `${item.label} custom save capability`);
  }
});

test("circle AI can stay enabled before a provider or default model is configured", async () => {
  const service = new AiService({ db: {}, config: {} }, {});
  service.accessContext = async () => ({
    circleId: "circle-1",
    circle: { name: "测试圈", status: "active" },
    auth: { user: { id: "user-1" } },
    isMember: true,
    isSuperAdmin: false,
    canManage: true,
  });
  service.readSettings = async () => ({
    enabled: true,
    assistant_name: "圈内 AI",
    quick_prompts: [],
    member_daily_limit: 20,
    circle_daily_limit: 200,
    max_output_tokens: 2048,
  });
  service.enabledModels = async () => [];
  service.usageCounts = async () => ({ circleUsed: 0, memberUsed: 0 });
  const status = await service.status({ circleId: "circle-1" });
  assert.equal(status.enabled, true);
  assert.equal(status.configured, false);
  assert.equal(status.canChat, false);
});

test("enabling circle AI does not require a default model", async () => {
  const queries = [];
  const db = {
    async query(text, params) {
      queries.push({ text, params });
      return { rows: [] };
    },
  };
  const service = new AiService({ db, config: {} }, {});
  service.requireManager = async () => ({
    circleId: "circle-1",
    auth: { user: { id: "user-1" } },
  });
  service.ensureSettings = async () => ({
    enabled: false,
    assistant_name: "圈内 AI",
    system_prompt: "保持准确",
    quick_prompts: [],
    member_daily_limit: 20,
    circle_daily_limit: 200,
    max_output_tokens: 2048,
    default_model_id: null,
  });
  service.settings = async () => ({ enabled: true, configured: false, canChat: false });
  service.core.logOperation = async () => {};
  const result = await service.updateSettings({ circleId: "circle-1", patch: { enabled: true } });
  assert.equal(result.enabled, true);
  assert.equal(result.configured, false);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].params[1], true);
  assert.equal(queries[0].params[8], "");
});

test("built-in AI providers cannot be added twice to the same circle", async () => {
  await withPublicDns(async () => {
    const db = {
      async query(text) {
        if (String(text).includes("FROM incircle_ai_providers")) {
          return { rows: [{ id: "11111111-1111-4111-8111-111111111111" }] };
        }
        throw new Error("unexpected write");
      },
    };
    const service = new AiService({ db, config: {} }, {});
    service.requireManager = async () => ({
      circleId: "22222222-2222-4222-8222-222222222222",
      isSuperAdmin: false,
      auth: { user: { id: "33333333-3333-4333-8333-333333333333" } },
    });
    await assert.rejects(
      () => service.saveProvider({ provider: { presetKey: "openai", apiKey: "secret" } }),
      (error) => error.errCode === "AI_PROVIDER_ALREADY_EXISTS" && !!error.details.providerId
    );
  });
});

test("failed provider validation never persists the draft", async () => {
  await withPublicDns(async () => {
    let transactionStarted = false;
    const db = {
      async query() { return { rows: [] }; },
      async withTransaction() { transactionStarted = true; },
    };
    const service = new AiService({ db, config: {} }, {});
    service.requireManager = async () => ({
      circleId: "22222222-2222-4222-8222-222222222222",
      isSuperAdmin: false,
      auth: { user: { id: "33333333-3333-4333-8333-333333333333" } },
    });
    service.testProviderConnection = async () => {
      throw new AppError("密钥无效", { statusCode: 502, errCode: "AI_PROVIDER_AUTH_FAILED" });
    };
    await assert.rejects(
      () => service.saveProvider({
        validateBeforeSave: true,
        provider: { presetKey: "openai", apiKey: "bad-secret" },
      }),
      (error) => error.errCode === "AI_PROVIDER_AUTH_FAILED"
    );
    assert.equal(transactionStarted, false);
  });
});

test("validated provider saves discovered models without exposing internal model drafts", async () => {
  await withPublicDns(async () => {
    const queries = [];
    const savedProvider = providerRow();
    const db = {
      async query(text, params) {
        const sql = String(text);
        queries.push({ sql, params });
        if (sql.includes("SELECT id FROM incircle_ai_providers")) return { rows: [] };
        if (sql.includes("INSERT INTO incircle_ai_providers")) return { rows: [savedProvider] };
        if (sql.includes("last_test_status = 'success'")) return { rows: [savedProvider] };
        return { rows: [] };
      },
      async withTransaction(callback) { return callback(); },
    };
    const service = new AiService({
      db,
      config: { aiCredentialsEncryptionKey: crypto.randomBytes(32).toString("hex") },
    }, {});
    service.requireManager = async () => ({
      circleId: savedProvider.circle_id,
      isSuperAdmin: false,
      auth: { user: { id: "33333333-3333-4333-8333-333333333333" } },
    });
    service.testProviderConnection = async () => ({
      ok: true,
      modelCount: 1,
      latencyMs: 12,
      models: [{
        modelId: "gpt-test",
        displayName: "GPT Test",
        contextWindow: 1000000,
        maxOutputTokens: 32768,
        metadata: { supportedParameters: ["reasoning_effort"] },
      }],
    });
    service.core.logOperation = async () => {};
    const result = await service.saveProvider({
      validateBeforeSave: true,
      provider: { presetKey: "openai", apiKey: "valid-secret" },
    });
    const modelInsert = queries.find((entry) => entry.sql.includes("INSERT INTO incircle_ai_models"));
    assert.equal(!!modelInsert, true);
    const storedModel = JSON.parse(modelInsert.params[2])[0];
    assert.deepEqual(storedModel.metadata, { supportedParameters: ["reasoning_effort"] });
    assert.equal(storedModel.context_window, 1000000);
    assert.equal(storedModel.context_window_source, "sync");
    assert.equal(storedModel.max_output_tokens, 32768);
    assert.equal(storedModel.max_output_tokens_source, "sync");
    assert.match(modelInsert.sql, /max_output_tokens_source = 'manual' THEN incircle_ai_models\.max_output_tokens/);
    assert.equal(result.testResult.modelsSynced, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(result.testResult, "models"), false);
    assert.equal(JSON.stringify(result).includes("valid-secret"), false);
  });
});

test("provider API responses expose only a credential mask", () => {
  const result = publicProvider({
    id: "provider-1",
    preset_key: "openai",
    protocol: "openai",
    name: "OpenAI",
    base_url: "https://api.openai.com/v1",
    credential_ciphertext: "encrypted-secret-payload",
    credential_last_four: "1234",
    privacy_url: "https://openai.com/privacy",
    privacy_version: 1,
    enabled: true,
    archived: false,
  });
  assert.equal(result.credentialMask, "••••••••1234");
  assert.equal(result.hasCredential, true);
  assert.equal(JSON.stringify(result).includes("encrypted-secret-payload"), false);
});

test("model tests call the selected model and persist model-level health", async () => {
  const config = { aiCredentialsEncryptionKey: crypto.randomBytes(32).toString("hex") };
  const model = {
    id: "44444444-4444-4444-8444-444444444444",
    circle_id: "22222222-2222-4222-8222-222222222222",
    provider_id: "11111111-1111-4111-8111-111111111111",
    provider_name: "Custom AI",
    preset_key: "custom",
    protocol: "openai",
    base_url: "https://api.example.com/v1",
    api_version: "",
    azure_deployment: "",
    credential_ciphertext: encryptCredential(config, "model-test-secret"),
    provider_enabled: true,
    provider_archived: false,
    model_id: "selected-model",
    display_name: "Selected Model",
    archived: false,
    context_window: 0,
    context_window_source: "",
    max_output_tokens: 0,
    max_output_tokens_source: "",
  };
  const writes = [];
  const db = {
    async query(text, params) {
      const sql = String(text);
      if (sql.includes("SELECT model.*") && sql.includes("credential_ciphertext")) return { rows: [model] };
      if (sql.includes("UPDATE incircle_ai_models") || sql.includes("UPDATE incircle_ai_providers")) {
        writes.push({ sql, params });
        return { rows: [] };
      }
      if (sql.includes("FROM incircle_ai_model_capability_catalog")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
    async withTransaction(callback) { return callback(); },
  };
  const service = new AiService({ db, config }, { listProviderModels: async () => [] });
  service.requireManager = async () => ({
    circleId: model.circle_id,
    isSuperAdmin: false,
    auth: { user: { id: "33333333-3333-4333-8333-333333333333" } },
  });
  const requestedLimits = [];
  service.runProviderCompletion = async (options) => {
    assert.equal(options.model.model_id, "selected-model");
    requestedLimits.push(options.maxTokens);
    await options.onDelta("OK");
    return { inputTokens: 4, outputTokens: 1 };
  };
  service.core.logOperation = async () => {};

  const result = await service.testModel({ circleId: model.circle_id, modelId: model.id });
  assert.equal(result.ok, true);
  assert.equal(result.modelId, model.id);
  assert.equal(result.reply, "OK");
  assert.deepEqual(requestedLimits, [16, 131072]);
  assert.equal(result.capabilities.maxOutputTokens, 131072);
  assert.equal(result.capabilities.maxOutputTokensSource, "probe");
  assert.deepEqual(result.capabilityDetection.updatedFields, ["maxOutputTokens"]);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].params[2], "success");
  assert.equal(writes[0].params[7], 131072);
  assert.equal(writes[0].params[8], "probe");
  assert.equal(writes[1].params[2], "success");
});

test("model tests refresh provider metadata without overwriting manual capabilities", async () => {
  const config = { aiCredentialsEncryptionKey: crypto.randomBytes(32).toString("hex") };
  const model = {
    id: "44444444-4444-4444-8444-444444444444",
    circle_id: "22222222-2222-4222-8222-222222222222",
    provider_id: "11111111-1111-4111-8111-111111111111",
    provider_name: "OpenAI",
    preset_key: "openai",
    protocol: "openai",
    base_url: "https://api.openai.com/v1",
    credential_ciphertext: encryptCredential(config, "model-test-secret"),
    provider_enabled: true,
    provider_archived: false,
    model_id: "gpt-4.1-mini",
    display_name: "GPT-4.1 mini",
    archived: false,
    context_window: 200000,
    context_window_source: "manual",
    max_output_tokens: 0,
    max_output_tokens_source: "",
  };
  let modelUpdateParams = null;
  const db = {
    async query(text, params) {
      const sql = String(text);
      if (sql.includes("SELECT model.*") && sql.includes("credential_ciphertext")) return { rows: [model] };
      if (sql.includes("UPDATE incircle_ai_models")) {
        modelUpdateParams = params;
        return { rows: [] };
      }
      if (sql.includes("UPDATE incircle_ai_providers")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
    async withTransaction(callback) { return callback(); },
  };
  const service = new AiService({ db, config }, {
    listProviderModels: async () => [{
      modelId: model.model_id,
      contextWindow: 1000000,
      contextWindowSource: "sync",
      maxOutputTokens: 65536,
      maxOutputTokensSource: "sync",
    }],
  });
  service.requireManager = async () => ({
    circleId: model.circle_id,
    auth: { user: { id: "33333333-3333-4333-8333-333333333333" } },
  });
  const requestedLimits = [];
  service.runProviderCompletion = async (options) => {
    requestedLimits.push(options.maxTokens);
    await options.onDelta("OK");
  };
  service.core.logOperation = async () => {};

  const result = await service.testModel({ circleId: model.circle_id, modelId: model.id });
  assert.deepEqual(requestedLimits, [16]);
  assert.equal(result.capabilities.contextWindow, 200000);
  assert.equal(result.capabilities.contextWindowSource, "manual");
  assert.equal(result.capabilities.maxOutputTokens, 65536);
  assert.equal(result.capabilities.maxOutputTokensSource, "sync");
  assert.deepEqual(result.capabilityDetection.updatedFields, ["maxOutputTokens"]);
  assert.equal(modelUpdateParams[5], 200000);
  assert.equal(modelUpdateParams[6], "manual");
  assert.equal(modelUpdateParams[7], 65536);
  assert.equal(modelUpdateParams[8], "sync");
});

test("failed model tests persist failure without exposing credentials", async () => {
  const config = { aiCredentialsEncryptionKey: crypto.randomBytes(32).toString("hex") };
  const model = {
    id: "44444444-4444-4444-8444-444444444444",
    circle_id: "22222222-2222-4222-8222-222222222222",
    provider_id: "11111111-1111-4111-8111-111111111111",
    provider_name: "Custom AI",
    protocol: "openai",
    base_url: "https://api.example.com/v1",
    credential_ciphertext: encryptCredential(config, "model-test-secret"),
    provider_enabled: true,
    provider_archived: false,
    model_id: "selected-model",
    display_name: "Selected Model",
    archived: false,
  };
  const statuses = [];
  const db = {
    async query(text, params) {
      const sql = String(text);
      if (sql.includes("SELECT model.*") && sql.includes("credential_ciphertext")) return { rows: [model] };
      if (sql.includes("last_test_status")) {
        statuses.push(params[2]);
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async withTransaction(callback) { return callback(); },
  };
  const service = new AiService({ db, config }, { listProviderModels: async () => [] });
  service.requireManager = async () => ({
    circleId: model.circle_id,
    auth: { user: { id: "33333333-3333-4333-8333-333333333333" } },
  });
  service.runProviderCompletion = async () => {
    throw new AppError("供应商没有找到这个模型", { statusCode: 502, errCode: "AI_MODEL_NOT_FOUND" });
  };
  await assert.rejects(
    () => service.testModel({ circleId: model.circle_id, modelId: model.id }),
    (error) => error.errCode === "AI_MODEL_NOT_FOUND"
  );
  assert.deepEqual(statuses, ["failed", "failed"]);
});

test("model API responses expose persisted test status", () => {
  const model = publicModel({
    id: "model-1",
    model_id: "demo",
    display_name: "Demo",
    enabled: true,
    last_test_status: "success",
    last_test_error_code: "",
    last_test_latency_ms: 321,
    last_tested_at: "2026-07-12T00:00:00.000Z",
    context_window: 1000000,
    context_window_source: "manual",
    max_output_tokens: 32768,
    max_output_tokens_source: "sync",
  });
  assert.equal(model.lastTestStatus, "success");
  assert.equal(model.lastTestLatencyMs, 321);
  assert.equal(model.lastTestedAt, "2026-07-12T00:00:00.000Z");
  assert.equal(model.contextWindow, 1000000);
  assert.equal(model.contextWindowSource, "manual");
  assert.equal(model.maxOutputTokens, 32768);
  assert.equal(model.maxOutputTokensSource, "sync");
});

test("all four provider protocols build isolated text completion requests", () => {
  const messages = [{ role: "user", content: "hello" }];
  const model = { model_id: "demo-model" };
  const openai = completionRequest(
    { protocol: "openai", base_url: "https://api.example.com/v1" }, model, "secret", messages, "system", 256
  );
  assert.match(openai.url, /chat\/completions$/);
  assert.equal(openai.headers.accept, "text/event-stream");
  assert.equal(openai.headers["cache-control"], "no-cache");
  assert.equal(openai.body.model, "demo-model");
  assert.equal(openai.body.messages[0].role, "system");

  const anthropic = completionRequest(
    { protocol: "anthropic", base_url: "https://api.example.com" }, model, "secret", messages, "system", 256
  );
  assert.match(anthropic.url, /v1\/messages$/);
  assert.equal(anthropic.body.system, "system");
  assert.equal(anthropic.body.messages.length, 1);

  const gemini = completionRequest(
    { protocol: "gemini", base_url: "https://api.example.com/v1beta" }, model, "secret", messages, "system", 256
  );
  assert.match(gemini.url, /demo-model:streamGenerateContent\?alt=sse$/);
  assert.equal(gemini.body.contents[0].role, "user");

  const azure = completionRequest(
    {
      protocol: "azure",
      base_url: "https://resource.openai.azure.com",
      azure_deployment: "production-chat",
      api_version: "2024-10-21",
    },
    model,
    "secret",
    messages,
    "system",
    256
  );
  assert.match(azure.url, /deployments\/production-chat\/chat\/completions\?api-version=2024-10-21$/);
  assert.equal(azure.body.messages[0].content, "system");

  const modernOpenAi = completionRequest(
    { protocol: "openai", base_url: "https://api.openai.com/v1" },
    { model_id: "gpt-5.1" },
    "secret",
    messages,
    "system",
    4096
  );
  assert.equal(modernOpenAi.body.max_completion_tokens, 4096);
  assert.equal(typeof modernOpenAi.body.max_tokens, "undefined");
  assert.equal(typeof modernOpenAi.body.stream_options, "undefined");
});

test("AI Mini Program client transport uses standard SSE frames", () => {
  const frame = streamFrame({ type: "delta", content: "逐段输出" });
  assert.equal(frame, `data: ${JSON.stringify({ type: "delta", content: "逐段输出" })}\n\n`);
});

test("reasoning mode changes the actual request body for supported providers", () => {
  const messages = [{ role: "user", content: "请分析" }];
  const request = (provider, modelId, mode, maxTokens) => completionRequest(
    provider,
    { model_id: modelId },
    "secret",
    messages,
    "system",
    maxTokens || 4096,
    { reasoningMode: mode }
  );

  const glmAuto = request({ protocol: "openai", preset_key: "zhipu", base_url: "https://open.bigmodel.cn/api/paas/v4" }, "glm-4.5", "auto");
  const glmOn = request({ protocol: "openai", preset_key: "zhipu", base_url: "https://open.bigmodel.cn/api/paas/v4" }, "glm-4.5", "on");
  const glmOff = request({ protocol: "openai", preset_key: "zhipu", base_url: "https://open.bigmodel.cn/api/paas/v4" }, "glm-4.5", "off");
  assert.equal(Object.prototype.hasOwnProperty.call(glmAuto.body, "thinking"), false);
  assert.deepEqual(glmOn.body.thinking, { type: "enabled" });
  assert.deepEqual(glmOff.body.thinking, { type: "disabled" });

  const doubao = request({ protocol: "openai", preset_key: "doubao", base_url: "https://ark.cn-beijing.volces.com/api/v3" }, "ep-opaque-id", "off");
  assert.deepEqual(doubao.body.thinking, { type: "disabled" });

  const qwenOn = request({ protocol: "openai", preset_key: "qwen", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1" }, "qwen3-32b", "on");
  const qwenOff = request({ protocol: "openai", preset_key: "qwen", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1" }, "qwen3-32b", "off");
  assert.equal(qwenOn.body.enable_thinking, true);
  assert.equal(qwenOff.body.enable_thinking, false);

  const openRouter = request({ protocol: "openai", preset_key: "openrouter", base_url: "https://openrouter.ai/api/v1" }, "vendor/model", "off");
  assert.deepEqual(openRouter.body.reasoning, { enabled: false });

  const customKimiAuto = request({ protocol: "openai", preset_key: "custom", base_url: "https://api.example.com/v1" }, "kimi-k2.7-code", "auto");
  const customKimiOn = request({ protocol: "openai", preset_key: "custom", base_url: "https://api.example.com/v1" }, "kimi-k2.7-code", "on");
  const customKimiOff = request({ protocol: "openai", preset_key: "custom", base_url: "https://api.example.com/v1" }, "kimi-k2.7-code", "off");
  assert.equal(customKimiOn.reasoningMode.control, "toggle");
  assert.equal(customKimiOn.reasoningMode.adapter, "openai-effort");
  assert.equal(Object.prototype.hasOwnProperty.call(customKimiAuto.body, "reasoning_effort"), false);
  assert.equal(customKimiOn.body.reasoning_effort, "medium");
  assert.equal(customKimiOff.body.reasoning_effort, "none");

  const claudeOn = request({ protocol: "anthropic", preset_key: "anthropic", base_url: "https://api.anthropic.com" }, "claude-sonnet-4-20250514", "on");
  const claudeOff = request({ protocol: "anthropic", preset_key: "anthropic", base_url: "https://api.anthropic.com" }, "claude-sonnet-4-20250514", "off");
  assert.equal(claudeOn.body.thinking.type, "enabled");
  assert.equal(Object.prototype.hasOwnProperty.call(claudeOff.body, "thinking"), false);

  const geminiOn = request({ protocol: "gemini", preset_key: "gemini", base_url: "https://generativelanguage.googleapis.com/v1beta" }, "gemini-2.5-flash", "on");
  const geminiOff = request({ protocol: "gemini", preset_key: "gemini", base_url: "https://generativelanguage.googleapis.com/v1beta" }, "gemini-2.5-flash", "off");
  assert.equal(geminiOn.body.generationConfig.thinkingConfig.includeThoughts, true);
  assert.equal(geminiOff.body.generationConfig.thinkingConfig.thinkingBudget, 0);
});

test("custom OpenAI-compatible models use a broad and truthful reasoning capability matrix", () => {
  const provider = { protocol: "openai", preset_key: "custom", base_url: "https://api.example.com/v1" };
  const cases = [
    ["Qwen/Qwen3.5-72B", "toggle", "enable-thinking"],
    ["Qwen/Qwen3-235B-A22B-Thinking-2507", "always", "fixed"],
    ["Qwen/Qwen3-30B-A3B-Instruct-2507", "none", "none"],
    ["zai-org/GLM-4.7", "toggle", "thinking-object"],
    ["deepseek-ai/DeepSeek-V3.2", "toggle", "thinking-object"],
    ["moonshotai/Kimi-K2.7-Code", "toggle", "openai-effort"],
    ["moonshotai/Kimi-K2-Thinking", "always", "fixed"],
    ["ByteDance-Seed/Doubao-Seed-1.8", "toggle", "thinking-object"],
    ["openai/gpt-5.2", "toggle", "openai-effort"],
    ["openai/gpt-5.4-codex", "toggle", "openai-effort"],
    ["openai/gpt-oss-120b", "always", "fixed"],
    ["openai/o4-mini", "always", "fixed"],
    ["anthropic/claude-3-7-sonnet", "toggle", "openai-effort"],
    ["anthropic/claude-sonnet-4.5", "toggle", "openai-effort"],
    ["google/gemini-2.5-flash", "toggle", "openai-effort"],
    ["x-ai/grok-4-fast-non-reasoning", "none", "none"],
    ["mistralai/magistral-small", "always", "fixed"],
    ["unknown/plain-chat-model", "prompt", "prompt"],
  ];
  for (const [modelId, control, adapter] of cases) {
    const detected = reasoningCapability(provider, { model_id: modelId });
    assert.equal(detected.control, control, `${modelId} control`);
    assert.equal(detected.adapter, adapter, `${modelId} adapter`);
  }
});

test("custom model metadata and endpoint domains override ambiguous model IDs safely", () => {
  const custom = { protocol: "openai", preset_key: "custom", base_url: "https://api.example.com/v1" };
  assert.deepEqual(
    reasoningCapability(custom, { model_id: "opaque-a", metadata: { supportedParameters: ["reasoning_effort"] } }),
    { control: "toggle", adapter: "openai-effort", defaultEnabled: true, toggleable: true }
  );
  assert.equal(
    reasoningCapability(custom, { model_id: "opaque-b", metadata: { supported_parameters: ["enable_thinking"] } }).adapter,
    "enable-thinking"
  );
  assert.equal(
    reasoningCapability(custom, { model_id: "opaque-c", metadata: { supportedParameters: ["chat_template_kwargs"] } }).adapter,
    "chat-template-thinking"
  );
  assert.equal(
    reasoningCapability(custom, { model_id: "opaque-d", metadata: { supportsReasoning: false } }).control,
    "none"
  );
  assert.equal(
    reasoningCapability(
      { protocol: "openai", preset_key: "custom", base_url: "https://api.moonshot.cn/v1" },
      { model_id: "kimi-k2.7-code" }
    ).adapter,
    "thinking-object"
  );
  assert.equal(
    reasoningCapability(
      { protocol: "openai", preset_key: "custom", base_url: "https://openrouter.ai/api/v1" },
      { model_id: "opaque-deployment" }
    ).adapter,
    "openrouter-reasoning"
  );

  const localQwen = completionRequest(
    custom,
    { model_id: "opaque-qwen", metadata: { supportedParameters: ["chat_template_kwargs"] } },
    "secret",
    [{ role: "user", content: "直接回答" }],
    "system",
    256,
    { reasoningMode: "off" }
  );
  assert.deepEqual(localQwen.body.chat_template_kwargs, { enable_thinking: false });
});

test("provider model capability metadata is normalized before it reaches PostgreSQL", () => {
  const metadata = providerModelMetadata({
    supported_parameters: ["reasoning", "include_reasoning", "reasoning"],
    capabilities: {
      reasoning: { supported: true, control: "switchable", parameter: "reasoning" },
      vision: true,
      legacy: false,
    },
  });
  assert.deepEqual(metadata.supportedParameters, ["reasoning", "include_reasoning"]);
  assert.deepEqual(metadata.capabilities, ["reasoning", "vision"]);
  assert.equal(metadata.supportsReasoning, true);
  assert.equal(metadata.reasoningControl, "toggle");
  assert.equal(metadata.reasoningAdapter, "openrouter-reasoning");
  assert.equal(
    reasoningCapability(
      { protocol: "openai", preset_key: "custom", base_url: "https://api.example.com/v1" },
      { model_id: "opaque-from-provider", metadata }
    ).adapter,
    "openrouter-reasoning"
  );
  const unsupported = providerModelMetadata({ capabilities: { reasoning: false, vision: true } });
  assert.equal(unsupported.supportsReasoning, false);
  assert.equal(
    reasoningCapability(
      { protocol: "openai", preset_key: "custom", base_url: "https://api.example.com/v1" },
      { model_id: "kimi-k2.7-code", metadata: unsupported }
    ).control,
    "none"
  );
});

test("provider token metadata recognizes 1M contexts and independent output limits", () => {
  assert.deepEqual(
    providerModelTokenCapabilities({ inputTokenLimit: 1000000, outputTokenLimit: 65536 }),
    { contextWindow: 1000000, maxOutputTokens: 65536 }
  );
  assert.deepEqual(
    providerModelTokenCapabilities({ limits: { context_window: 1048576, max_output_tokens: 32768 } }),
    { contextWindow: 1048576, maxOutputTokens: 32768 }
  );
  assert.deepEqual(
    providerModelTokenCapabilities({
      context_length: 1000000,
      top_provider: { max_completion_tokens: 65536 },
    }),
    { contextWindow: 1000000, maxOutputTokens: 65536 }
  );
  assert.deepEqual(providerModelTokenCapabilities({ id: "opaque-model" }), {
    contextWindow: 0,
    maxOutputTokens: 0,
  });
});

test("custom provider saving remains limited to circle owners and global super admins", async () => {
  await withPublicDns(async () => {
    const circleId = "22222222-2222-4222-8222-222222222222";
    const userId = "33333333-3333-4333-8333-333333333333";
    const providerDraft = {
      presetKey: "custom",
      protocol: "openai",
      name: "Owner Compatible API",
      baseUrl: "https://api.example.com/v1",
      privacyUrl: "https://example.com/privacy",
      apiKey: "custom-provider-secret",
    };

    function serviceFor(access) {
      const queries = [];
      let transactionStarted = false;
      const savedProvider = providerRow({
        circle_id: circleId,
        preset_key: "custom",
        name: providerDraft.name,
        base_url: providerDraft.baseUrl,
        credential_ciphertext: "encrypted-custom-secret",
        credential_last_four: "cret",
        privacy_url: providerDraft.privacyUrl,
        is_custom: true,
      });
      const db = {
        async query(text, params) {
          const sql = String(text);
          queries.push({ sql, params });
          if (sql.includes("INSERT INTO incircle_ai_providers")) return { rows: [savedProvider] };
          return { rows: [] };
        },
        async withTransaction(callback) {
          transactionStarted = true;
          return callback();
        },
      };
      const service = new AiService({
        db,
        config: { aiCredentialsEncryptionKey: crypto.randomBytes(32).toString("hex") },
      }, {});
      service.requireManager = async () => ({
        circleId,
        auth: { user: { id: userId } },
        canManage: true,
        ...access,
      });
      service.core.logOperation = async () => {};
      return { service, queries, transactionStarted: () => transactionStarted };
    }

    for (const item of [
      {
        label: "circle owner",
        access: {
          isOwner: true,
          isSuperAdmin: false,
          canUseCustomProvider: true,
        },
      },
      {
        label: "platform super admin",
        access: {
          isOwner: false,
          isSuperAdmin: true,
          canUseCustomProvider: true,
        },
      },
    ]) {
      const fixture = serviceFor(item.access);
      const result = await fixture.service.saveProvider({ circleId, provider: providerDraft });
      assert.equal(result.provider.presetKey, "custom", `${item.label} saved preset`);
      assert.equal(result.provider.isCustom, true, `${item.label} saved custom marker`);
      assert.equal(fixture.transactionStarted(), true, `${item.label} transaction started`);
      assert.equal(
        fixture.queries.some((query) => query.sql.includes("INSERT INTO incircle_ai_providers")),
        true,
        `${item.label} provider inserted`
      );
    }

    const unauthorizedManager = serviceFor({
      isOwner: false,
      isSuperAdmin: false,
      canUseCustomProvider: false,
    });
    await assert.rejects(
      () => unauthorizedManager.service.saveProvider({ circleId, provider: providerDraft }),
      (error) => error.statusCode === 403 && error.errCode === "AI_PROVIDER_PRESET_FORBIDDEN"
    );
    assert.equal(unauthorizedManager.transactionStarted(), false);
    assert.equal(unauthorizedManager.queries.length, 0);
  });
});

test("only explicit pre-stream output parameter rejections qualify for compatibility fallback", () => {
  assert.equal(providerOutputLimitRejected(422, {
    param: "max_output_tokens",
    message: "max_output_tokens must be less than 8193",
  }), true);
  assert.equal(providerOutputLimitRejected(400, {
    message: "maximum context length exceeded because max_tokens is too high",
  }), true);
  assert.equal(providerOutputLimitRejected(500, {
    param: "max_tokens",
    message: "temporary error",
  }), false);
  assert.equal(providerOutputLimitRejected(400, {
    message: "reasoning_effort is unsupported",
  }), false);
  assert.equal(providerOutputTokenLimit({
    param: "max_tokens",
    message: "Requested 32768 tokens, but the maximum is 8192 tokens",
  }, 32768), 8192);
});

test("database model catalog keeps provider namespaces and supports exact custom IDs", async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      const requestedIds = Array.isArray(params[0]) ? params[0] : params[1];
      if (requestedIds.includes("gpt-4.1-mini")) {
        return {
          rows: [{
            provider_key: "openai",
            model_id: "gpt-4.1-mini",
            model_id_normalized: "gpt-4.1-mini",
            aliases_normalized: [],
            context_window: 1047576,
            max_output_tokens: 32768,
            supports_reasoning: false,
            catalog_version: "2026-07-18.2",
            confidence: "community",
            provider_doc_url: "https://platform.openai.com/docs/models",
          }],
        };
      }
      return { rows: [] };
    },
  };
  const official = await catalogModelCapabilities(db, { preset_key: "openai" }, "gpt-4.1-mini");
  assert.equal(official.contextWindow, 1047576);
  assert.equal(official.maxOutputTokens, 32768);
  assert.equal(official.catalogVersion, "2026-07-18.2");

  const customExact = await catalogModelCapabilities(db, { preset_key: "custom" }, "gpt-4.1-mini");
  assert.equal(customExact.matched, true);
  assert.equal(customExact.contextWindow, 1047576);
  assert.doesNotMatch(calls.at(-1).sql, /aliases_normalized/);

  const customAlias = await catalogModelCapabilities(db, { preset_key: "custom" }, "gpt-4.1-mini-alias");
  assert.equal(customAlias.matched, false);
  assert.equal(customAlias.contextWindow, 0);

  const unknownVersion = await catalogModelCapabilities(db, { preset_key: "openai" }, "gpt-5.6");
  assert.equal(unknownVersion.matched, false);
});

test("lightweight output probing records only accepted or explicitly reported limits", async () => {
  const service = new AiService({ db: {}, config: {} }, {});
  const calls = [];
  service.runProviderCompletion = async (options) => {
    calls.push(options.maxTokens);
    if (options.maxTokens === 131072) {
      throw new AppError("unsupported output limit", {
        statusCode: 502,
        errCode: "AI_PROVIDER_OUTPUT_LIMIT_UNSUPPORTED",
        details: { providerTokenLimit: 12288 },
      });
    }
    await options.onDelta("OK");
  };
  const detected = await service.probeModelOutputCapability({
    provider: { protocol: "openai", preset_key: "custom" },
    model: { model_id: "opaque-model" },
    apiKey: "secret",
    reasoning: { control: "toggle" },
  });
  assert.deepEqual(calls, [131072]);
  assert.equal(detected.value, 12288);
  assert.equal(detected.source, "probe");
  assert.equal(detected.status, "provider_reported_limit");

  calls.length = 0;
  service.runProviderCompletion = async (options) => {
    calls.push(options.maxTokens);
    if (options.maxTokens > 32768) {
      throw new AppError("unsupported output limit", {
        statusCode: 502,
        errCode: "AI_PROVIDER_OUTPUT_LIMIT_UNSUPPORTED",
      });
    }
    await options.onDelta("OK");
  };
  const stepped = await service.probeModelOutputCapability({
    provider: { protocol: "openai", preset_key: "custom" },
    model: { model_id: "opaque-model" },
    apiKey: "secret",
    reasoning: { control: "toggle" },
  });
  assert.deepEqual(calls, [131072, 65536, 32768]);
  assert.equal(stepped.value, 32768);
  assert.equal(stepped.status, "fallback_accepted");

  service.runProviderCompletion = async () => {
    throw new AppError("temporary timeout", { statusCode: 504, errCode: "AI_PROVIDER_TIMEOUT" });
  };
  const unavailable = await service.probeModelOutputCapability({
    provider: { protocol: "openai", preset_key: "custom" },
    model: { model_id: "opaque-model" },
    apiKey: "secret",
    reasoning: { control: "toggle" },
  });
  assert.equal(unavailable.value, 0);
  assert.equal(unavailable.status, "unavailable");

  calls.length = 0;
  const skipped = await service.probeModelOutputCapability({
    provider: {}, model: {}, apiKey: "", reasoning: { control: "always" },
  });
  assert.equal(skipped.status, "reasoning_required");
  assert.deepEqual(calls, []);
});

test("fixed and non-reasoning models reject incompatible explicit modes", () => {
  const reasoner = { protocol: "openai", preset_key: "deepseek", model_id: "deepseek-reasoner" };
  const chat = { protocol: "openai", preset_key: "deepseek", model_id: "deepseek-chat" };
  assert.equal(reasoningCapability(reasoner, reasoner).control, "always");
  assert.equal(resolveReasoningMode(reasoner, reasoner, "auto").enabled, true);
  assert.equal(resolveReasoningMode(reasoner, reasoner, "off").supported, false);
  assert.equal(reasoningCapability(chat, chat).control, "none");
  assert.equal(resolveReasoningMode(chat, chat, "auto").enabled, false);
  assert.equal(resolveReasoningMode(chat, chat, "on").supported, false);
});

test("provider stream payloads separate answer and explicit reasoning deltas", () => {
  const openAi = jsonDelta("openai", { choices: [{ delta: { content: "A", reasoning_content: "先分析" } }] });
  assert.equal(openAi.text, "A");
  assert.equal(openAi.reasoning, "先分析");
  assert.equal(
    jsonDelta("openai", { choices: [{ delta: { content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] } }] }).text,
    "AB"
  );
  assert.equal(
    jsonDelta("openai", { choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "聚合推理" }] } }] }).reasoning,
    "聚合推理"
  );
  assert.equal(
    jsonDelta("openai", { choices: [{ delta: { reasoning_details: [{ type: "reasoning.encrypted", data: "secret" }] } }] }).reasoning,
    ""
  );
  const multipart = jsonDelta("openai", {
    choices: [{ delta: { content: [{ type: "reasoning_text", text: "分段推理" }, { type: "output_text", text: "分段正文" }] } }],
  });
  assert.equal(multipart.reasoning, "分段推理");
  assert.equal(multipart.text, "分段正文");
  const analysisChannel = jsonDelta("openai", { choices: [{ delta: { channel: "analysis", content: "通道推理" } }] });
  assert.equal(analysisChannel.reasoning, "通道推理");
  assert.equal(analysisChannel.text, "");
  assert.equal(jsonDelta("anthropic", { type: "content_block_delta", delta: { text: "B" } }).text, "B");
  assert.equal(
    jsonDelta("anthropic", { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Claude 推理" } }).reasoning,
    "Claude 推理"
  );
  assert.equal(
    jsonDelta("gemini", { candidates: [{ content: { parts: [{ text: "Gemini 推理", thought: true }, { text: "C" }] } }] }).text,
    "C"
  );
  assert.equal(
    jsonDelta("gemini", { candidates: [{ content: { parts: [{ text: "Gemini 推理", thought: true }, { text: "C" }] } }] }).reasoning,
    "Gemini 推理"
  );
  assert.equal(jsonDelta("openai", { type: "response.reasoning_summary_text.delta", delta: "摘要推理" }).reasoning, "摘要推理");
  assert.equal(jsonDelta("openai", { type: "response.output_text.delta", delta: "正文" }).text, "正文");
});

test("GLM, Doubao and DeepSeek compatible streams preserve reasoning and answer text", () => {
  const providerSamples = [
    ["GLM", { choices: [{ delta: { reasoning_content: "GLM 推理", content: "GLM 正文" } }] }, "GLM 推理", "GLM 正文"],
    ["Doubao", { choices: [{ delta: { reasoning_content: "豆包推理", content: "豆包正文" } }] }, "豆包推理", "豆包正文"],
    ["DeepSeek", { choices: [{ delta: { reasoning_content: "DeepSeek 推理", content: "DeepSeek 正文" } }] }, "DeepSeek 推理", "DeepSeek 正文"],
  ];
  providerSamples.forEach(([name, payload, expectedReasoning, expectedText]) => {
    const delta = jsonDelta("openai", payload);
    assert.equal(delta.reasoning, expectedReasoning, `${name} reasoning`);
    assert.equal(delta.text, expectedText, `${name} answer`);
  });
  const presets = listProviderPresets(false);
  const doubao = presets.find((preset) => preset.key === "doubao");
  assert.equal(doubao.protocol, "openai");
  assert.equal(doubao.baseUrl, "https://ark.cn-beijing.volces.com/api/v3");
});

test("provider finish reasons preserve output-limit diagnostics", () => {
  assert.equal(providerFinishReason("openai", { choices: [{ finish_reason: "length" }] }), "length");
  assert.equal(providerFinishReason("anthropic", { delta: { stop_reason: "max_tokens" } }), "max_tokens");
  assert.equal(providerFinishReason("gemini", { candidates: [{ finishReason: "MAX_TOKENS" }] }), "MAX_TOKENS");
  assert.equal(
    providerFinishReason("openai", { type: "response.incomplete", incomplete_details: { reason: "max_output_tokens" } }),
    "max_output_tokens"
  );
});

test("provider stream timeouts stay distinct from user cancellation", () => {
  const timeout = Object.assign(new Error("供应商响应超时"), { code: "AI_PROVIDER_TIMEOUT" });
  const mappedTimeout = normalizeProviderStreamError(timeout, new AbortController().signal);
  assert.equal(mappedTimeout.errCode, "AI_PROVIDER_TIMEOUT");

  const controller = new AbortController();
  controller.abort();
  const cancelled = Object.assign(new Error("请求已取消"), { name: "AbortError" });
  assert.equal(normalizeProviderStreamError(cancelled, controller.signal), cancelled);
});

test("provider connect timeout stops after TLS even when reasoning delays response headers", async () => {
  const originalRequest = https.request;
  const fakeRequest = new EventEmitter();
  let responseCallback = null;
  let destroyedError = null;
  fakeRequest.setTimeout = () => {};
  fakeRequest.write = () => {};
  fakeRequest.end = () => {};
  fakeRequest.destroy = (error) => {
    destroyedError = error;
    fakeRequest.emit("error", error);
  };
  https.request = (url, options, callback) => {
    responseCallback = callback;
    return fakeRequest;
  };
  try {
    const responsePromise = requestOnce(
      new URL("https://api.example.com/v1/chat/completions"),
      { method: "POST", body: "{}", timeoutMs: 40 },
      [{ address: "8.8.8.8", family: 4 }]
    );
    const socket = new EventEmitter();
    socket.connecting = true;
    fakeRequest.emit("socket", socket);
    socket.emit("secureConnect");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(destroyedError, null);

    const incoming = new EventEmitter();
    incoming.destroyed = false;
    incoming.setTimeout = () => {};
    responseCallback(incoming);
    assert.equal(await responsePromise, incoming);
    incoming.emit("end");
  } finally {
    https.request = originalRequest;
  }
});

test("provider event streams preserve UTF-8 text split across network chunks", async () => {
  const payload = Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: "你好" } }] })}\n\n`, "utf8");
  const splitAt = payload.indexOf(Buffer.from("你", "utf8")) + 1;
  const chunks = [payload.subarray(0, splitAt), payload.subarray(splitAt)];
  const response = {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
  let output = "";
  await consumeEventStream(response, "openai", async (delta) => {
    output += delta;
  });
  assert.equal(output, "你好");
});

test("provider event streams assemble standard multi-line SSE data fields", async () => {
  const response = Readable.from([Buffer.from([
    "event: message",
    "data: {",
    'data:   "choices": [{"delta":{"content":"多行事件"}}]',
    "data: }",
    "",
    "data: [DONE]",
    "",
  ].join("\n"), "utf8")]);
  const stats = {};
  let output = "";
  await consumeEventStream(response, "openai", async (delta) => { output += delta; }, stats);
  assert.equal(output, "多行事件");
  assert.equal(stats.parseErrors || 0, 0);
  assert.equal(stats.doneSeen, true);
});

test("provider event streams reject an oversized unterminated event", async () => {
  let destroyed = false;
  const response = {
    destroy() { destroyed = true; },
    async *[Symbol.asyncIterator]() {
      yield Buffer.alloc(512 * 1024 + 1, 0x61);
    },
  };
  await assert.rejects(
    () => consumeEventStream(response, "openai", async () => {}),
    (error) => error.errCode === "AI_PROVIDER_RESPONSE_TOO_LARGE"
  );
  assert.equal(destroyed, true);
});

test("provider event streams accept compatible NDJSON and expose safe diagnostics", async () => {
  const response = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(`${JSON.stringify({ choices: [{ delta: { content: "兼容" } }] })}\n`, "utf8");
      yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: "流" } }] })}\n\ndata: [DONE]\n\n`, "utf8");
    },
  };
  const stats = {};
  let output = "";
  await consumeEventStream(response, "openai", async (delta) => {
    output += delta;
  }, stats);
  assert.equal(output, "兼容流");
  assert.equal(stats.events, 2);
  assert.equal(stats.textDeltas, 2);
  assert.equal(stats.doneSeen, true);
  assert.equal(stats.responseBytes > 0, true);
  assert.equal(stats.parseErrors || 0, 0);
});

test("provider event streams deliver reasoning before answer text", async () => {
  const response = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "先想清楚" } }] })}\n\n`, "utf8");
      yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: "再回答" }, finish_reason: "stop" }] })}\n\n`, "utf8");
    },
  };
  const order = [];
  const stats = {};
  await consumeEventStream(
    response,
    "openai",
    async (delta) => order.push(`answer:${delta}`),
    stats,
    async (delta) => order.push(`reasoning:${delta}`)
  );
  assert.deepEqual(order, ["reasoning:先想清楚", "answer:再回答"]);
  assert.equal(stats.reasoningDeltas, 1);
  assert.equal(stats.textDeltas, 1);
});

test("provider parser recovers a pretty-printed JSON response", async () => {
  const response = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{\n  "choices": [\n    { "message": { "content": "完整回答" } }\n  ]\n}', "utf8");
    },
  };
  let output = "";
  await consumeEventStream(response, "openai", async (delta) => { output += delta; });
  assert.equal(output, "完整回答");
});

test("mislabeled text/plain provider responses still stream before socket close", async () => {
  const originalRequest = https.request;
  let releaseSecondChunk;
  const secondChunkGate = new Promise((resolve) => { releaseSecondChunk = resolve; });
  https.request = (url, options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.write = () => {};
    request.destroy = (error) => request.emit("error", error);
    request.end = () => {
      const incoming = Readable.from((async function* stream() {
        yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: "第一段" } }] })}\n\n`, "utf8");
        await secondChunkGate;
        yield Buffer.from("data: [DONE]\n\n", "utf8");
      })());
      incoming.statusCode = 200;
      incoming.headers = { "content-type": "text/plain; charset=utf-8" };
      incoming.setTimeout = () => {};
      callback(incoming);
    };
    return request;
  };
  let firstDeltaResolve;
  const firstDelta = new Promise((resolve) => { firstDeltaResolve = resolve; });
  let output = "";
  try {
    const completion = withPublicDns(() => streamProviderCompletion({
      provider: { protocol: "openai", base_url: "https://api.example.com/v1" },
      model: { model_id: "demo" },
      apiKey: "secret",
      messages: [{ role: "user", content: "hello" }],
      systemPrompt: "system",
      maxTokens: 64,
      timeoutMs: 300000,
      onDelta: (delta) => {
        output += delta;
        firstDeltaResolve();
      },
    }));
    await Promise.race([
      firstDelta,
      new Promise((resolve, reject) => setTimeout(() => reject(new Error("first delta was buffered until close")), 150)),
    ]);
    assert.equal(output, "第一段");
    releaseSecondChunk();
    await completion;
  } finally {
    releaseSecondChunk();
    https.request = originalRequest;
  }
});

function preparedGeneration(config) {
  return {
    ctx: {
      circleId: "11111111-1111-4111-8111-111111111111",
      auth: { user: { id: "22222222-2222-4222-8222-222222222222", openid: "openid-test" } },
    },
    settings: { system_prompt: "system", max_output_tokens: 4096 },
    model: {
      id: "33333333-3333-4333-8333-333333333333",
      provider_id: "44444444-4444-4444-8444-444444444444",
      protocol: "openai",
      preset_key: "zhipu",
      model_id: "reasoning-model",
      display_name: "Reasoning Model",
      provider_name: "Mock Provider",
      credential_ciphertext: encryptCredential(config, "provider-secret"),
    },
    requestId: "request-reliability-test",
    conversation: { id: "55555555-5555-4555-8555-555555555555" },
    userMessage: { id: "66666666-6666-4666-8666-666666666666" },
    assistantMessage: { id: "77777777-7777-4777-8777-777777777777" },
  };
}

test("a terminal cancellation cannot be overwritten by a late generation result", async () => {
  const config = { aiCredentialsEncryptionKey: crypto.randomBytes(32).toString("hex") };
  const prepared = preparedGeneration(config);
  let terminalUpdate = "";
  let usageStatus = "";
  const db = {
    withTransaction: async (callback) => callback(),
    query: async (sql, params) => {
      if (/SELECT id FROM incircle_ai_conversations/.test(sql)) return { rows: [{ id: prepared.conversation.id }] };
      if (/UPDATE incircle_ai_messages SET content/.test(sql)) {
        terminalUpdate = sql;
        return { rows: [] };
      }
      if (/SELECT status, error_code FROM incircle_ai_messages/.test(sql)) {
        return { rows: [{ status: "cancelled", error_code: "AI_CANCELLED" }] };
      }
      if (/UPDATE incircle_ai_conversations SET last_message_at/.test(sql)) return { rows: [] };
      if (/INSERT INTO incircle_ai_usage_events/.test(sql)) {
        usageStatus = params[7];
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const service = new AiService({ db, config }, {});
  const saved = await service.saveGenerationResult(prepared, {
    status: "success",
    content: "晚到的完整回答",
    inputTokens: 10,
    outputTokens: 20,
  });
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.errorCode, "AI_CANCELLED");
  assert.equal(usageStatus, "cancelled");
  assert.match(terminalUpdate, /status = 'generating' AND generation_owner_id = \$11/);
});

test("AI consent acceptance is append-only per provider privacy version", async () => {
  const acceptanceQueries = [];
  const acceptanceVersions = [];
  let privacyVersion = 1;
  const providerId = "11111111-1111-4111-8111-111111111111";
  const db = {
    withTransaction: async (callback) => callback(),
    query: async (sql, params) => {
      if (/SELECT \* FROM incircle_ai_providers/.test(sql)) {
        return { rows: [providerRow({ id: providerId, privacy_version: privacyVersion })] };
      }
      if (/INSERT INTO incircle_ai_consent_acceptances/.test(sql)) {
        acceptanceQueries.push(sql);
        acceptanceVersions.push(params[3]);
        return { rows: [] };
      }
      if (/INSERT INTO incircle_ai_consents\s*\(/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const service = new AiService({ db, config: {} }, {});
  service.requireMember = async () => ({
    circleId: "22222222-2222-4222-8222-222222222222",
    auth: { user: { id: "33333333-3333-4333-8333-333333333333" } },
  });
  await service.grantConsent({ providerId });
  privacyVersion = 2;
  await service.grantConsent({ providerId });
  assert.deepEqual(acceptanceVersions, [1, 2]);
  assert.match(acceptanceQueries[0], /uq_incircle_ai_consent_acceptance_version DO NOTHING/);
  assert.doesNotMatch(acceptanceQueries[0], /DO UPDATE|accepted_at = now/);
});

test("idempotent AI retries skip duplicate input moderation and reject changed content", async () => {
  const service = new AiService({ db: {}, config: {} }, {});
  const replay = {
    content: "原来的问题",
    conversation_id: "55555555-5555-4555-8555-555555555555",
    assistant_status: "generating",
  };
  let moderationChecks = 0;
  service.requireEnabledAi = async () => ({
    ctx: { circleId: "11111111-1111-4111-8111-111111111111", auth: { user: { id: "user-1", openid: "openid-1" } } },
    settings: {},
  });
  service.modelForChat = async () => ({ protocol: "openai", model_id: "plain-model" });
  service.assertConsent = async () => {};
  service.existingRequest = async () => replay;
  service.checkContentSecurity = async () => { moderationChecks += 1; };

  const prepared = await service.prepareGeneration({
    content: "原来的问题",
    requestId: "request_same_123",
  });
  assert.equal(prepared.replay, replay);
  assert.equal(moderationChecks, 0);

  await assert.rejects(
    service.prepareGeneration({ content: "被替换的问题", requestId: "request_same_123" }),
    (error) => error.errCode === "AI_REQUEST_ALREADY_USED"
  );
  assert.equal(moderationChecks, 0);
});

test("chat generation keeps reading provider output while ordered moderation drains", async () => {
  const config = {
    aiCredentialsEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
    aiProviderTimeoutMs: 300000,
  };
  let moderationFinished = false;
  let providerContinuedBeforeModeration = false;
  let checkpointCount = 0;
  let saved = null;
  const service = new AiService(
    { db: {}, config },
    {
      generationHeartbeatMs: 10,
      checkTextSecurity: async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        moderationFinished = true;
      },
      streamProviderCompletion: async (options) => {
        const reasoningPromise = options.onReasoning("分析".repeat(72));
        providerContinuedBeforeModeration = !moderationFinished;
        await reasoningPromise;
        await options.onDelta("这是最终回答。");
        await new Promise((resolve) => setTimeout(resolve, 35));
        return { inputTokens: 12, outputTokens: 34 };
      },
    }
  );
  service.prepareGeneration = async () => preparedGeneration(config);
  service.generationContext = async () => [{ role: "user", content: "问题" }];
  service.checkpointGeneration = async () => { checkpointCount += 1; };
  service.saveGenerationResult = async (prepared, options) => { saved = options; };
  const events = [];

  await service.chatStream({}, async (event) => events.push(event), new AbortController().signal);

  assert.equal(providerContinuedBeforeModeration, true);
  assert.equal(moderationFinished, true);
  assert.equal(checkpointCount > 0, true);
  assert.equal(saved.status, "success");
  assert.equal(saved.content, "这是最终回答。");
  assert.equal(saved.reasoningContent, "分析".repeat(72));
  const reasoningEvents = events.filter((event) => event.type === "reasoning");
  const firstAnswerEvent = events.find((event) => event.type === "delta");
  assert.equal(reasoningEvents.length > 1, true);
  assert.equal(reasoningEvents.at(-1).reasoningDurationMs > reasoningEvents[0].reasoningDurationMs, true);
  assert.equal(firstAnswerEvent.reasoningDurationMs >= reasoningEvents.at(-1).reasoningDurationMs, true);
  assert.equal(events.some((event) => event.type === "delta"), true);
  assert.equal(events.at(-1).type, "done");
});

test("short reasoning is moderated and emitted before the provider finishes", async () => {
  const config = {
    aiCredentialsEncryptionKey: Buffer.alloc(32, 12).toString("base64"),
    aiProviderTimeoutMs: 300000,
  };
  let releaseProvider;
  let providerFinished = false;
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  const service = new AiService(
    { db: {}, config },
    {
      checkTextSecurity: async () => ({ safe: true }),
      streamProviderCompletion: async (options) => {
        options.onReasoning("这是一小段实时思考");
        await providerGate;
        options.onDelta("这是最终回答");
        providerFinished = true;
        return { inputTokens: 8, outputTokens: 16 };
      },
    }
  );
  service.prepareGeneration = async () => preparedGeneration(config);
  service.generationContext = async () => [{ role: "user", content: "问题" }];
  service.checkpointGeneration = async () => {};
  service.saveGenerationResult = async () => {};
  let resolveReasoning;
  const reasoningSeen = new Promise((resolve) => { resolveReasoning = resolve; });
  const events = [];
  const completion = service.chatStream({}, async (event) => {
    events.push(event);
    if (event.type === "reasoning") resolveReasoning(event);
  }, new AbortController().signal);

  const firstReasoning = await Promise.race([
    reasoningSeen,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error("short reasoning was buffered until completion")), 1000)),
  ]);
  assert.equal(firstReasoning.content, "这是一小段实时思考");
  assert.equal(providerFinished, false);
  releaseProvider();
  await completion;
  assert.equal(events.some((event) => event.type === "delta" && event.content === "这是最终回答"), true);
  assert.equal(events.at(-1).type, "done");
});

test("moderated answers preserve provider delta boundaries instead of rebuilding large text blocks", async () => {
  const config = {
    aiCredentialsEncryptionKey: Buffer.alloc(32, 17).toString("base64"),
    aiProviderTimeoutMs: 300000,
  };
  const providerFrames = ["这", "是", "逐", "段", "到", "达", "的", "真", "实", "流", "式", "回", "答", "。"];
  const service = new AiService(
    { db: {}, config },
    {
      checkTextSecurity: async () => ({ safe: true }),
      streamProviderCompletion: async (options) => {
        for (const frame of providerFrames) await options.onDelta(frame);
        return { inputTokens: 4, outputTokens: 14 };
      },
    }
  );
  service.prepareGeneration = async () => preparedGeneration(config);
  service.generationContext = async () => [{ role: "user", content: "测试流式" }];
  service.checkpointGeneration = async () => {};
  service.saveGenerationResult = async () => {};
  const events = [];

  await service.chatStream({}, async (event) => events.push(event), new AbortController().signal);

  assert.deepEqual(events.filter((event) => event.type === "delta").map((event) => event.content), providerFrames);
  assert.equal(events.at(-1).type, "done");
});

test("guarded output uses fine moderation batches and ten-character display frames", async () => {
  const config = {
    aiCredentialsEncryptionKey: Buffer.alloc(32, 19).toString("base64"),
    aiProviderTimeoutMs: 300000,
  };
  const answer = "甲".repeat(1500);
  const moderatedLengths = [];
  const service = new AiService(
    { db: {}, config },
    {
      checkTextSecurity: async (_config, options) => {
        moderatedLengths.push(String(options.content || "").length);
        return { safe: true };
      },
      streamProviderCompletion: async (options) => {
        await options.onDelta(answer);
        return { inputTokens: 4, outputTokens: 375 };
      },
    }
  );
  service.prepareGeneration = async () => preparedGeneration(config);
  service.generationContext = async () => [{ role: "user", content: "测试细粒度审核" }];
  service.checkpointGeneration = async () => {};
  service.saveGenerationResult = async () => {};
  const events = [];

  await service.chatStream({}, async (event) => events.push(event), new AbortController().signal);

  const deltas = events.filter((event) => event.type === "delta");
  assert.deepEqual(moderatedLengths.slice(0, 5), [16, 80, 144, 208, 224]);
  assert.equal(moderatedLengths.includes(288), true, "later checks must contain 160 context + 128 new characters");
  assert.equal(deltas.every((event) => event.content.length <= 10), true);
  assert.equal(deltas.map((event) => event.content).join(""), answer);
  assert.equal(events.at(-1).type, "done");
});

test("guarded answer deltas reach the client before the provider stream finishes", async () => {
  const config = {
    aiCredentialsEncryptionKey: Buffer.alloc(32, 18).toString("base64"),
    aiProviderTimeoutMs: 300000,
  };
  let releaseProvider;
  let providerFinished = false;
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  const service = new AiService(
    { db: {}, config },
    {
      checkTextSecurity: async () => ({ safe: true }),
      streamProviderCompletion: async (options) => {
        for (const frame of "这是一段会在供应商连接结束以前就抵达客户端的真实流式回答。") {
          await options.onDelta(frame);
        }
        await providerGate;
        providerFinished = true;
        return { inputTokens: 4, outputTokens: 28 };
      },
    }
  );
  service.prepareGeneration = async () => preparedGeneration(config);
  service.generationContext = async () => [{ role: "user", content: "测试实时到达" }];
  service.checkpointGeneration = async () => {};
  service.saveGenerationResult = async () => {};
  let resolveFirstDelta;
  const firstDelta = new Promise((resolve) => { resolveFirstDelta = resolve; });
  const completion = service.chatStream({}, async (event) => {
    if (event.type === "delta") resolveFirstDelta(event);
  }, new AbortController().signal);

  const event = await Promise.race([
    firstDelta,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error("answer delta was buffered until provider close")), 1000)),
  ]);
  assert.equal(event.content.length > 0, true);
  assert.equal(providerFinished, false);
  releaseProvider();
  await completion;
  assert.equal(providerFinished, true);
});

test("disabled reasoning requests direct answers and never emits or stores reasoning content", async () => {
  const config = {
    aiCredentialsEncryptionKey: Buffer.alloc(32, 6).toString("base64"),
    aiProviderTimeoutMs: 300000,
  };
  const answer = "流式正文".repeat(180);
  let systemPrompt = "";
  let providerReasoningMode = "";
  let saved = null;
  const service = new AiService(
    { db: {}, config },
    {
      checkTextSecurity: async () => {},
      streamProviderCompletion: async (options) => {
        systemPrompt = options.systemPrompt;
        providerReasoningMode = options.reasoningMode;
        options.onReasoning("不会展示的思考".repeat(80));
        options.onDelta(answer);
        return { inputTokens: 10, outputTokens: 30 };
      },
    }
  );
  service.prepareGeneration = async () => preparedGeneration(config);
  service.generationContext = async () => [{ role: "user", content: "直接回答" }];
  service.checkpointGeneration = async () => {};
  service.saveGenerationResult = async (prepared, options) => { saved = options; };
  const events = [];

  await service.chatStream({ reasoningMode: "off" }, async (event) => events.push(event), new AbortController().signal);

  const answerEvents = events.filter((event) => event.type === "delta");
  assert.equal(events.some((event) => event.type === "reasoning"), false);
  assert.equal(answerEvents.map((event) => event.content).join(""), answer);
  assert.equal(answerEvents.length > 2, true);
  assert.equal(answerEvents.every((event) => event.content.length <= 10), true);
  assert.match(systemPrompt, /直接给出最终答案/);
  assert.equal(providerReasoningMode, "off");
  assert.equal(saved.reasoningContent, "");
  assert.equal(saved.content, answer);
});

test("auto reasoning ignores whitespace-only reasoning events", async () => {
  const config = {
    aiCredentialsEncryptionKey: Buffer.alloc(32, 5).toString("base64"),
    aiProviderTimeoutMs: 300000,
  };
  let saved = null;
  const service = new AiService(
    { db: {}, config },
    {
      checkTextSecurity: async () => {},
      streamProviderCompletion: async (options) => {
        options.onReasoning(" \n\t\u200b\ufeff ");
        options.onDelta("直接返回正文");
        return { inputTokens: 6, outputTokens: 8 };
      },
    }
  );
  service.prepareGeneration = async () => preparedGeneration(config);
  service.generationContext = async () => [{ role: "user", content: "直接回答" }];
  service.checkpointGeneration = async () => {};
  service.saveGenerationResult = async (prepared, options) => { saved = options; };
  const events = [];

  await service.chatStream({ reasoningMode: "auto" }, async (event) => events.push(event), new AbortController().signal);

  assert.equal(events.some((event) => event.type === "reasoning"), false);
  assert.equal(events.filter((event) => event.type === "delta").map((event) => event.content).join(""), "直接返回正文");
  assert.equal(saved.reasoningContent, "");
  assert.equal(saved.content, "直接返回正文");
});

test("temporary content-security outages are retried without bypassing moderation", async () => {
  let attempts = 0;
  const service = new AiService(
    { db: {}, config: {} },
    {
      contentSecurityRetryDelays: [0, 0],
      checkTextSecurity: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new AppError("内容安全服务暂时不可用", {
            statusCode: 503,
            errCode: "CONTENT_SECURITY_UNAVAILABLE",
          });
        }
        return { safe: true };
      },
    }
  );

  const result = await service.checkContentSecurity({ content: "测试内容", openid: "openid-test" });
  assert.equal(result.safe, true);
  assert.equal(attempts, 3);
});

test("blocked content is never retried as a transient moderation failure", async () => {
  let attempts = 0;
  const service = new AiService(
    { db: {}, config: {} },
    {
      contentSecurityRetryDelays: [0, 0],
      checkTextSecurity: async () => {
        attempts += 1;
        throw new AppError("内容未通过安全检查", {
          statusCode: 400,
          errCode: "CONTENT_SECURITY_BLOCKED",
        });
      },
    }
  );

  await assert.rejects(
    () => service.checkContentSecurity({ content: "测试内容", openid: "openid-test" }),
    (error) => error.errCode === "CONTENT_SECURITY_BLOCKED"
  );
  assert.equal(attempts, 1);
});

test("reasoning-only completion retries once for a direct final answer", async () => {
  const config = {
    aiCredentialsEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
    aiProviderTimeoutMs: 300000,
  };
  const attempts = [];
  let saved = null;
  const service = new AiService(
    { db: {}, config },
    {
      checkTextSecurity: async () => {},
      streamProviderCompletion: async (options) => {
        attempts.push({ reasoningMode: options.reasoningMode, systemPrompt: options.systemPrompt, maxTokens: options.maxTokens });
        if (attempts.length === 1) {
          options.stats.finishReason = "length";
          options.onReasoning("先完成一段较长思考");
          return { inputTokens: 6, outputTokens: 4096 };
        }
        options.stats.finishReason = "stop";
        options.onDelta("这是自动补全后的最终回答。");
        return { inputTokens: 6, outputTokens: 18 };
      },
    }
  );
  service.prepareGeneration = async () => preparedGeneration(config);
  service.generationContext = async () => [{ role: "user", content: "复杂问题" }];
  service.checkpointGeneration = async () => {};
  service.saveGenerationResult = async (prepared, options) => { saved = options; };
  const events = [];

  await service.chatStream({ reasoningMode: "auto" }, async (event) => events.push(event), new AbortController().signal);

  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].reasoningMode, "off");
  assert.match(attempts[1].systemPrompt, /直接给出完整/);
  assert.equal(saved.status, "success");
  assert.equal(saved.reasoningContent, "先完成一段较长思考");
  assert.equal(saved.content, "这是自动补全后的最终回答。");
  assert.equal(saved.inputTokens, 12);
  assert.equal(saved.outputTokens, 4114);
  assert.equal(saved.reasoningDurationMs >= 1, true);
  assert.equal(events.some((event) => event.type === "reasoning"), true);
  assert.equal(events.filter((event) => event.type === "delta").map((event) => event.content).join(""), saved.content);
  assert.equal(events.at(-1).reasoningDurationMs, saved.reasoningDurationMs);
});

test("reasoning without a final answer still fails clearly after one direct retry", async () => {
  const config = {
    aiCredentialsEncryptionKey: Buffer.alloc(32, 8).toString("base64"),
    aiProviderTimeoutMs: 300000,
  };
  let saved = null;
  let attempts = 0;
  const service = new AiService(
    { db: {}, config },
    {
      checkTextSecurity: async () => {},
      streamProviderCompletion: async (options) => {
        attempts += 1;
        options.onReasoning("只有思考过程");
        return { inputTokens: 3, outputTokens: 5 };
      },
    }
  );
  service.prepareGeneration = async () => preparedGeneration(config);
  service.generationContext = async () => [{ role: "user", content: "问题" }];
  service.checkpointGeneration = async () => {};
  service.saveGenerationResult = async (prepared, options) => { saved = options; };

  await assert.rejects(
    () => service.chatStream({}, async () => {}, new AbortController().signal),
    (error) => error.errCode === "AI_REASONING_WITHOUT_ANSWER"
  );
  assert.equal(saved.status, "failed");
  assert.equal(saved.errorCode, "AI_REASONING_WITHOUT_ANSWER");
  assert.equal(saved.reasoningContent, "只有思考过程");
  assert.equal(attempts, 2);
});

test("reasoning that consumes the provider output limit reports the actual cause", async () => {
  const config = {
    aiCredentialsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
    aiProviderTimeoutMs: 300000,
  };
  let saved = null;
  const service = new AiService(
    { db: {}, config },
    {
      checkTextSecurity: async () => {},
      streamProviderCompletion: async (options) => {
        options.stats.finishReason = "length";
        options.onReasoning("输出额度内只有思考过程");
        return { inputTokens: 3, outputTokens: 4096 };
      },
    }
  );
  service.prepareGeneration = async () => preparedGeneration(config);
  service.generationContext = async () => [{ role: "user", content: "复杂问题" }];
  service.checkpointGeneration = async () => {};
  service.saveGenerationResult = async (prepared, options) => { saved = options; };

  await assert.rejects(
    () => service.chatStream({}, async () => {}, new AbortController().signal),
    (error) => error.errCode === "AI_OUTPUT_LIMIT_REACHED"
  );
  assert.equal(saved.status, "failed");
  assert.equal(saved.errorCode, "AI_OUTPUT_LIMIT_REACHED");
});

test("message history keeps a same-transaction user prompt before its assistant reply", async () => {
  const conversationId = "55555555-5555-4555-8555-555555555555";
  const userMessageId = "66666666-6666-4666-8666-666666666666";
  const assistantMessageId = "77777777-7777-4777-8777-777777777777";
  const createdAt = "2026-07-12T12:00:00.000Z";
  const db = {
    async query(text, params) {
      const sql = String(text);
      if (sql.includes("FROM incircle_ai_conversations")) {
        return { rows: [{ id: conversationId, title: "顺序测试", created_at: createdAt, updated_at: createdAt }] };
      }
      if (sql.includes("FROM incircle_ai_messages")) {
        assert.match(sql, /CASE WHEN role = 'assistant' THEN 1 ELSE 0 END DESC/);
        assert.equal(params[5], -1);
        return {
          rows: [
            { id: assistantMessageId, conversation_id: conversationId, role: "assistant", content: "回答", reasoning_content: " \n\u200b\ufeff ", reasoning_duration_ms: 80200, status: "complete", reply_to_message_id: userMessageId, created_at: createdAt, updated_at: createdAt },
            { id: userMessageId, conversation_id: conversationId, role: "user", content: "提问", status: "complete", created_at: createdAt, updated_at: createdAt },
            { id: "44444444-4444-4444-8444-444444444444", conversation_id: conversationId, role: "assistant", content: "更早", status: "complete", created_at: "2026-07-11T12:00:00.000Z", updated_at: "2026-07-11T12:00:00.000Z" },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const service = new AiService({ db, config: {} }, {});
  service.requireEnabledAi = async () => ({
    ctx: { circleId: "11111111-1111-4111-8111-111111111111", auth: { user: { id: "22222222-2222-4222-8222-222222222222" } } },
  });
  service.failStaleGenerations = async () => {};

  const result = await service.listMessages({ conversationId, pageSize: 2 });
  assert.deepEqual(result.messages.map((message) => message.role), ["user", "assistant"]);
  assert.deepEqual(result.messages.map((message) => message.content), ["提问", "回答"]);
  assert.equal(result.messages[1].reasoningContent, "");
  assert.equal(result.messages[1].reasoningDurationMs, 80200);
  assert.equal(result.nextCursor.endsWith(`|0|${userMessageId}`), true);
});

test("reasoning metrics migration raises the default budget and persists per-message duration", () => {
  const root = path.resolve(__dirname, "../..");
  const schema = fs.readFileSync(path.join(root, "server/db/schema.sql"), "utf8");
  const migration = fs.readFileSync(
    path.join(root, "server/db/migrations/0012_ai_reasoning_metrics.sql"),
    "utf8"
  );
  assert.match(schema, /max_output_tokens integer NOT NULL DEFAULT 8192/);
  assert.match(schema, /reasoning_duration_ms integer NOT NULL DEFAULT 0/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS reasoning_duration_ms/);
  assert.match(migration, /SET max_output_tokens = 8192/);
});

test("generation leases, graceful shutdown, and versioned AI consent are deployed together", async () => {
  const root = path.resolve(__dirname, "../..");
  const schema = fs.readFileSync(path.join(root, "server/db/schema.sql"), "utf8");
  const migration = fs.readFileSync(
    path.join(root, "server/db/migrations/0027_ai_generation_lease_and_consent_history.sql"),
    "utf8"
  );
  const serverSource = fs.readFileSync(path.join(root, "server/src/server.js"), "utf8");
  const compose = fs.readFileSync(path.join(root, "server/docker-compose.yml"), "utf8");
  assert.match(schema, /generation_lease_expires_at timestamptz/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS incircle_ai_consent_acceptances/);
  assert.match(migration, /AI_SERVER_RESTARTED/);
  assert.match(migration, /uq_incircle_ai_consent_acceptance_version/);
  assert.match(serverSource, /recoverExpiredAiGenerations/);
  assert.match(serverSource, /beginAiShutdown/);
  assert.match(compose, /stop_grace_period:\s*30s/);

  let recoveryQuery = "";
  const recovered = await recoverExpiredAiGenerations({
    query: async (sql) => {
      recoveryQuery = sql;
      return { rowCount: 2, rows: [{ id: "one" }, { id: "two" }] };
    },
  });
  assert.equal(recovered.rowCount, 2);
  assert.match(recoveryQuery, /generation_lease_expires_at IS NULL OR generation_lease_expires_at < now\(\)/);
  assert.match(recoveryQuery, /generation_owner_id = ''/);
});

test("model-aware 128K output settings and themed capability controls ship together", () => {
  const root = path.resolve(__dirname, "../..");
  const schema = fs.readFileSync(path.join(root, "server/db/schema.sql"), "utf8");
  const migration = fs.readFileSync(
    path.join(root, "server/db/migrations/0028_ai_model_token_capabilities.sql"),
    "utf8"
  );
  const detectionMigration = fs.readFileSync(
    path.join(root, "server/db/migrations/0029_ai_model_capability_detection.sql"),
    "utf8"
  );
  const output128kMigration = fs.readFileSync(
    path.join(root, "server/db/migrations/0032_ai_output_128k.sql"),
    "utf8"
  );
  const serviceSource = fs.readFileSync(path.join(root, "server/src/services/ai.js"), "utf8");
  const manageJs = fs.readFileSync(path.join(root, "inCircleClient/pages/ai-manage/index.js"), "utf8");
  const manageWxml = fs.readFileSync(path.join(root, "inCircleClient/pages/ai-manage/index.wxml"), "utf8");
  const manageWxss = fs.readFileSync(path.join(root, "inCircleClient/pages/ai-manage/index.wxss"), "utf8");
  const modelsJs = fs.readFileSync(path.join(root, "inCircleClient/pages/ai-models/index.js"), "utf8");
  const modelsWxml = fs.readFileSync(path.join(root, "inCircleClient/pages/ai-models/index.wxml"), "utf8");

  assert.match(schema, /max_output_tokens BETWEEN 128 AND 131072/);
  assert.match(schema, /max_output_tokens_source text NOT NULL DEFAULT ''/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS max_output_tokens/);
  assert.match(migration, /compatibility/);
  assert.match(detectionMigration, /'catalog'/);
  assert.match(detectionMigration, /'probe'/);
  assert.match(output128kMigration, /BETWEEN 128 AND 131072/);
  assert.match(serviceSource, /AI_OUTPUT_PLATFORM_MAX_TOKENS = 131072/);
  assert.match(serviceSource, /AI_OUTPUT_PROBE_TOKEN_PRESETS = Object\.freeze\(\[131072, 65536, 32768, 16384, 8192\]\)/);
  assert.match(serviceSource, /AI_OUTPUT_TEXT_MAX_CHARS = 131072/);
  assert.match(serviceSource, /AI_OUTPUT_COMPATIBILITY_FALLBACK_TOKENS = 8192/);
  assert.match(serviceSource, /max_output_tokens = 0 AND max_output_tokens_source = ''/);
  assert.match(manageJs, /\{ value: 131072, label: "128K" \}/);
  assert.match(manageJs, /MAX_OUTPUT_TOKENS = 131072/);
  assert.match(manageJs, /outputLimitMode: usesPreset \? "preset" : "custom"/);
  assert.match(manageWxml, /maxlength="6"/);
  assert.match(manageWxml, /output-preset-grid/);
  assert.match(manageWxml, /\{\{item\.label\}\}/);
  assert.match(manageWxml, /输入 128–131072 的整数/);
  assert.match(manageWxml, /outputLimitMode == 'preset'/);
  assert.match(manageWxml, /data-mode="custom"/);
  assert.match(manageWxss, /var\(--theme-primary/);
  assert.match(manageWxss, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(modelsWxml, /maxlength="7"/);
  assert.match(modelsWxml, /校准能力参数/);
  assert.match(modelsWxml, /测试并识别/);
  assert.match(manageJs, /能力库匹配/);
  assert.match(modelsJs, /供应商识别/);
  assert.match(modelsJs, /能力库匹配/);
  assert.match(modelsJs, /兼容探测/);
});

test("generation plans clamp output to the model context window", async () => {
  const service = new AiService({ db: {}, config: {} }, {});
  const reasoningMode = { selection: "off", enabled: false, adapter: "none" };
  const plan = await service.buildGenerationPlan({
    ctx: { circleId: "circle-1", auth: { user: { id: "user-1" } } },
    settings: { system_prompt: "system", max_output_tokens: 8192 },
    model: { context_window: 8192 },
    content: "hello",
    reasoningMode,
  });

  assert.equal(plan.contextWindow, 8192);
  assert.equal(plan.contextWindowSource, "model");
  assert.equal(plan.maxOutputTokens < 8192, true);
  assert.equal(plan.maxOutputTokens >= 128, true);
  assert.equal(plan.inputTokenBudget, plan.currentMessageTokens);
  assert.equal(
    plan.reservedSystemPromptTokens + plan.inputTokenBudget + plan.maxOutputTokens + plan.safetyMarginTokens,
    plan.contextWindow
  );
  assert.deepEqual(plan.messages, [{ role: "user", content: "hello" }]);
});

test("unknown model context windows use the conservative 16K fallback", async () => {
  const service = new AiService({ db: {}, config: {} }, {});
  const plan = await service.buildGenerationPlan({
    ctx: { circleId: "circle-1", auth: { user: { id: "user-1" } } },
    settings: { system_prompt: "system", max_output_tokens: 4096 },
    model: { context_window: 0 },
    content: "简短问题",
    reasoningMode: { selection: "off", enabled: false, adapter: "none" },
  });

  assert.equal(plan.contextWindow, 16384);
  assert.equal(plan.contextWindowSource, "fallback");
  assert.equal(plan.maxOutputTokens, 4096);
  assert.equal(plan.historyTokenBudget > 0, true);
});

test("1M context models keep context and output capabilities independent", async () => {
  const service = new AiService({ db: {}, config: {} }, {});
  const knownPlan = await service.buildGenerationPlan({
    ctx: { circleId: "circle-1", auth: { user: { id: "user-1" } } },
    settings: { system_prompt: "system", max_output_tokens: 32768 },
    model: {
      context_window: 1000000,
      max_output_tokens: 16384,
      max_output_tokens_source: "sync",
    },
    content: "整理这份长文",
    reasoningMode: { selection: "off", enabled: false, adapter: "none" },
  });
  assert.equal(knownPlan.contextWindow, 1000000);
  assert.equal(knownPlan.maxOutputTokens, 16384);
  assert.equal(knownPlan.outputCapabilityKnown, true);
  assert.equal(knownPlan.outputCapabilitySource, "sync");

  const unknownPlan = await service.buildGenerationPlan({
    ctx: { circleId: "circle-1", auth: { user: { id: "user-1" } } },
    settings: { system_prompt: "system", max_output_tokens: 32768 },
    model: { context_window: 1000000, max_output_tokens: 0 },
    content: "整理这份长文",
    reasoningMode: { selection: "off", enabled: false, adapter: "none" },
  });
  assert.equal(unknownPlan.maxOutputTokens, 32768);
  assert.equal(unknownPlan.outputCapabilityKnown, false);
  assert.equal(unknownPlan.outputCapabilitySource, "unknown");

  const highOutputPlan = await service.buildGenerationPlan({
    ctx: { circleId: "circle-1", auth: { user: { id: "user-1" } } },
    settings: { system_prompt: "system", max_output_tokens: 131072 },
    model: {
      context_window: 1050000,
      max_output_tokens: 128000,
      max_output_tokens_source: "catalog",
    },
    content: "生成一份完整报告",
    reasoningMode: { selection: "off", enabled: false, adapter: "none" },
  });
  assert.equal(highOutputPlan.configuredMaxOutputTokens, 131072);
  assert.equal(highOutputPlan.modelMaxOutputTokens, 128000);
  assert.equal(highOutputPlan.maxOutputTokens, 128000);
});

test("chat generation sends the computed effective output limit to the provider", async () => {
  const config = {
    aiCredentialsEncryptionKey: Buffer.alloc(32, 23).toString("base64"),
    aiProviderTimeoutMs: 300000,
  };
  let providerRequest = null;
  const service = new AiService(
    { db: {}, config },
    {
      checkTextSecurity: async () => ({ safe: true }),
      streamProviderCompletion: async (options) => {
        providerRequest = options;
        await options.onDelta("完成");
        return { inputTokens: 6, outputTokens: 2 };
      },
    }
  );
  const prepared = preparedGeneration(config);
  prepared.content = "hello";
  prepared.model = Object.assign({}, prepared.model, {
    context_window: 8192,
    preset_key: "openai",
    model_id: "gpt-4o",
  });
  prepared.reasoningMode = resolveReasoningMode(prepared.model, prepared.model, "off");
  prepared.generationPlan = await service.buildGenerationPlan({
    ctx: prepared.ctx,
    settings: Object.assign({}, prepared.settings, { max_output_tokens: 8192 }),
    model: prepared.model,
    content: prepared.content,
    reasoningMode: prepared.reasoningMode,
  });
  prepared.settings.max_output_tokens = 8192;
  service.prepareGeneration = async () => prepared;
  service.generationContext = async () => {
    throw new Error("prepared generation plans must not rebuild context during streaming");
  };
  service.checkpointGeneration = async () => {};
  service.saveGenerationResult = async () => ({ status: "success" });

  await service.chatStream({ reasoningMode: "off" }, async () => {}, new AbortController().signal);

  assert.equal(providerRequest.maxTokens, prepared.generationPlan.maxOutputTokens);
  assert.equal(providerRequest.maxTokens < 8192, true);
  assert.equal(providerRequest.systemPrompt, prepared.generationPlan.systemPrompt);
  assert.deepEqual(providerRequest.messages, prepared.generationPlan.messages);
});

test("unknown output capability retries once at 8K only before any provider output", async () => {
  const config = {
    aiCredentialsEncryptionKey: Buffer.alloc(32, 29).toString("base64"),
    aiProviderTimeoutMs: 300000,
  };
  const attemptedLimits = [];
  let rememberedLimit = 0;
  const service = new AiService(
    { db: {}, config },
    {
      checkTextSecurity: async () => ({ safe: true }),
      streamProviderCompletion: async (options) => {
        attemptedLimits.push(options.maxTokens);
        if (attemptedLimits.length === 1) {
          options.stats.statusCode = 422;
          throw new AppError("供应商不支持当前输出额度", {
            statusCode: 502,
            errCode: "AI_PROVIDER_OUTPUT_LIMIT_UNSUPPORTED",
            details: { providerStatus: 422 },
          });
        }
        await options.onDelta("兼容回答");
        return { inputTokens: 8, outputTokens: 4 };
      },
    }
  );
  const prepared = preparedGeneration(config);
  prepared.content = "hello";
  prepared.model = Object.assign({}, prepared.model, {
    context_window: 1000000,
    max_output_tokens: 0,
    max_output_tokens_source: "",
    preset_key: "openai",
    model_id: "gpt-4o",
  });
  prepared.settings.max_output_tokens = 32768;
  prepared.reasoningMode = resolveReasoningMode(prepared.model, prepared.model, "off");
  prepared.generationPlan = await service.buildGenerationPlan({
    ctx: prepared.ctx,
    settings: prepared.settings,
    model: prepared.model,
    content: prepared.content,
    reasoningMode: prepared.reasoningMode,
  });
  service.prepareGeneration = async () => prepared;
  service.checkpointGeneration = async () => {};
  service.saveGenerationResult = async () => ({ status: "success" });
  service.rememberCompatibleOutputLimit = async (_prepared, limit) => { rememberedLimit = limit; };
  const events = [];

  await service.chatStream({ reasoningMode: "off" }, async (event) => events.push(event), new AbortController().signal);

  assert.deepEqual(attemptedLimits, [32768, 8192]);
  assert.equal(rememberedLimit, 8192);
  assert.equal(events.filter((event) => event.type === "delta").map((event) => event.content).join(""), "兼容回答");
  assert.equal(events.at(-1).type, "done");
});

test("output compatibility never retries after a provider emits content", async () => {
  const config = {
    aiCredentialsEncryptionKey: Buffer.alloc(32, 31).toString("base64"),
    aiProviderTimeoutMs: 300000,
  };
  let attempts = 0;
  const service = new AiService(
    { db: {}, config },
    {
      checkTextSecurity: async () => ({ safe: true }),
      streamProviderCompletion: async (options) => {
        attempts += 1;
        await options.onDelta("已经开始");
        throw new AppError("供应商不支持当前输出额度", {
          statusCode: 502,
          errCode: "AI_PROVIDER_OUTPUT_LIMIT_UNSUPPORTED",
          details: { providerStatus: 422 },
        });
      },
    }
  );
  const prepared = preparedGeneration(config);
  prepared.content = "hello";
  prepared.model = Object.assign({}, prepared.model, {
    context_window: 1000000,
    max_output_tokens: 0,
    preset_key: "openai",
    model_id: "gpt-4o",
  });
  prepared.settings.max_output_tokens = 32768;
  prepared.reasoningMode = resolveReasoningMode(prepared.model, prepared.model, "off");
  prepared.generationPlan = await service.buildGenerationPlan({
    ctx: prepared.ctx,
    settings: prepared.settings,
    model: prepared.model,
    content: prepared.content,
    reasoningMode: prepared.reasoningMode,
  });
  service.prepareGeneration = async () => prepared;
  service.checkpointGeneration = async () => {};
  service.saveGenerationResult = async () => ({ status: "failed" });

  await assert.rejects(
    () => service.chatStream({ reasoningMode: "off" }, async () => {}, new AbortController().signal),
    (error) => error.errCode === "AI_PROVIDER_OUTPUT_LIMIT_UNSUPPORTED"
  );
  assert.equal(attempts, 1);
});

test("an oversized current prompt is rejected before moderation or message inserts", async () => {
  let moderationChecks = 0;
  let transactions = 0;
  const service = new AiService({
    db: {
      withTransaction: async () => {
        transactions += 1;
        throw new Error("transaction should not start");
      },
    },
    config: {},
  }, {});
  service.requireEnabledAi = async () => ({
    ctx: { circleId: "circle-1", auth: { user: { id: "user-1", openid: "openid-1" } } },
    settings: { system_prompt: "system", max_output_tokens: 8192 },
  });
  service.modelForChat = async () => ({
    context_window: 1024,
    protocol: "openai",
    preset_key: "openai",
    model_id: "plain-model",
  });
  service.assertConsent = async () => {};
  service.existingRequest = async () => null;
  service.checkContentSecurity = async () => { moderationChecks += 1; };

  await assert.rejects(
    () => service.prepareGeneration({ content: "中".repeat(400), requestId: "context_limit_123" }),
    (error) => error.errCode === "AI_CONTEXT_WINDOW_EXCEEDED"
      && error.details.contextWindow === 1024
  );
  assert.equal(moderationChecks, 0);
  assert.equal(transactions, 0);
});

test("conversation context keeps newest complete question-answer pairs without slicing", async () => {
  let contextQuery = "";
  let contextParams = null;
  const newestUserId = "user-new";
  const olderUserId = "user-old";
  const service = new AiService({
    db: {
      query: async (sql, values) => {
        contextQuery = sql;
        contextParams = values;
        return {
          rows: [
            { id: "assistant-new", role: "assistant", content: "aaa", reply_to_message_id: newestUserId, created_at: "2026-07-18T03:00:00Z" },
            { id: newestUserId, role: "user", content: "uuu", reply_to_message_id: null, created_at: "2026-07-18T03:00:00Z" },
            { id: "failed-user", role: "user", content: "must-not-appear", reply_to_message_id: null, created_at: "2026-07-18T02:30:00Z" },
            { id: "assistant-old", role: "assistant", content: "bbb", reply_to_message_id: olderUserId, created_at: "2026-07-18T02:00:00Z" },
            { id: olderUserId, role: "user", content: "vvv", reply_to_message_id: null, created_at: "2026-07-18T02:00:00Z" },
          ],
        };
      },
    },
    config: {},
  }, {});
  const context = await service.generationContext(
    "55555555-5555-4555-8555-555555555555",
    { circleId: "11111111-1111-4111-8111-111111111111", auth: { user: { id: "22222222-2222-4222-8222-222222222222" } } },
    { currentContent: "now", inputTokenBudget: 27 }
  );

  assert.match(contextQuery, /message\.status = 'complete'/);
  assert.match(contextQuery, /message\.reply_to_message_id/);
  assert.match(contextQuery, /LIMIT 100/);
  assert.equal(contextParams.length, 3);
  assert.deepEqual(context, [
    { role: "user", content: "uuu" },
    { role: "assistant", content: "aaa" },
    { role: "user", content: "now" },
  ]);
  assert.equal(context.some((message) => message.content === "must-not-appear"), false);
});

test("history trimming stops at an oversized newest pair instead of backfilling older turns", async () => {
  const service = new AiService({
    db: {
      query: async () => ({
        rows: [
          { id: "assistant-new", role: "assistant", content: "a".repeat(90), reply_to_message_id: "user-new", created_at: "2026-07-18T03:00:00Z" },
          { id: "user-new", role: "user", content: "u".repeat(90), reply_to_message_id: null, created_at: "2026-07-18T03:00:00Z" },
          { id: "assistant-old", role: "assistant", content: "aaa", reply_to_message_id: "user-old", created_at: "2026-07-18T02:00:00Z" },
          { id: "user-old", role: "user", content: "uuu", reply_to_message_id: null, created_at: "2026-07-18T02:00:00Z" },
        ],
      }),
    },
    config: {},
  }, {});
  const context = await service.generationContext(
    "55555555-5555-4555-8555-555555555555",
    { circleId: "11111111-1111-4111-8111-111111111111", auth: { user: { id: "22222222-2222-4222-8222-222222222222" } } },
    { currentContent: "now", inputTokenBudget: 27 }
  );
  assert.deepEqual(context, [{ role: "user", content: "now" }]);
});

test("stale generation recovery still uses the generation lease", async () => {
  let query = "";
  const service = new AiService({
    db: {
      query: async (sql) => {
        query = sql;
        return { rows: [] };
      },
    },
    config: {},
  }, {});
  await service.failStaleGenerations(
    { circleId: "11111111-1111-4111-8111-111111111111" },
    "55555555-5555-4555-8555-555555555555"
  );
  assert.match(query, /SET status = 'failed'/);
  assert.match(query, /generation_lease_expires_at < now\(\)/);
});

test("provider stream finishes at DONE without waiting for the upstream socket to close", async () => {
  let iteratorClosed = false;
  const response = {
    async *[Symbol.asyncIterator]() {
      try {
        yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: "完成" } }] })}\n\ndata: [DONE]\n\n`, "utf8");
        await new Promise(() => {});
      } finally {
        iteratorClosed = true;
      }
    },
  };
  let output = "";
  await Promise.race([
    consumeEventStream(response, "openai", async (delta) => {
      output += delta;
    }),
    new Promise((resolve, reject) => setTimeout(() => reject(new Error("stream did not finish at DONE")), 100)),
  ]);
  assert.equal(output, "完成");
  assert.equal(iteratorClosed, true);
});

test("provider stream also finishes at OpenAI finish_reason", async () => {
  const response = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: "结束" }, finish_reason: "stop" }] })}\n\n`, "utf8");
      await new Promise(() => {});
    },
  };
  let output = "";
  await Promise.race([
    consumeEventStream(response, "openai", async (delta) => {
      output += delta;
    }),
    new Promise((resolve, reject) => setTimeout(() => reject(new Error("stream did not finish at finish_reason")), 100)),
  ]);
  assert.equal(output, "结束");
});

test("reconnected AI streams tail an in-progress answer instead of waiting for one full replay", async () => {
  const service = new AiService({ db: {}, config: {} }, {});
  service.prepareGeneration = async () => ({
    ctx: { circleId: "circle-1", auth: { user: { id: "user-1" } } },
    requestId: "request-123",
    replay: {
      conversation_id: "conversation-1",
      assistant_id: "assistant-1",
      assistant_status: "generating",
      assistant_generation_lease_expires_at: "2099-01-01T00:00:00.000Z",
      assistant_content: "恢复",
      assistant_reasoning_content: "恢复后的",
    },
  });
  service.existingRequest = async () => ({
    conversation_id: "conversation-1",
    assistant_id: "assistant-1",
    assistant_status: "complete",
    assistant_content: "恢复后的回答",
    assistant_reasoning_content: "恢复后的思考",
  });
  const events = [];
  await service.chatStream({}, async (event) => events.push(event), new AbortController().signal);
  assert.deepEqual(events.map((event) => event.type), ["ping", "start", "reasoning", "delta", "reasoning", "delta", "done"]);
  assert.equal(events[2].content, "恢复后的");
  assert.equal(events[3].content, "恢复");
  assert.equal(events[4].content, "思考");
  assert.equal(events[5].content, "后的回答");
  assert.equal(events[6].replay, true);
});

test("an expired replay lease becomes a terminal failure instead of polling forever", async () => {
  const service = new AiService({ db: {}, config: { aiProviderTimeoutMs: 300000 } }, {});
  let staleRecoveries = 0;
  service.prepareGeneration = async () => ({
    ctx: { circleId: "circle-1", auth: { user: { id: "user-1" } } },
    requestId: "request-expired",
    replay: {
      conversation_id: "conversation-1",
      assistant_id: "assistant-1",
      assistant_status: "generating",
      assistant_generation_lease_expires_at: "2020-01-01T00:00:00.000Z",
      assistant_content: "部分回答",
      assistant_reasoning_content: "",
    },
  });
  service.failStaleGenerations = async () => { staleRecoveries += 1; };
  service.existingRequest = async () => ({
    conversation_id: "conversation-1",
    assistant_id: "assistant-1",
    assistant_status: "failed",
    assistant_error_code: "AI_GENERATION_LEASE_EXPIRED",
    assistant_content: "部分回答",
    assistant_reasoning_content: "",
  });
  await assert.rejects(
    () => service.chatStream({}, async () => {}, new AbortController().signal),
    (error) => error.errCode === "AI_GENERATION_LEASE_EXPIRED"
  );
  assert.equal(staleRecoveries, 1);
});

test("normal AI response close does not cancel generation", () => {
  const request = { raw: new EventEmitter() };
  const reply = { raw: new EventEmitter() };
  reply.raw.destroyed = false;
  let disconnected = false;
  const unwatch = watchClientDisconnect(request, reply, () => false, () => { disconnected = true; });

  reply.raw.emit("close");

  assert.equal(disconnected, false);
  unwatch();
});

test("aborted AI transport is tracked without cancelling generation", () => {
  const request = { raw: new EventEmitter() };
  const reply = { raw: new EventEmitter() };
  reply.raw.destroyed = false;
  const controller = new AbortController();
  let disconnected = false;
  const unwatch = watchClientDisconnect(request, reply, () => false, () => { disconnected = true; });

  request.raw.emit("aborted");

  assert.equal(disconnected, true);
  assert.equal(controller.signal.aborted, false);
  unwatch();
});

test("only the authenticated member cancel action aborts an active generation", async () => {
  const messageId = "11111111-1111-4111-8111-111111111111";
  const controller = new AbortController();
  const unregister = registerActiveGeneration(messageId, controller);
  let cancelQuery = "";
  const db = {
    query: async (sql) => {
      cancelQuery = sql;
      assert.match(sql, /incircle_ai_messages/);
      return { rows: [{ id: messageId, status: "cancelled" }] };
    },
  };
  const service = new AiService({ db, config: {} }, {});
  service.requireMember = async () => ({
    circleId: "22222222-2222-4222-8222-222222222222",
    auth: { user: { id: "33333333-3333-4333-8333-333333333333" } },
  });
  try {
    const result = await service.cancelGeneration({ messageId });
    assert.equal(result.cancelled, true);
    assert.equal(controller.signal.aborted, true);
    assert.equal(controller.signal.reason.code, "AI_USER_CANCELLED");
    assert.match(cancelQuery, /AND role = 'assistant' AND status = 'generating'/);
    assert.match(cancelQuery, /generation_lease_expires_at = NULL/);
  } finally {
    unregister();
  }
});

test("failed AI request replays expose the generation error instead of a duplicate-request message", async () => {
  const service = new AiService({ db: {}, config: {} }, {});
  service.prepareGeneration = async () => ({
    ctx: { circleId: "circle-1", auth: { user: { id: "user-1" } } },
    requestId: "request-456",
    replay: {
      conversation_id: "conversation-1",
      assistant_id: "assistant-1",
      assistant_status: "failed",
      assistant_content: "",
      assistant_error_code: "AI_PROVIDER_UNAVAILABLE",
    },
  });
  await assert.rejects(
    () => service.chatStream({}, async () => {}, new AbortController().signal),
    (error) => error.errCode === "AI_PROVIDER_UNAVAILABLE" && !String(error.message).includes("已经处理过")
  );
});

test("WeChat transport failures do not expose AppSecret in application errors", async () => {
  const originalFetch = global.fetch;
  const secret = "sensitive-app-secret";
  global.fetch = async () => {
    throw new Error(`request failed with ${secret}`);
  };
  try {
    await assert.rejects(
      () => exchangeWechatLoginCode({ wechatAppId: "app-id", wechatAppSecret: secret }, "login-code"),
      (error) => error.errCode === "WECHAT_LOGIN_UNAVAILABLE" && !String(error.message).includes(secret)
    );
  } finally {
    global.fetch = originalFetch;
  }
});
