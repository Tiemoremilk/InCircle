const api = require("../../utils/api");
const time = require("../../utils/time");
const editIntent = require("../../utils/editIntent");
const dialog = require("../../utils/dialog");

function displayDocTime(doc) {
  return time.displayDateTime(doc.updatedAt, doc.updatedAtMs, doc.id)
    || time.displayDateTime(doc.createdAt, doc.createdAtMs, doc.id)
    || "";
}

function decorateDoc(doc) {
  const pillMap = {
    公告: "pill-blue",
    饭局: "pill-green",
    运动: "pill-amber",
    桌游: "pill-red",
    黑话: "pill-blue",
  };
  return Object.assign({}, doc, {
    pillText: doc.pinned ? "置顶资料" : doc.category,
    pillClass: doc.pinned ? "pill-blue" : pillMap[doc.category] || "pill-green",
    body: doc.body || [],
    checklist: doc.checklist || [],
    related: doc.related || [],
    updatedAtText: displayDocTime(doc),
  });
}

Page({
  data: {
    ready: false,
    doc: null,
    actionLoadingType: "",
  },

  onLoad(options) {
    this.docId = options.id;
    this.loadDoc();
  },

  loadDoc() {
    api.getDoc(this.docId).then((doc) => {
      this.setData({
        doc: decorateDoc(doc),
        ready: true,
      });
    });
  },

  editDoc() {
    const doc = this.data.doc || {};
    if (!doc.canEdit) {
      wx.showToast({ title: doc.editDisabledReason || "当前资料不能编辑", icon: "none" });
      return;
    }
    editIntent.setEditIntent("doc", doc.id || this.docId);
    api.clearCache(["incircleDocs"]);
    wx.switchTab({ url: "/pages/docs/index" });
  },

  copyShareText() {
    const doc = this.data.doc;
    wx.setClipboardData({
      data: `【${doc.title}】${doc.summary}`,
      success: () => {
        wx.showToast({
          title: "分享文案已复制",
          icon: "success",
        });
      },
    });
  },

  deleteDoc() {
    const doc = this.data.doc || {};
    if (!doc.canDelete || this.data.actionLoadingType) return;
    dialog.show({
      title: "删除资料",
      content: `确认删除「${doc.title || "这条资料"}」吗？删除后资料库不再展示。`,
      confirmText: "删除",
      confirmColor: "#B34A34",
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ actionLoadingType: "deleteDoc" });
        api
          .deleteDoc(doc.id || this.docId)
          .then(() => {
            wx.showToast({ title: "资料已删除", icon: "success" });
            wx.navigateBack({
              fail: () => wx.switchTab({ url: "/pages/docs/index" }),
            });
          })
          .catch((error) => {
            wx.showToast({ title: (error && error.message) || "删除失败", icon: "none" });
          })
          .then(() => {
            this.setData({ actionLoadingType: "" });
          });
      },
    });
  },

  onShareAppMessage() {
    const doc = this.data.doc || {};
    return {
      title: doc.title ? `圈内资料：${doc.title}` : "周末不宅小队资料库",
      path: `/pages/doc-detail/index?id=${doc.id || this.docId}`,
    };
  },
});
