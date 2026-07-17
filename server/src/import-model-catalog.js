const { loadConfig } = require("./config");
const { createDatabase } = require("./db");
const { importBundledModelCatalog } = require("./model-catalog");

async function main() {
  const db = createDatabase(loadConfig());
  try {
    const result = await importBundledModelCatalog(db);
    console.log(`Model catalog ${result.version}: ${result.status} (${result.entryCount} entries).`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
