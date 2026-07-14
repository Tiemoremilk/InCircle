const RUNTIME_ENV_BY_VERSION = {
  develop: {
    envVersion: "develop",
    alias: "InCircle 开发版",
  },
  trial: {
    envVersion: "trial",
    alias: "InCircle 体验版",
  },
  release: {
    envVersion: "release",
    alias: "InCircle 正式版",
  },
};

function getRuntimeEnvVersion() {
  if (typeof wx === "undefined" || typeof wx.getAccountInfoSync !== "function") {
    return "develop";
  }
  try {
    const accountInfo = wx.getAccountInfoSync();
    return (accountInfo && accountInfo.miniProgram && accountInfo.miniProgram.envVersion) || "develop";
  } catch (error) {
    return "develop";
  }
}

function getRuntimeEnv(envVersion) {
  const version = envVersion || getRuntimeEnvVersion();
  return RUNTIME_ENV_BY_VERSION[version] || RUNTIME_ENV_BY_VERSION.develop;
}

function getRuntimeEnvList() {
  return ["develop", "trial", "release"].map((version) => RUNTIME_ENV_BY_VERSION[version]);
}

module.exports = {
  RUNTIME_ENV_BY_VERSION,
  getRuntimeEnvVersion,
  getRuntimeEnv,
  getRuntimeEnvList,
};
