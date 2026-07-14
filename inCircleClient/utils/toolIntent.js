const STORAGE_KEY = "incircle_pending_tool_tab";
const VALID_TOOL_TABS = ["aa", "vote", "checkin"];
const MAX_AGE_MS = 2 * 60 * 1000;

function setToolIntent(tool) {
  const value = String(tool || "").trim();
  if (VALID_TOOL_TABS.indexOf(value) === -1) return;
  wx.setStorageSync(STORAGE_KEY, {
    tool: value,
    createdAt: Date.now(),
  });
}

function consumeToolIntent() {
  const intent = wx.getStorageSync(STORAGE_KEY);
  if (!intent) return "";
  wx.removeStorageSync(STORAGE_KEY);
  if (Date.now() - Number(intent.createdAt || 0) > MAX_AGE_MS) return "";
  const value = String(intent.tool || "").trim();
  return VALID_TOOL_TABS.indexOf(value) !== -1 ? value : "";
}

module.exports = {
  consumeToolIntent,
  setToolIntent,
};
