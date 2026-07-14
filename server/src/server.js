const { buildApp } = require("./app");
const { loadConfig } = require("./config");

async function main() {
  const config = loadConfig();
  const app = await buildApp({ config });
  await app.listen({
    host: config.host,
    port: config.port,
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
