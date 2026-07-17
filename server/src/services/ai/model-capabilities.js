const MAX_CAPABILITY_TOKENS = 2000000;

function normalizedCapabilityValue(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_CAPABILITY_TOKENS ? parsed : 0;
}

function normalizedModelId(value) {
  return String(value || "").trim().replace(/^models\//i, "").toLowerCase();
}

function providerPresetKey(provider) {
  const source = provider && typeof provider === "object" ? provider : {};
  return String(source.preset_key || source.presetKey || "").trim().toLowerCase();
}

function catalogProviderKey(provider) {
  const key = providerPresetKey(provider);
  return key && key !== "custom" ? key : "";
}

function catalogCapabilityIdentity(row) {
  const reasoning = typeof row.supports_reasoning === "boolean" ? String(row.supports_reasoning) : "unknown";
  return [
    normalizedCapabilityValue(row.context_window),
    normalizedCapabilityValue(row.max_output_tokens),
    reasoning,
  ].join(":");
}

function emptyCatalogCapability() {
  return {
    contextWindow: 0,
    maxOutputTokens: 0,
    supportsReasoning: null,
    matched: false,
    catalogVersion: "",
    confidence: "",
    sourceUrl: "",
  };
}

function publicCatalogCapability(row) {
  if (!row) return emptyCatalogCapability();
  return {
    contextWindow: normalizedCapabilityValue(row.context_window),
    maxOutputTokens: normalizedCapabilityValue(row.max_output_tokens),
    supportsReasoning: typeof row.supports_reasoning === "boolean" ? row.supports_reasoning : null,
    matched: true,
    catalogVersion: String(row.catalog_version || ""),
    confidence: String(row.confidence || ""),
    sourceUrl: String(row.provider_doc_url || row.source_url || ""),
  };
}

async function customCatalogCapabilitiesForModels(db, normalizedIds) {
  const result = await db.query(
    `SELECT *
     FROM incircle_ai_model_capability_catalog
     WHERE status = 'active' AND model_id_normalized = ANY($1::text[])
     ORDER BY
       model_id_normalized,
       CASE confidence WHEN 'official' THEN 3 WHEN 'verified' THEN 2 ELSE 1 END DESC,
       last_verified_at DESC NULLS LAST,
       updated_at DESC`,
    [normalizedIds]
  );
  const candidates = new Map(normalizedIds.map((id) => [id, []]));
  for (const row of result.rows) {
    const exactId = normalizedModelId(row.model_id_normalized || row.model_id);
    if (candidates.has(exactId)) candidates.get(exactId).push(row);
  }
  return new Map(normalizedIds.map((id) => {
    const rows = candidates.get(id) || [];
    const capabilityIdentities = new Set(rows.map(catalogCapabilityIdentity));
    const matched = rows.length && capabilityIdentities.size === 1 ? rows[0] : null;
    return [id, publicCatalogCapability(matched)];
  }));
}

async function catalogCapabilitiesForModels(db, provider, modelIds) {
  const providerKey = catalogProviderKey(provider);
  const presetKey = providerPresetKey(provider);
  const normalizedIds = Array.from(new Set((Array.isArray(modelIds) ? modelIds : [])
    .map(normalizedModelId)
    .filter(Boolean)));
  if (!normalizedIds.length) return new Map();
  if (presetKey === "custom") return customCatalogCapabilitiesForModels(db, normalizedIds);
  if (!providerKey) return new Map();
  const result = await db.query(
    `SELECT *
     FROM incircle_ai_model_capability_catalog
     WHERE provider_key = $1 AND status = 'active'
       AND (
         model_id_normalized = ANY($2::text[])
         OR aliases_normalized && $2::text[]
       )
     ORDER BY
       CASE confidence WHEN 'official' THEN 3 WHEN 'verified' THEN 2 ELSE 1 END DESC,
       last_verified_at DESC NULLS LAST,
       updated_at DESC`,
    [providerKey, normalizedIds]
  );
  const exact = new Map();
  const aliases = new Map();
  for (const row of result.rows) {
    const exactId = normalizedModelId(row.model_id_normalized || row.model_id);
    if (exactId && !exact.has(exactId)) exact.set(exactId, row);
    for (const alias of Array.isArray(row.aliases_normalized) ? row.aliases_normalized : []) {
      const normalizedAlias = normalizedModelId(alias);
      if (normalizedAlias && !aliases.has(normalizedAlias)) aliases.set(normalizedAlias, row);
    }
  }
  return new Map(normalizedIds.map((id) => [id, publicCatalogCapability(exact.get(id) || aliases.get(id))]));
}

async function catalogModelCapabilities(db, provider, modelId) {
  const normalizedId = normalizedModelId(modelId);
  if (!normalizedId) return emptyCatalogCapability();
  const detected = await catalogCapabilitiesForModels(db, provider, [normalizedId]);
  return detected.get(normalizedId) || emptyCatalogCapability();
}

async function enrichModelsWithCatalog(db, provider, models) {
  const sourceModels = Array.isArray(models) ? models : [];
  const incompleteModels = sourceModels.filter((model) => (
    !normalizedCapabilityValue(model && model.contextWindow) ||
    !normalizedCapabilityValue(model && model.maxOutputTokens)
  ));
  const detected = await catalogCapabilitiesForModels(
    db,
    provider,
    incompleteModels.map((model) => model && model.modelId)
  );
  return sourceModels.map((model) => {
    const source = model || {};
    const catalog = detected.get(normalizedModelId(source.modelId)) || emptyCatalogCapability();
    const contextWindow = normalizedCapabilityValue(source.contextWindow) || catalog.contextWindow;
    const maxOutputTokens = normalizedCapabilityValue(source.maxOutputTokens) || catalog.maxOutputTokens;
    return Object.assign({}, source, {
      contextWindow,
      contextWindowSource: contextWindow
        ? normalizedCapabilityValue(source.contextWindow) ? "sync" : "catalog"
        : "",
      maxOutputTokens,
      maxOutputTokensSource: maxOutputTokens
        ? normalizedCapabilityValue(source.maxOutputTokens) ? "sync" : "catalog"
        : "",
      catalogVersion: catalog.catalogVersion,
      catalogConfidence: catalog.confidence,
    });
  });
}

module.exports = {
  catalogCapabilitiesForModels,
  catalogModelCapabilities,
  catalogProviderKey,
  emptyCatalogCapability,
  enrichModelsWithCatalog,
  MAX_CAPABILITY_TOKENS,
  normalizedCapabilityValue,
  normalizedModelId,
};
