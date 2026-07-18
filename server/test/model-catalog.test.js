const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  importBundledModelCatalog,
  readBundledModelCatalog,
} = require("../src/model-catalog");
const {
  catalogModelCapabilities,
  enrichModelsWithCatalog,
} = require("../src/services/ai/model-capabilities");

function catalogDatabase(existingRelease) {
  const calls = [];
  let transactionCount = 0;
  const db = {
    calls,
    get transactionCount() {
      return transactionCount;
    },
    async withTransaction(callback) {
      transactionCount += 1;
      return callback(this);
    },
    async query(sql, params) {
      const call = { sql: String(sql), params: params || [] };
      calls.push(call);
      if (/SELECT checksum, entry_count/.test(call.sql)) {
        return { rows: existingRelease ? [existingRelease] : [] };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return db;
}

test("bundled model catalog imports one immutable release transactionally", async () => {
  const bundle = readBundledModelCatalog();
  const db = catalogDatabase();
  const result = await importBundledModelCatalog(db);

  assert.deepEqual(result, {
    status: "imported",
    version: bundle.version,
    entryCount: bundle.entries.length,
  });
  assert.equal(db.transactionCount, 1);
  assert.match(db.calls[0].sql, /pg_advisory_xact_lock/);
  const releaseInsert = db.calls.find((call) => /INSERT INTO incircle_ai_model_catalog_releases/.test(call.sql));
  const capabilityInsert = db.calls.find((call) => /INSERT INTO incircle_ai_model_capability_catalog/.test(call.sql));
  assert.equal(releaseInsert.params[0], bundle.version);
  assert.equal(releaseInsert.params[1], bundle.checksum);
  assert.equal(releaseInsert.params[5], bundle.entries.length);
  assert.equal(JSON.parse(capabilityInsert.params[0]).length, bundle.entries.length);
});

test("an unchanged model catalog release is a deployment no-op", async () => {
  const bundle = readBundledModelCatalog();
  const db = catalogDatabase({ checksum: bundle.checksum, entry_count: bundle.entries.length });
  const result = await importBundledModelCatalog(db);

  assert.deepEqual(result, {
    status: "unchanged",
    version: bundle.version,
    entryCount: bundle.entries.length,
  });
  assert.equal(db.calls.some((call) => /INSERT INTO incircle_ai_model_catalog_releases/.test(call.sql)), false);
  assert.equal(db.calls.some((call) => /INSERT INTO incircle_ai_model_capability_catalog/.test(call.sql)), false);
});

test("a changed checksum cannot overwrite an imported catalog version", async () => {
  const bundle = readBundledModelCatalog();
  const db = catalogDatabase({ checksum: "0".repeat(64), entry_count: bundle.entries.length });

  await assert.rejects(
    () => importBundledModelCatalog(db),
    new RegExp(`Model catalog release ${bundle.version.replaceAll(".", "\\.")} changed after import`)
  );
  assert.equal(db.calls.some((call) => /INSERT INTO incircle_ai_model_catalog_releases/.test(call.sql)), false);
});

test("community catalog imports preserve manual and higher-confidence database rows", async () => {
  const db = catalogDatabase();
  await importBundledModelCatalog(db);

  const capabilityInsert = db.calls.find((call) => /INSERT INTO incircle_ai_model_capability_catalog/.test(call.sql));
  const deprecation = db.calls.find((call) => /SET status = 'deprecated'/.test(call.sql));
  assert.match(capabilityInsert.sql, /source_kind <> 'manual'/);
  assert.match(capabilityInsert.sql, /confidence IN \('official', 'verified'\)/);
  assert.match(capabilityInsert.sql, /EXCLUDED\.confidence = 'community'/);
  assert.match(deprecation.sql, /confidence = 'community'/);
});

test("provider metadata wins while the database catalog fills only missing capabilities", async () => {
  let requestedModelIds = [];
  const db = {
    async query(sql, params) {
      requestedModelIds = params[1];
      return {
        rows: [{
          model_id: "partial-model",
          model_id_normalized: "partial-model",
          aliases_normalized: [],
          context_window: 200000,
          max_output_tokens: 65536,
            catalog_version: "2026-07-18.2",
          confidence: "community",
        }],
      };
    },
  };
  const models = await enrichModelsWithCatalog(db, { preset_key: "openai" }, [{
    modelId: "complete-model",
    contextWindow: 1000000,
    contextWindowSource: "sync",
    maxOutputTokens: 32768,
    maxOutputTokensSource: "sync",
  }, {
    modelId: "partial-model",
    contextWindow: 1000000,
    contextWindowSource: "sync",
    maxOutputTokens: 0,
    maxOutputTokensSource: "",
  }]);

  assert.deepEqual(requestedModelIds, ["partial-model"]);
  assert.equal(models[0].contextWindow, 1000000);
  assert.equal(models[0].maxOutputTokens, 32768);
  assert.equal(models[1].contextWindow, 1000000);
  assert.equal(models[1].contextWindowSource, "sync");
  assert.equal(models[1].maxOutputTokens, 65536);
  assert.equal(models[1].maxOutputTokensSource, "catalog");
});

test("custom providers accept only globally unambiguous exact model capabilities", async () => {
  const rowsByModel = {
    "shared-model": [{
      provider_key: "openai",
      model_id_normalized: "shared-model",
      context_window: 1000000,
      max_output_tokens: 32768,
      supports_reasoning: true,
      confidence: "official",
    }, {
      provider_key: "azure",
      model_id_normalized: "shared-model",
      context_window: 1000000,
      max_output_tokens: 32768,
      supports_reasoning: true,
      confidence: "community",
    }],
    "ambiguous-model": [{
      provider_key: "openai",
      model_id_normalized: "ambiguous-model",
      context_window: 1000000,
      max_output_tokens: 32768,
      supports_reasoning: true,
    }, {
      provider_key: "openrouter",
      model_id_normalized: "ambiguous-model",
      context_window: 200000,
      max_output_tokens: 16384,
      supports_reasoning: true,
    }],
  };
  const db = {
    async query(sql, params) {
      assert.doesNotMatch(String(sql), /aliases_normalized/);
      return { rows: (params[0] || []).flatMap((id) => rowsByModel[id] || []) };
    },
  };

  const shared = await catalogModelCapabilities(db, { preset_key: "custom" }, "shared-model");
  assert.equal(shared.matched, true);
  assert.equal(shared.contextWindow, 1000000);
  assert.equal(shared.maxOutputTokens, 32768);

  const ambiguous = await catalogModelCapabilities(db, { preset_key: "custom" }, "ambiguous-model");
  assert.equal(ambiguous.matched, false);
  assert.equal(ambiguous.contextWindow, 0);
  assert.equal(ambiguous.maxOutputTokens, 0);
});

test("database catalog schema, migration, and deploy importer stay wired together", () => {
  const root = path.resolve(__dirname, "../..");
  const schema = fs.readFileSync(path.join(root, "server/db/schema.sql"), "utf8");
  const migration = fs.readFileSync(
    path.join(root, "server/db/migrations/0030_database_model_capability_catalog.sql"),
    "utf8"
  );
  const customLookupMigration = fs.readFileSync(
    path.join(root, "server/db/migrations/0031_custom_model_catalog_lookup.sql"),
    "utf8"
  );
  const migrateSource = fs.readFileSync(path.join(root, "server/src/migrate.js"), "utf8");
  const dockerfile = fs.readFileSync(path.join(root, "server/Dockerfile"), "utf8");
  const bundle = readBundledModelCatalog();

  [schema, migration].forEach((sql) => {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS incircle_ai_model_catalog_releases/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS incircle_ai_model_capability_catalog/);
    assert.match(sql, /UNIQUE \(provider_key, model_id_normalized\)/);
    assert.match(sql, /USING gin\(aliases_normalized\)/);
  });
  assert.match(migrateSource, /await importBundledModelCatalog\(db\)/);
  assert.match(dockerfile, /COPY db \.\/db/);
  assert.match(schema, /idx_incircle_ai_model_catalog_global_active_model/);
  assert.match(customLookupMigration, /model_id_normalized/);
  assert.match(customLookupMigration, /WHERE status = 'active'/);
  assert.equal(bundle.version, "2026-07-18.2");
  assert.ok(bundle.entries.length >= 5000);
  assert.ok(new Set(bundle.entries.map((entry) => entry.provider_key)).size >= 150);
  assert.ok(bundle.entries.some((entry) => !entry.context_window || !entry.max_output_tokens));
});
