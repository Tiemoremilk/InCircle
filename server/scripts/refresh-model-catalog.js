const fs = require("fs");
const path = require("path");

const SOURCE_URL = "https://models.dev/api.json";
const PROVIDER_MAPPING = Object.freeze([
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

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 2000000 ? parsed : 0;
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
  const contextWindow = positiveInteger(model && model.limit && model.limit.context);
  const maxOutputTokens = positiveInteger(model && model.limit && model.limit.output);
  if (contextWindow < 1024 || maxOutputTokens < 128) return null;
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
    providerDocUrl: String(provider.doc || "").trim(),
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
  for (const mapping of PROVIDER_MAPPING) {
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
      providerDocUrl: String(provider.doc || ""),
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
      note: "Versioned community seed for exact model IDs. Manual values, provider metadata, and confirmed probes have higher runtime priority.",
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
