const api = require("../../utils/api");
const time = require("../../utils/time");
const editIntent = require("../../utils/editIntent");
const dialog = require("../../utils/dialog");

const CATEGORY_OPTIONS = ["公告", "指南", "规则", "攻略", "饭局", "运动", "桌游", "链接", "黑话"];

function emptyDocDraft() {
  return {
    title: "",
    category: "公告",
    summary: "",
    bodyText: "",
    checklistText: "",
    relatedText: "",
  };
}

function docToDraft(doc) {
  return {
    title: doc.title || "",
    category: CATEGORY_OPTIONS.indexOf(doc.category) !== -1 ? doc.category : "公告",
    summary: doc.summary || "",
    bodyText: (doc.body || []).join("\n"),
    checklistText: (doc.checklist || []).join("\n"),
    relatedText: (doc.related || []).join("、"),
  };
}

function nowDateTime() {
  return time.nowDateTime();
}

function displayDocTime(doc) {
  return time.displayDateTime(doc.updatedAt, doc.updatedAtMs, doc.id)
    || time.displayDateTime(doc.createdAt, doc.createdAtMs, doc.id)
    || "";
}

function buildCategories(docs) {
  const categories = docs.reduce((list, doc) => {
    if (list.indexOf(doc.category) === -1) list.push(doc.category);
    return list;
  }, []);
  return ["全部"].concat(categories);
}

function decorateCategories(names, activeCategory) {
  return names.map((name) => ({
    name,
    activeClass: name === activeCategory ? "active" : "",
  }));
}

function decorateDoc(doc) {
  return Object.assign({}, doc, {
    pillText: doc.pinned ? "置顶" : doc.category,
    pillClass: doc.pinned ? "pill-blue" : "pill-green",
    updatedAtText: displayDocTime(doc),
  });
}

Page({
  data: {
    loading: true,
    docs: [],
    filteredDocs: [],
    categories: decorateCategories(["全部"], "全部"),
    activeCategory: "全部",
    categoryOptions: CATEGORY_OPTIONS,
    showCreateSheet: false,
    editingDocId: "",
    docFormKicker: "新增资料",
    docFormTitle: "把重要信息沉淀下来",
    actionLoadingType: "",
    actionLoadingId: "",
    docDraft: emptyDocDraft(),
  },

  onShow() {
    this.loadDocs();
  },

  loadDocs() {
    api.listDocs().then((docs) => {
      const sortedDocs = docs.slice().sort((a, b) => Number(b.pinned) - Number(a.pinned)).map(decorateDoc);
      this.setData({
        docs: sortedDocs,
        filteredDocs: sortedDocs,
        categories: decorateCategories(buildCategories(sortedDocs), "全部"),
        loading: false,
      }, () => this.openPendingEdit());
    });
  },

  openPendingEdit() {
    const intent = editIntent.consumeEditIntent("doc");
    if (!intent) return;
    this.editDoc({ currentTarget: { dataset: { id: intent.id } } });
  },

  switchCategory(e) {
    const category = e.currentTarget.dataset.category;
    const filteredDocs =
      category === "全部" ? this.data.docs : this.data.docs.filter((doc) => doc.category === category);
    this.setData({
      activeCategory: category,
      filteredDocs,
      categories: decorateCategories(buildCategories(this.data.docs), category),
    });
  },

  openDoc(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/doc-detail/index?id=${id}`,
    });
  },

  createDoc() {
    this.setData({
      showCreateSheet: true,
      editingDocId: "",
      docFormKicker: "新增资料",
      docFormTitle: "把重要信息沉淀下来",
      docDraft: emptyDocDraft(),
    });
  },

  editDoc(e) {
    const id = e.currentTarget.dataset.id;
    const doc = this.data.docs.find((item) => item.id === id);
    if (!doc || this.data.actionLoadingType) return;
    if (!doc.canEdit) {
      wx.showToast({ title: doc.editDisabledReason || "当前资料不能编辑", icon: "none" });
      return;
    }
    this.setData({
      showCreateSheet: true,
      editingDocId: id,
      docFormKicker: "编辑资料",
      docFormTitle: "更新这条圈内资料",
      docDraft: docToDraft(doc),
    });
  },

  closeCreateSheet() {
    this.setData({
      showCreateSheet: false,
      editingDocId: "",
    });
  },

  noop() {},

  startAction(type) {
    if (this.data.actionLoadingType) return false;
    this.setData({ actionLoadingType: type, actionLoadingId: "" });
    return true;
  },

  startItemAction(type, id) {
    if (this.data.actionLoadingType) return false;
    this.setData({ actionLoadingType: type, actionLoadingId: id || "" });
    return true;
  },

  finishAction() {
    this.setData({ actionLoadingType: "", actionLoadingId: "" });
  },

  showActionError(error) {
    wx.showToast({
      title: (error && error.message) || "操作失败，请稍后重试",
      icon: "none",
    });
  },

  onDocInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({
      [`docDraft.${field}`]: e.detail.value,
    });
  },

  onCategoryChange(e) {
    this.setData({
      "docDraft.category": CATEGORY_OPTIONS[Number(e.detail.value)],
    });
  },

  submitDoc() {
    const draft = this.data.docDraft;
    if (!draft.title || !draft.summary) {
      wx.showToast({
        title: "补全标题和摘要",
        icon: "none",
      });
      return;
    }

    const body = (draft.bodyText || draft.summary)
      .split(/\n+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const checklist = (draft.checklistText || "保持信息最新\n适合分享回微信群")
      .split(/[\n,，、/]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const related = (draft.relatedText || "新人指南")
      .split(/[\n,，、/]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const doc = {
      id: `local-doc-${Date.now()}`,
      title: draft.title,
      category: draft.category,
      updatedAt: nowDateTime(),
      summary: draft.summary,
      pinned: false,
      readTime: "3 分钟",
      body,
      checklist,
      related,
    };
    const editingId = this.data.editingDocId;
    if (!this.startAction("saveDoc")) return;
    const saveTask = editingId ? api.updateDoc(editingId, doc) : api.createDoc(doc);
    saveTask.then((nextDocs) => {
      const docs = nextDocs.slice().sort((a, b) => Number(b.pinned) - Number(a.pinned)).map(decorateDoc);
      const filteredDocs =
        this.data.activeCategory === "全部"
          ? docs
          : docs.filter((item) => item.category === this.data.activeCategory);
      this.setData({
        docs,
        filteredDocs,
        categories: decorateCategories(buildCategories(docs), this.data.activeCategory),
        showCreateSheet: false,
        editingDocId: "",
        docDraft: emptyDocDraft(),
      });
      wx.showToast({
        title: editingId ? "资料已更新" : "资料已新增",
        icon: "success",
      });
    })
      .catch((error) => {
        this.showActionError(error);
      })
      .then(() => {
        this.finishAction();
      });
  },

  deleteDoc(e) {
    const id = e.currentTarget.dataset.id;
    const doc = this.data.docs.find((item) => item.id === id) || {};
    if (!doc.canDelete) return;
    dialog.show({
      title: "删除资料",
      content: `确认删除「${doc.title || "这条资料"}」吗？`,
      confirmText: "删除",
      confirmColor: "#B34A34",
      success: (res) => {
        if (!res.confirm || !this.startItemAction("deleteDoc", id)) return;
        api
          .deleteDoc(id)
          .then((nextDocs) => {
            const docs = nextDocs.slice().sort((a, b) => Number(b.pinned) - Number(a.pinned)).map(decorateDoc);
            const activeCategory = this.data.activeCategory;
            this.setData({
              docs,
              filteredDocs: activeCategory === "全部" ? docs : docs.filter((item) => item.category === activeCategory),
              categories: decorateCategories(buildCategories(docs), activeCategory),
            });
            wx.showToast({ title: "资料已删除", icon: "success" });
          })
          .catch((error) => {
            this.showActionError(error);
          })
          .then(() => {
            this.finishAction();
          });
      },
    });
  },

  onShareAppMessage() {
    return {
      title: "周末不宅小队资料库：公告、规则和清单都在这",
      path: "/pages/docs/index",
    };
  },
});
