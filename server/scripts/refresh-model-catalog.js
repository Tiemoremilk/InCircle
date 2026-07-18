const fs = require("fs");
const path = require("path");

const SOURCE_URL = "https://models.dev/api.json";
const PRIMARY_PROVIDER_MAPPING = Object.freeze([
  { providerKey: "openai", sourceKey: "openai" },
  { providerKey: "deepseek", sourceKey: "deepseek" },
  { providerKey: "moonshot", sourceKey: "moonshotai-cn" },
  { providerKey: "zhipu", sourceKey: "zhipuai" },
  { providerKey: "qwen", sourceKey: "alibaba-cn" },
  { providerKey: "siliconflow", sourceKey: "siliconflow-cn" },
  { providerKey: "openrouter", sourceKey: "openrouter" },
  { providerKey: "anthropic", sourceKey: "anthropic" },
  { providerKey: "gemini", sourceKey: "google" },
  { providerKey: "azure", sourceKey: "azure" },
]);

function cliValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

function capabilityValue(value, minimum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= 2000000 ? parsed : 0;
}

function normalizedProviderKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function catalogProviderMappings(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const mappings = [];
  const usedProviderKeys = new Set();
  const primarySourceKeys = new Set(PRIMARY_PROVIDER_MAPPING.map((item) => item.sourceKey));
  for (const mapping of PRIMARY_PROVIDER_MAPPING) {
    if (!source[mapping.sourceKey]) continue;
    mappings.push(mapping);
    usedProviderKeys.add(mapping.providerKey);
  }
  for (const sourceKey of Object.keys(source).sort()) {
    if (primarySourceKeys.has(sourceKey)) continue;
    let providerKey = normalizedProviderKey(sourceKey);
    if (usedProviderKeys.has(providerKey)) providerKey = normalizedProviderKey(`modelsdev-${sourceKey}`);
    if (!providerKey || usedProviderKeys.has(providerKey)) {
      throw new Error(`Cannot assign unique provider key for ${sourceKey}`);
    }
    mappings.push({ providerKey, sourceKey });
    usedProviderKeys.add(providerKey);
  }
  return mappings;
}

function optionalHttpsUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    return parsed.protocol === "https:" ? parsed.toString() : "";
  } catch (error) {
    return "";
  }
}

function completeSourceDate(value) {
  const source = String(value || "").trim();
  const matched = /^(\d{4}-\d{2}-\d{2})(?:T.*)?$/.exec(source);
  if (!matched || Number.isNaN(Date.parse(`${matched[1]}T00:00:00Z`))) return "";
  return matched[1];
}

function supportsText(modalities, direction) {
  const values = modalities && Array.isArray(modalities[direction]) ? modalities[direction] : [];
  return !values.length || values.includes("text");
}

function catalogEntry(mapping, provider, modelId, model, observedAt) {
  const contextWindow = capabilityValue(model && model.limit && model.limit.context, 1024);
  const maxOutputTokens = capabilityValue(model && model.limit && model.limit.output, 128);
  if (!contextWindow && !maxOutputTokens) return null;
  if (!supportsText(model.modalities, "input") || !supportsText(model.modalities, "output")) return null;
  return {
    providerKey: mapping.providerKey,
    modelId,
    canonicalModelId: String(model.id || modelId).trim() || modelId,
    displayName: String(model.name || modelId).trim().slice(0, 160),
    aliases: [],
    contextWindow,
    maxOutputTokens,
    supportsReasoning: typeof model.reasoning === "boolean" ? model.reasoning : null,
    confidence: "community",
    sourceKind: "models.dev",
    sourceUrl: SOURCE_URL,
    providerDocUrl: optionalHttpsUrl(provider.doc),
    releaseDate: completeSourceDate(model.release_date),
    lastUpdated: completeSourceDate(model.last_updated),
    lastVerifiedAt: observedAt,
    status: String(model.status || "").toLowerCase() === "deprecated" ? "deprecated" : "active",
  };
}

async function main() {
  const response = await fetch(SOURCE_URL, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Catalog source returned HTTP ${response.status}`);
  const payload = await response.json();
  const observedAt = new Date().toISOString();
  const version = cliValue("--catalog-version") || cliValue("--version") || observedAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}(?:\.\d+)?$/.test(version)) {
    throw new Error("Catalog version must look like YYYY-MM-DD or YYYY-MM-DD.N");
  }

  const entries = [];
  const providers = [];
  for (const mapping of catalogProviderMappings(payload)) {
    const provider = payload[mapping.sourceKey];
    if (!provider || !provider.models || typeof provider.models !== "object") continue;
    let count = 0;
    for (const [modelId, model] of Object.entries(provider.models)) {
      const entry = catalogEntry(mapping, provider, modelId, model || {}, observedAt);
      if (!entry) continue;
      entries.push(entry);
      count += 1;
    }
    providers.push({
      providerKey: mapping.providerKey,
      sourceKey: mapping.sourceKey,
      name: String(provider.name || mapping.sourceKey),
      providerDocUrl: optionalHttpsUrl(provider.doc),
      entryCount: count,
    });
  }
  entries.sort((left, right) => (
    left.providerKey.localeCompare(right.providerKey) || left.modelId.localeCompare(right.modelId)
  ));

  const bundle = {
    version,
    source: {
      name: "models.dev",
      url: SOURCE_URL,
      observedAt,
      note: "Versioned community seed across all source providers for exact model IDs. Partial capabilities remain unknown. Manual values, provider metadata, and confirmed probes have higher runtime priority.",
    },
    providers,
    entries,
  };
  const outputPath = path.join(__dirname, "..", "db", "catalog", "model-capabilities.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  console.log(`Wrote ${entries.length} catalog entries to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
