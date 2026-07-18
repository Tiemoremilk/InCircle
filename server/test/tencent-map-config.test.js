const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "../..");
const DEPLOY_EXAMPLE_PATH = path.join(ROOT, "scripts/deploy-server.example.ps1");
const PRIVATE_DEPLOY_PATH = path.join(ROOT, "scripts/deploy-server.ps1");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function normalizePrivateDefaults(source) {
  let inParamBlock = false;
  return source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      if (line === "param(") inParamBlock = true;
      if (inParamBlock && /^\s*\)\s*$/.test(line)) inParamBlock = false;
      if (!inParamBlock) return line;
      return line.replace(
        /^(\s*\[string\]\$\w+\s*=\s*)".*"(\s*,\s*)$/,
        '$1"<local-default>"$2'
      );
    })
    .join("\n");
}

function signature(source) {
  return crypto.createHash("sha256").update(source).digest("hex");
}

test("Tencent map key is carried through the deploy template without embedding a secret", () => {
  const deploy = read("scripts/deploy-server.example.ps1");
  const bridgeCount = (deploy.match(/TENCENT_MAP_KEY_VALUE=\$quotedTencentMapKey/g) || []).length;
  const fillEmpty = deploy.match(/fill_empty_line\(\) \{([\s\S]*?)\n\}/);

  assert.match(deploy, /\[string\]\$TencentMapKey = ""/);
  assert.match(deploy, /TENCENT_MAP_KEY_VALUE="\$\{TENCENT_MAP_KEY_VALUE:-\}"/);
  assert.match(deploy, /^TENCENT_MAP_KEY=\$\{TENCENT_MAP_KEY_VALUE\}$/m);
  assert.match(deploy, /ensure_line TENCENT_MAP_KEY "\$TENCENT_MAP_KEY_VALUE"/);
  assert.match(
    deploy,
    /if \[ -n "\$TENCENT_MAP_KEY_VALUE" \]; then\s+fill_empty_line TENCENT_MAP_KEY "\$TENCENT_MAP_KEY_VALUE"/
  );
  assert.equal(bridgeCount, 2, "both deployment transports must pass the map key");
  assert.ok(fillEmpty, "fill_empty_line helper must exist");
  assert.match(fillEmpty[1], /\[\[:space:\]\]\*/);
  assert.match(fillEmpty[1], /set_line "\$key" "\$value"/);
  assert.match(
    deploy,
    /compose exec -T api node -e 'process\.exit\(process\.env\.TENCENT_MAP_KEY \? 0 : 1\)'/
  );
});

test("Compose injects the map key and runtime config reads the same variable", () => {
  const compose = read("server/docker-compose.yml");
  const envExample = read("server/.env.example");
  const previousNodeEnv = process.env.NODE_ENV;
  const previousMapKey = process.env.TENCENT_MAP_KEY;
  const placeholder = "test-only-map-key";

  assert.match(compose, /^\s+TENCENT_MAP_KEY: \$\{TENCENT_MAP_KEY:-\}$/m);
  assert.match(envExample, /^TENCENT_MAP_KEY=$/m);

  try {
    process.env.NODE_ENV = "test";
    process.env.TENCENT_MAP_KEY = placeholder;
    const { loadConfig } = require("../src/config");
    assert.equal(loadConfig().tencentMapKey, placeholder);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousMapKey === undefined) delete process.env.TENCENT_MAP_KEY;
    else process.env.TENCENT_MAP_KEY = previousMapKey;
  }
});

test(
  "private and example deploy scripts have the same structure",
  { skip: !fs.existsSync(PRIVATE_DEPLOY_PATH) },
  () => {
    const privateScript = normalizePrivateDefaults(fs.readFileSync(PRIVATE_DEPLOY_PATH, "utf8"));
    const exampleScript = normalizePrivateDefaults(fs.readFileSync(DEPLOY_EXAMPLE_PATH, "utf8"));
    assert.equal(
      signature(privateScript),
      signature(exampleScript),
      "private deploy script differs from the template outside local parameter defaults"
    );
  }
);
