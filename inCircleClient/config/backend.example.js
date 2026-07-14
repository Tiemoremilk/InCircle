const runtimeEnv = require("./runtimeEnv");

const DEFAULT_HTTP_TIMEOUT_MS = 15000;
const EXAMPLE_BACKEND_BASE_URL = "https://your-api.example.com";

const BACKEND_BY_VERSION = {
  develop: {
    mode: "http",
    baseUrl: EXAMPLE_BACKEND_BASE_URL,
    timeout: DEFAULT_HTTP_TIMEOUT_MS,
  },
  trial: {
    mode: "http",
    baseUrl: EXAMPLE_BACKEND_BASE_URL,
    timeout: DEFAULT_HTTP_TIMEOUT_MS,
  },
  release: {
    mode: "http",
    baseUrl: EXAMPLE_BACKEND_BASE_URL,
    timeout: DEFAULT_HTTP_TIMEOUT_MS,
  },
};

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function normalizeMode() {
  return "http";
}

function getBackendConfig(envVersion) {
  const version = envVersion || runtimeEnv.getRuntimeEnvVersion();
  const config = BACKEND_BY_VERSION[version] || BACKEND_BY_VERSION.develop;
  const mode = normalizeMode(config.mode);
  return {
    envVersion: version,
    mode,
    useHttpBackend: mode === "http",
    baseUrl: trimTrailingSlash(config.baseUrl),
    timeout: config.timeout || DEFAULT_HTTP_TIMEOUT_MS,
    headers: config.headers || {},
  };
}

module.exports = {
  BACKEND_BY_VERSION,
  getBackendConfig,
};
