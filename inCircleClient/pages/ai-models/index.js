const api = require("../../utils/api");
const dialog = require("../../utils/dialog");
const time = require("../../utils/time");

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch (error) {
    return "";
  }
}

function decorateModel(model) {
  const source = model || {};
  const latency = Number(source.lastTestLatencyMs || 0);
  const status = source.lastTestStatus || "";
  return Object.assign({}, source, {
    testStatusText: status === "success"
      ? `测试通过${latency ? ` · ${latency} ms` : ""}`
      : status === "failed"
        ? "测试失败"
        : "尚未测试",
    testTimeText: source.lastTestedAt ? time.formatDateMinute(source.lastTestedAt) : "",
  });
}

function derivedState(providers, allModels, preferredProviderId, fallbackIndex) {
  let providerIndex = providers.findIndex((item) => item.id === preferredProviderId);
  if (providerIndex < 0) providerIndex = Math.min(Number(fallbackIndex || 0), Math.max(0, providers.length - 1));
  const selectedProvider = providers[providerIndex] || null;
  const visibleModels = selectedProvider
    ? allModels.filter((model) => model.providerId === selectedProvider.id)
    : [];
  return {
    providerIndex,
    selectedProvider,
    providerNames: providers.map((provider) => `${provider.name}${provider.enabled ? "" : " · 已停用"}`),
    visibleModels,
    defaultModel: allModels.find((model) => model.isDefault) || null,
    selectedDefaultModel: visibleModels.find((model) => model.isDefault) || null,
  };
}

Page({
  data: {
    loading: true,
    loadError: "",
    circleId: "",
    requestedProviderId: "",
    setupMode: false,
    suggestedModelId: "",
    providers: [],
    providerNames: [],
    providerIndex: 0,
    selectedProvider: null,
    allModels: [],
    visibleModels: [],
    defaultModel: null,
    selectedDefaultModel: null,
    syncBusy: false,
    modelBusyId: "",
    testingModelId: "",
    addOpen: false,
    addBusy: false,
    setupMessage: "",
    draft: { modelId: "", displayName: "" },
  },

  onLoad(options) {
    if (typeof wx.hideShareMenu === "function") wx.hideShareMenu();
    this.setData({
      circleId: (options && options.circleId) || "",
      requestedProviderId: (options && options.providerId) || "",
      setupMode: !!(options && options.setup === "1"),
      suggestedModelId: safeDecode((options && options.suggestedModelId) || ""),
    });
  },

  onShow() {
    this.loadData();
  },

  applyData(providers, allModels, options) {
    const decoratedModels = (Array.isArray(allModels) ? allModels : []).map(decorateModel);
    const derived = derivedState(
      providers,
      decoratedModels,
      (options && options.providerId) || (this.data.selectedProvider && this.data.selectedProvider.id) || this.data.requestedProviderId,
      this.data.providerIndex
    );
    const suggested = String(this.data.suggestedModelId || "").trim();
    const hasSuggested = suggested && derived.visibleModels.some((model) => model.modelId === suggested);
    let setupMessage = "";
    if (this.data.setupMode && derived.selectedProvider) {
      setupMessage = derived.selectedDefaultModel
        ? "当前供应商和默认模型已就绪"
        : derived.visibleModels.length
          ? derived.defaultModel
            ? "模型已同步，可按需切换默认模型"
            : "模型已就绪，请选择一个默认模型"
          : "连接已保存，请同步或手动添加模型";
    }
    this.setData(Object.assign({
      providers,
      allModels: decoratedModels,
      setupMessage,
      loading: false,
      loadError: "",
    }, derived, suggested && !hasSuggested && derived.selectedProvider ? {
      addOpen: true,
      draft: { modelId: suggested, displayName: suggested },
    } : {}));
  },

  loadData() {
    this.setData({ loading: true, loadError: "" });
    Promise.all([api.listAiProviders(this.data.circleId), api.listAiModels(this.data.circleId)])
      .then(([providerData, modelData]) => {
        const providers = (providerData.providers || []).map((provider) => Object.assign({}, provider, {
          shortName: String(provider.name || "AI").trim().slice(0, 2) || "AI",
          supportsModelSync: typeof provider.supportsModelSync === "boolean"
            ? provider.supportsModelSync
            : provider.protocol !== "azure",
        }));
        this.applyData(providers, modelData.models || [], { providerId: this.data.requestedProviderId });
      })
      .catch((error) => {
        this.setData({ loading: false, loadError: error.message || "读取模型失败" });
      });
  },

  onProviderChange(e) {
    if (this.data.testingModelId || this.data.modelBusyId) return;
    const providerIndex = Number(e.detail.value || 0);
    const provider = this.data.providers[providerIndex] || null;
    const derived = derivedState(this.data.providers, this.data.allModels, provider && provider.id, providerIndex);
    this.setData(Object.assign({}, derived, {
      requestedProviderId: (provider && provider.id) || "",
      addOpen: false,
      setupMessage: "",
      draft: { modelId: "", displayName: "" },
    }));
  },

  addProvider() {
    wx.navigateTo({ url: `/pages/ai-provider/index?circleId=${this.data.circleId}&returnToModels=1` });
  },

  editProvider() {
    const provider = this.data.selectedProvider;
    if (!provider || this.data.testingModelId || this.data.modelBusyId) return;
    wx.navigateTo({ url: `/pages/ai-provider/index?circleId=${this.data.circleId}&providerId=${provider.id}` });
  },

  syncModels() {
    const provider = this.data.selectedProvider;
    if (!provider || this.data.syncBusy || this.data.testingModelId || this.data.modelBusyId || !provider.enabled) return;
    if (!provider.supportsModelSync) {
      this.setData({ addOpen: true, setupMessage: "该供应商使用部署名称，请手动添加模型" });
      return;
    }
    this.setData({ syncBusy: true, setupMessage: "正在从供应商读取模型..." });
    api
      .syncAiModels(this.data.circleId, provider.id)
      .then((data) => {
        const allModels = data.models || [];
        this.applyData(this.data.providers, allModels, { providerId: provider.id });
        const count = allModels.filter((model) => model.providerId === provider.id).length;
        this.setData({ setupMessage: count ? `已同步 ${count} 个模型` : "连接正常，但供应商没有返回模型" });
      })
      .catch((error) => this.setData({ setupMessage: error.message || "同步失败，可改为手动添加" }))
      .finally(() => this.setData({ syncBusy: false }));
  },

  toggleAdd() {
    if (!this.data.selectedProvider || this.data.testingModelId || this.data.modelBusyId || !this.data.selectedProvider.enabled) return;
    this.setData({ addOpen: !this.data.addOpen });
  },

  onDraftInput(e) {
    this.setData({ [`draft.${e.currentTarget.dataset.field}`]: e.detail.value });
  },

  addModel() {
    const provider = this.data.selectedProvider;
    const modelId = String(this.data.draft.modelId || "").trim();
    if (!provider || this.data.addBusy || this.data.testingModelId || this.data.modelBusyId || !provider.enabled) return;
    if (!modelId) {
      wx.showToast({ title: "请填写模型 ID", icon: "none" });
      return;
    }
    this.setData({ addBusy: true });
    api
      .saveAiModel(this.data.circleId, {
        providerId: provider.id,
        modelId,
        displayName: String(this.data.draft.displayName || "").trim(),
        enabled: true,
      })
      .then((data) => {
        this.applyData(this.data.providers, data.models || [], { providerId: provider.id });
        this.setData({ draft: { modelId: "", displayName: "" }, addOpen: false, setupMessage: "模型已添加，请按需设为默认" });
      })
      .catch((error) => wx.showToast({ title: error.message || "添加失败", icon: "none" }))
      .finally(() => this.setData({ addBusy: false }));
  },

  updateModelState(id, patch) {
    if (!id || this.data.modelBusyId || this.data.testingModelId) return Promise.resolve();
    const providerId = this.data.selectedProvider && this.data.selectedProvider.id;
    this.setData({ modelBusyId: id });
    return api
      .updateAiModel(this.data.circleId, id, patch)
      .then((data) => {
        this.applyData(this.data.providers, data.models || [], { providerId });
        return true;
      })
      .catch((error) => {
        wx.showToast({ title: error.message || "操作失败", icon: "none" });
        return false;
      })
      .finally(() => this.setData({ modelBusyId: "" }));
  },

  onModelEnabledChange(e) {
    const id = e.currentTarget.dataset.id;
    const defaultValue = e.currentTarget.dataset.default;
    const isDefault = defaultValue === true || defaultValue === "true";
    const enabled = !!e.detail.value;
    if (!enabled && isDefault) {
      dialog.show({
        title: "停用默认模型",
        content: "停用后会清空默认模型。AI 开关会保留，重新选择默认模型后成员即可继续对话。",
        confirmText: "继续停用",
        success: (result) => {
          if (result.confirm) this.updateModelState(id, { enabled: false });
          else this.loadData();
        },
      });
      return;
    }
    this.updateModelState(id, { enabled });
  },

  testModel(e) {
    const id = e.currentTarget.dataset.id;
    const model = this.data.allModels.find((item) => item.id === id);
    if (!model || this.data.testingModelId || this.data.modelBusyId || !this.data.selectedProvider || !this.data.selectedProvider.enabled) return;
    this.setData({ testingModelId: id });
    api
      .testAiModel(this.data.circleId, id)
      .then((result) => {
        const nextModels = this.data.allModels.map((item) => item.id === id
          ? Object.assign({}, item, {
            lastTestStatus: "success",
            lastTestErrorCode: "",
            lastTestLatencyMs: Number(result.latencyMs || 0),
            lastTestedAt: result.testedAt || new Date().toISOString(),
          })
          : item);
        this.applyData(this.data.providers, nextModels, { providerId: model.providerId });
        wx.showToast({ title: "模型测试通过", icon: "success" });
      })
      .catch((error) => {
        const nextModels = this.data.allModels.map((item) => item.id === id
          ? Object.assign({}, item, {
            lastTestStatus: "failed",
            lastTestErrorCode: error.errCode || "AI_MODEL_TEST_FAILED",
            lastTestLatencyMs: 0,
            lastTestedAt: new Date().toISOString(),
          })
          : item);
        this.applyData(this.data.providers, nextModels, { providerId: model.providerId });
        wx.showToast({ title: error.message || "模型测试失败", icon: "none" });
      })
      .finally(() => this.setData({ testingModelId: "" }));
  },

  setDefault(e) {
    const id = e.currentTarget.dataset.id;
    const enabled = e.currentTarget.dataset.enabled;
    const isDefault = e.currentTarget.dataset.default;
    const model = this.data.allModels.find((item) => item.id === id);
    if (!id || !model || this.data.modelBusyId || this.data.testingModelId || !this.data.selectedProvider || !this.data.selectedProvider.enabled) return;
    if (enabled === false || enabled === "false" || isDefault === true || isDefault === "true") return;
    if (model.lastTestStatus !== "success") {
      wx.showToast({ title: "请先测试这个模型", icon: "none" });
      return;
    }
    this.updateModelState(id, { isDefault: true }).then((updated) => {
      if (updated) this.setData({ setupMessage: "默认模型已更新" });
    });
  },

  archiveModel(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this.data.modelBusyId || this.data.testingModelId) return;
    dialog.show({
      title: "归档模型",
      content: "归档后不再向成员展示，历史对话中的模型名称仍会保留。",
      confirmText: "归档",
      success: (result) => {
        if (result.confirm) this.updateModelState(id, { archived: true, enabled: false });
      },
    });
  },

  retryLoad() {
    this.loadData();
  },
});
