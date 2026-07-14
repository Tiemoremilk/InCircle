const runtimeEnv = require("./config/runtimeEnv");
const envList = runtimeEnv.getRuntimeEnvList();
const isMac = false;
module.exports = {
  envList,
  isMac
};
