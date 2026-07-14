const { Pool } = require("pg");
const { AsyncLocalStorage } = require("async_hooks");

function createDatabase(config) {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  const transactionStorage = new AsyncLocalStorage();

  function activeConnection() {
    return transactionStorage.getStore() || pool;
  }

  return {
    query(text, params) {
      return activeConnection().query(text, params);
    },
    async withTransaction(callback) {
      const existingClient = transactionStorage.getStore();
      if (existingClient) return callback(this);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await transactionStorage.run(client, () => callback(this));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          error.rollbackError = rollbackError;
        }
        throw error;
      } finally {
        client.release();
      }
    },
    async health() {
      const result = await pool.query(
        "select now() as server_time, current_database() as database_name"
      );
      return result.rows[0];
    },
    async close() {
      await pool.end();
    },
  };
}

module.exports = {
  createDatabase,
};
