const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_BUNDLE_PATH = path.join(__dirname, "..", "db", "catalog", "model-capabilities.json");
const ALLOWED_CONFIDENCE = new Set(["official", "verified", "community"]);
const ALLOWED_STATUS = new Set(["active", "deprecated"]);

function checksumOf(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function normalizedModelId(value) {
  return String(value || "").trim().replace(/^models\//i, "").toLowerCase();
}

function positiveCapability(value, minimum, label) {
  const parsed = Number(value || 0);
  if (parsed === 0) return 0;
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > 2000000) {
    throw new Error(`Invalid ${label} capability: ${value}`);
  }
  return parsed;
}

function optionalDate(value, label) {
  const source = String(value || "").trim();
  if (!source) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(source) || Number.isNaN(Date.parse(`${source}T00:00:00Z`))) {
    throw new Error(`Invalid ${label}: ${source}`);
  }
  return source;
}

function optionalHttpsUrl(value, label) {
  const source = String(value || "").trim();
  if (!source) return "";
  let parsed;
  try {
    parsed = new URL(source);
  } catch (error) {
    throw new Error(`Invalid ${label}: ${source}`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  return parsed.toString();
}

function normalizedCatalogEntry(entry, version) {
  const source = entry && typeof entry === "object" ? entry : {};
  const providerKey = String(source.providerKey || "").trim().toLowerCase();
  const modelId = String(source.modelId || "").trim().replace(/^models\//i, "");
  const modelIdNormalized = normalizedModelId(modelId);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(providerKey)) throw new Error(`Invalid provider key: ${providerKey}`);
  if (!modelId || modelId.length > 240 || /[\u0000-\u001f]/.test(modelId)) throw new Error(`Invalid model id: ${modelId}`);
  const aliases = Array.from(new Set((Array.isArray(source.aliases) ? source.aliases : [])
    .map((alias) => String(alias || "").trim().replace(/^models\//i, ""))
    .filter((alias) => alias && alias.length <= 240 && !/[\u0000-\u001f]/.test(alias))));
  const aliasesNormalized = Array.from(new Set(aliases.map(normalizedModelId))).filter((alias) => alias !== modelIdNormalized);
  const confidence = String(source.confidence || "community").trim().toLowerCase();
  const status = String(source.status || "active").trim().toLowerCase();
  if (!ALLOWED_CONFIDENCE.has(confidence)) throw new Error(`Invalid catalog confidence: ${confidence}`);
  if (!ALLOWED_STATUS.has(status)) throw new Error(`Invalid catalog status: ${status}`);
  return {
    provider_key: providerKey,
    model_id: modelId,
    model_id_normalized: modelIdNormalized,
    canonical_model_id: String(source.canonicalModelId || modelId).trim().slice(0, 240),
    display_name: String(source.displayName || modelId).trim().slice(0, 160),
    aliases,
    aliases_normalized: aliasesNormalized,
    context_window: positiveCapability(source.contextWindow, 1024, "context window"),
    max_output_tokens: positiveCapability(source.maxOutputTokens, 128, "max output"),
    supports_reasoning: typeof source.supportsReasoning === "boolean" ? source.supportsReasoning : null,
    confidence,
    source_kind: String(source.sourceKind || "").trim().slice(0, 80),
    source_url: optionalHttpsUrl(source.sourceUrl, "catalog source URL"),
    provider_doc_url: optionalHttpsUrl(source.providerDocUrl, "provider documentation URL"),
    catalog_version: version,
    release_date: optionalDate(source.releaseDate, "release date"),
    source_updated_at: optionalDate(source.lastUpdated, "source update date"),
    last_verified_at: source.lastVerifiedAt ? new Date(source.lastVerifiedAt).toISOString() : null,
    status,
    metadata: {},
  };
}

function readBundledModelCatalog(filePath) {
  const target = filePath || DEFAULT_BUNDLE_PATH;
  const raw = fs.readFileSync(target, "utf8");
  const payload = JSON.parse(raw);
  const version = String(payload.version || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:\.\d+)?$/.test(version)) throw new Error("Invalid model catalog version");
  const source = payload.source && typeof payload.source === "object" ? payload.source : {};
  const entries = (Array.isArray(payload.entries) ? payload.entries : []).map((entry) => (
    normalizedCatalogEntry(entry, version)
  ));
  if (!entries.length || entries.length > 5000) throw new Error("Model catalog must contain 1-5000 entries");
  const identities = new Set();
  for (const entry of entries) {
    const identity = `${entry.provider_key}\u0000${entry.model_id_normalized}`;
    if (identities.has(identity)) throw new Error(`Duplicate model catalog entry: ${entry.provider_key}/${entry.model_id}`);
    identities.add(identity);
  }
  const observedAt = source.observedAt ? new Date(source.observedAt) : null;
  if (observedAt && Number.isNaN(observedAt.getTime())) throw new Error("Invalid model catalog observation time");
  return {
    version,
    checksum: checksumOf(raw),
    sourceName: String(source.name || "bundled").trim().slice(0, 80),
    sourceUrl: optionalHttpsUrl(source.url, "bundle source URL"),
    observedAt: observedAt ? observedAt.toISOString() : null,
    entries,
  };
}

async function importBundledModelCatalog(db, options) {
  const bundle = readBundledModelCatalog(options && options.filePath);
  return db.withTransaction(async () => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["incircle-ai-model-catalog"]);
    const existing = await db.query(
      "SELECT checksum, entry_count FROM incircle_ai_model_catalog_releases WHERE version = $1 LIMIT 1",
      [bundle.version]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== bundle.checksum) {
        throw new Error(`Model catalog release ${bundle.version} changed after import.`);
      }
      return {
        status: "unchanged",
        version: bundle.version,
        entryCount: Number(existing.rows[0].entry_count || 0),
      };
    }

    await db.query(
      `INSERT INTO incircle_ai_model_catalog_releases (
         version, checksum, source_name, source_url, observed_at, entry_count
       ) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        bundle.version,
        bundle.checksum,
        bundle.sourceName,
        bundle.sourceUrl,
        bundle.observedAt,
        bundle.entries.length,
      ]
    );
    await db.query(
      `
      INSERT INTO incircle_ai_model_capability_catalog (
        provider_key, model_id, model_id_normalized, canonical_model_id, display_name,
        aliases, aliases_normalized, context_window, max_output_tokens, supports_reasoning,
        confidence, source_kind, source_url, provider_doc_url, catalog_version,
        release_date, source_updated_at, last_verified_at, status, metadata
      )
      SELECT
        item.provider_key, item.model_id, item.model_id_normalized, item.canonical_model_id, item.display_name,
        item.aliases, item.aliases_normalized, item.context_window, item.max_output_tokens, item.supports_reasoning,
        item.confidence, item.source_kind, item.source_url, item.provider_doc_url, item.catalog_version,
        item.release_date, item.source_updated_at, item.last_verified_at, item.status, item.metadata
      FROM jsonb_to_recordset($1::jsonb) AS item(
        provider_key text, model_id text, model_id_normalized text, canonical_model_id text, display_name text,
        aliases text[], aliases_normalized text[], context_window integer, max_output_tokens integer,
        supports_reasoning boolean, confidence text, source_kind text, source_url text, provider_doc_url text,
        catalog_version text, release_date date, source_updated_at date, last_verified_at timestamptz,
        status text, metadata jsonb
      )
      ON CONFLICT (provider_key, model_id_normalized) DO UPDATE SET
        model_id = EXCLUDED.model_id,
        canonical_model_id = EXCLUDED.canonical_model_id,
        display_name = EXCLUDED.display_name,
        aliases = EXCLUDED.aliases,
        aliases_normalized = EXCLUDED.aliases_normalized,
        context_window = EXCLUDED.context_window,
        max_output_tokens = EXCLUDED.max_output_tokens,
        supports_reasoning = EXCLUDED.supports_reasoning,
        confidence = EXCLUDED.confidence,
        source_kind = EXCLUDED.source_kind,
        source_url = EXCLUDED.source_url,
        provider_doc_url = EXCLUDED.provider_doc_url,
        catalog_version = EXCLUDED.catalog_version,
        release_date = EXCLUDED.release_date,
        source_updated_at = EXCLUDED.source_updated_at,
        last_verified_at = EXCLUDED.last_verified_at,
        status = EXCLUDED.status,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      WHERE incircle_ai_model_capability_catalog.source_kind <> 'manual'
        AND NOT (
          incircle_ai_model_capability_catalog.confidence IN ('official', 'verified')
          AND EXCLUDED.confidence = 'community'
        )
      `,
      [JSON.stringify(bundle.entries)]
    );
    const providerKeys = Array.from(new Set(bundle.entries.map((entry) => entry.provider_key)));
    await db.query(
      `UPDATE incircle_ai_model_capability_catalog
       SET status = 'deprecated', updated_at = now()
       WHERE source_kind = $1 AND confidence = 'community'
         AND provider_key = ANY($2::text[]) AND catalog_version <> $3 AND status = 'active'`,
      [bundle.sourceName, providerKeys, bundle.version]
    );
    return { status: "imported", version: bundle.version, entryCount: bundle.entries.length };
  });
}

module.exports = {
  DEFAULT_BUNDLE_PATH,
  importBundledModelCatalog,
  normalizedCatalogEntry,
  readBundledModelCatalog,
};
