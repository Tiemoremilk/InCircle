const api = require("../../utils/api");
const time = require("../../utils/time");
const dialog = require("../../utils/dialog");

function promptText(value) {
  return (Array.isArray(value) ? value : []).join("\n");
}

Page({
  data: {
    loading: true,
    loadError: "",
    circleId: "",
    settings: null,
    providers: [],
    models: [],
    usageDays: [],
    reports: [],
    saveBusy: false,
    deletingProviderId: "",
    reportBusyId: "",
    draft: {
      assistantName: "圈内 AI",
      systemPrompt: "",
      quickPromptsText: "",
      memberDailyLimit: 20,
      circleDailyLimit: 200,
      maxOutputTokens: 8192,
    },
  },

  onLoad(options) {
    if (typeof wx.hideShareMenu === "function") wx.hideShareMenu();
    this.setData({ circleId: (options && options.circleId) || "" });
  },

  onShow() {
    this.loadData();
  },

  loadData() {
    if (!this.data.circleId) return;
    this.setData({ loading: true, loadError: "" });
    Promise.all([
      api.getAiSettings(this.data.circleId),
      api.listAiProviders(this.data.circleId),
      api.listAiModels(this.data.circleId),
      api.getAiUsage(this.data.circleId),
    ])
      .then(([settings, providerData, modelData, usage]) => {
        this.setData({
          settings,
          providers: (providerData.providers || []).map((provider) =>
            Object.assign({}, provider, { shortName: String(provider.name || "AI").slice(0, 1) })
          ),
          models: modelData.models || [],
          usageDays: usage.days || [],
          draft: {
            assistantName: settings.assistantName || "圈内 AI",
            systemPrompt: settings.systemPrompt || "",
            quickPromptsText: promptText(settings.quickPrompts),
            memberDailyLimit: settings.memberDailyLimit || 20,
            circleDailyLimit: settings.circleDailyLimit || 200,
            maxOutputTokens: settings.maxOutputTokens || 8192,
          },
          loading: false,
        });
        if (settings.isSuperAdmin) {
          api
            .listAiReports(this.data.circleId)
            .then((reportData) => this.setData({
              reports: (reportData.reports || []).map((report) =>
                Object.assign({}, report, {
                  createdAtText: time.formatDateTime(report.created_at || report.createdAt),
                })
              ),
            }))
            .catch(() => {});
        }
      })
      .catch((error) => {
        this.setData({ loading: false, loadError: error.message || "读取 AI 配置失败" });
        wx.showToast({ title: error.message || "读取 AI 配置失败", icon: "none" });
      });
  },

  onDraftInput(e) {
    this.setData({ [`draft.${e.currentTarget.dataset.field}`]: e.detail.value });
  },

  saveSettings() {
    if (this.data.saveBusy) return;
    const draft = this.data.draft;
    const quickPrompts = String(draft.quickPromptsText || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    this.setData({ saveBusy: true });
    api
      .updateAiSettings(this.data.circleId, {
        assistantName: draft.assistantName,
        systemPrompt: draft.systemPrompt,
        quickPrompts,
        memberDailyLimit: Number(draft.memberDailyLimit),
        circleDailyLimit: Number(draft.circleDailyLimit),
        maxOutputTokens: Number(draft.maxOutputTokens),
      })
      .then((settings) => {
        this.setData({ settings });
        wx.showToast({ title: "AI 设置已保存", icon: "success" });
      })
      .catch((error) => wx.showToast({ title: error.message || "保存失败", icon: "none" }))
      .finally(() => this.setData({ saveBusy: false }));
  },

  openNewProvider() {
    wx.navigateTo({ url: `/pages/ai-provider/index?circleId=${this.data.circleId}` });
  },

  editProvider(e) {
    wx.navigateTo({
      url: `/pages/ai-provider/index?circleId=${this.data.circleId}&providerId=${e.currentTarget.dataset.id}`,
    });
  },

  openModels() {
    wx.navigateTo({ url: `/pages/ai-models/index?circleId=${this.data.circleId}` });
  },

  archiveProvider(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name || "这个供应商";
    if (!id || this.data.deletingProviderId) return;
    dialog.show({
      title: "停用供应商",
      content: `停用「${name}」后，其模型不再可选，历史对话仍会保留。`,
      confirmText: "停用",
      success: (result) => {
        if (!result.confirm) return;
        this.setData({ deletingProviderId: id });
        api
          .archiveAiProvider(this.data.circleId, id)
          .then(() => {
            wx.showToast({ title: "已停用", icon: "success" });
            this.loadData();
          })
          .catch((error) => wx.showToast({ title: error.message || "停用失败", icon: "none" }))
          .finally(() => this.setData({ deletingProviderId: "" }));
      },
    });
  },

  reviewReport(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this.data.reportBusyId) return;
    this.setData({ reportBusyId: id });
    api
      .updateAiReport(this.data.circleId, id, { status: "reviewed" })
      .then((data) => this.setData({ reports: (data.reports || []).map((report) => Object.assign({}, report, {
        createdAtText: time.formatDateTime(report.created_at || report.createdAt),
      })) }))
      .catch((error) => wx.showToast({ title: error.message || "操作失败", icon: "none" }))
      .finally(() => this.setData({ reportBusyId: "" }));
  },

  deleteReport(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this.data.reportBusyId) return;
    dialog.show({
      title: "删除举报记录",
      content: "确认物理删除这条举报及其内容摘录？",
      confirmText: "删除",
      success: (result) => {
        if (!result.confirm) return;
        this.setData({ reportBusyId: id });
        api
          .updateAiReport(this.data.circleId, id, { delete: true })
          .then((data) => this.setData({ reports: (data.reports || []).map((report) => Object.assign({}, report, {
            createdAtText: time.formatDateTime(report.created_at || report.createdAt),
          })) }))
          .catch((error) => wx.showToast({ title: error.message || "删除失败", icon: "none" }))
          .finally(() => this.setData({ reportBusyId: "" }));
      },
    });
  },
});
