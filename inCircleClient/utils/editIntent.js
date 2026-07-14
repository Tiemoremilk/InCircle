const STORAGE_KEY = "incircle_pending_business_edit";

function setEditIntent(kind, id) {
  if (!kind || !id) return;
  wx.setStorageSync(STORAGE_KEY, {
    kind: String(kind),
    id: String(id),
    createdAt: Date.now(),
  });
}

function consumeEditIntent(kinds) {
  const allowed = Array.isArray(kinds) ? kinds : [kinds];
  const intent = wx.getStorageSync(STORAGE_KEY);
  if (!intent || allowed.indexOf(intent.kind) === -1) return null;
  wx.removeStorageSync(STORAGE_KEY);
  if (!intent.id || Date.now() - Number(intent.createdAt || 0) > 2 * 60 * 1000) return null;
  return intent;
}

module.exports = {
  setEditIntent,
  consumeEditIntent,
};
