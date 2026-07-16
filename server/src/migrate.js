const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { loadConfig } = require("./config");
const { createDatabase } = require("./db");
const { reconcilePublicLegalProfile } = require("./legal-profile");
const { reconcileDefaultSystemDocs } = require("./system-docs");

function checksumOf(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function readMigrationFiles() {
  const migrationsDir = path.join(__dirname, "..", "db", "migrations");
  if (!fs.existsSync(migrationsDir)) return [];
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const filePath = path.join(migrationsDir, name);
      const sql = fs.readFileSync(filePath, "utf8");
      return {
        id: name,
        sql,
        checksum: checksumOf(sql),
      };
    });
}

async function ensureMigrationTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS incircle_schema_migrations (
      id text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedMigrations(db) {
  const result = await db.query("SELECT id, checksum FROM incircle_schema_migrations");
  return result.rows.reduce((map, row) => {
    map[row.id] = row.checksum;
    return map;
  }, {});
}

async function applyVersionedMigration(db, migration) {
  await db.withTransaction(async () => {
    await db.query(migration.sql);
    await db.query(
      "INSERT INTO incircle_schema_migrations (id, checksum) VALUES ($1, $2)",
      [migration.id, migration.checksum]
    );
    console.log(`Applied migration ${migration.id}`);
  });
}

async function main() {
  const config = loadConfig();
  const db = createDatabase(config);
  const schemaPath = path.join(__dirname, "..", "db", "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");

  try {
    await ensureMigrationTable(db);
    await db.query(schema);
    const applied = await getAppliedMigrations(db);
    const migrations = readMigrationFiles();
    for (const migration of migrations) {
      const appliedChecksum = applied[migration.id];
      if (appliedChecksum && appliedChecksum !== migration.checksum) {
        throw new Error(`Migration ${migration.id} was changed after it was applied.`);
      }
      if (!appliedChecksum) await applyVersionedMigration(db, migration);
    }
    const legalProfile = await db.withTransaction(() => reconcilePublicLegalProfile(db, config));
    if (config.nodeEnv === "production" && !legalProfile.configured) {
      throw new Error(
        "Public legal profile is incomplete. Configure all five LEGAL_* values before deployment."
      );
    }
    console.log(`Public legal profile ${legalProfile.configured ? "is configured" : "is not configured"}.`);
    const systemDocs = await db.withTransaction(() => reconcileDefaultSystemDocs(db));
    console.log(
      `System docs reconciled for ${systemDocs.circles} circles `
      + `(${systemDocs.inserted} added, ${systemDocs.updated} updated).`
    );
    console.log("InCircle schema migration completed.");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
