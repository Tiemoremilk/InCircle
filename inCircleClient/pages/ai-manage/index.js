const api = require("../../utils/api");
const time = require("../../utils/time");
const dialog = require("../../utils/dialog");

const OUTPUT_TOKEN_PRESETS = [4096, 8192, 16384, 32768];

function promptText(value) {
  return (Array.isArray(value) ? value : []).join("\n");
}

function compactTokenCount(value) {
  const count = Number(value || 0);
  if (count >= 1000000) return `${Number((count / 1000000).toFixed(2))}M`;
  if (count >= 1000) return `${Number((count / 1000).toFixed(1))}K`;
  return String(count || 0);
}

function outputCapabilityHint(model) {
  if (!model) return "选择默认模型后，将自动匹配实际输出上限";
  const limit = Number(model.maxOutputTokens || 0);
  if (!limit) return "模型输出能力待识别，高额度不兼容时会在输出前安全回退至 8K";
  const source = ({
    manual: "手动设置",
    catalog: "能力库匹配",
    probe: "兼容探测",
    compatibility: "兼容探测",
    sync: "供应商识别",
  })[model.maxOutputTokensSource] || "供应商识别";
  return `默认模型上限 ${compactTokenCount(limit)} · ${source}`;
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
    outputTokenPresets: OUTPUT_TOKEN_PRESETS,
    outputLimitMode: "preset",
    lastOutputPreset: 8192,
    outputCapabilityHint: "",
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
        const maxOutputTokens = Number(settings.maxOutputTokens || 8192);
        const usesPreset = OUTPUT_TOKEN_PRESETS.includes(maxOutputTokens);
        this.setData({
          settings,
          providers: (providerData.providers || []).map((provider) =>
            Object.assign({}, provider, { shortName: String(provider.name || "AI").slice(0, 1) })
          ),
          models: modelData.models || [],
          usageDays: usage.days || [],
          outputLimitMode: usesPreset ? "preset" : "custom",
          lastOutputPreset: usesPreset ? maxOutputTokens : 8192,
          outputCapabilityHint: outputCapabilityHint(settings.defaultModel),
          draft: {
            assistantName: settings.assistantName || "圈内 AI",
            systemPrompt: settings.systemPrompt || "",
            quickPromptsText: promptText(settings.quickPrompts),
            memberDailyLimit: settings.memberDailyLimit || 20,
            circleDailyLimit: settings.circleDailyLimit || 200,
            maxOutputTokens,
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
    const field = e.currentTarget.dataset.field;
    const patch = { [`draft.${field}`]: e.detail.value };
    if (field === "maxOutputTokens") patch.outputLimitMode = "custom";
    this.setData(patch);
  },

  selectOutputMode(e) {
    if (this.data.saveBusy) return;
    const mode = e.currentTarget.dataset.mode;
    if (mode !== "preset" && mode !== "custom") return;
    if (mode === "preset") {
      const current = Number(this.data.draft.maxOutputTokens || 0);
      const value = OUTPUT_TOKEN_PRESETS.includes(current)
        ? current
        : Number(this.data.lastOutputPreset || 8192);
      this.setData({ outputLimitMode: mode, "draft.maxOutputTokens": value });
      return;
    }
    this.setData({ outputLimitMode: mode });
  },

  selectOutputLimit(e) {
    if (this.data.saveBusy) return;
    const value = Number(e.currentTarget.dataset.value || 0);
    if (OUTPUT_TOKEN_PRESETS.includes(value)) {
      this.setData({
        outputLimitMode: "preset",
        lastOutputPreset: value,
        "draft.maxOutputTokens": value,
      });
    }
  },

  saveSettings() {
    if (this.data.saveBusy) return;
    const draft = this.data.draft;
    const quickPrompts = String(draft.quickPromptsText || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    const maxOutputTokens = Number(draft.maxOutputTokens);
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > 32768) {
      wx.showToast({ title: "输出额度应为 128–32768", icon: "none" });
      return;
    }
    this.setData({ saveBusy: true });
    api
      .updateAiSettings(this.data.circleId, {
        assistantName: draft.assistantName,
        systemPrompt: draft.systemPrompt,
        quickPrompts,
        memberDailyLimit: Number(draft.memberDailyLimit),
        circleDailyLimit: Number(draft.circleDailyLimit),
        maxOutputTokens,
      })
      .then((settings) => {
        this.setData({
          settings,
          "draft.maxOutputTokens": settings.maxOutputTokens || maxOutputTokens,
          outputCapabilityHint: outputCapabilityHint(settings.defaultModel),
        });
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
