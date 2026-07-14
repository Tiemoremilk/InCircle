const api = require("../../utils/api");
const dialog = require("../../utils/dialog");

const PROTOCOLS = [
  { key: "openai", name: "OpenAI Compatible" },
  { key: "anthropic", name: "Anthropic Messages" },
  { key: "gemini", name: "Google Gemini" },
  { key: "azure", name: "Azure OpenAI" },
];

function providerDraft(existing, preset) {
  const source = existing || {};
  const selected = preset || {};
  return {
    presetKey: source.presetKey || selected.key || "openai",
    protocol: source.protocol || selected.protocol || "openai",
    name: source.name || selected.name || "模型供应商",
    baseUrl: source.baseUrl || selected.baseUrl || "",
    privacyUrl: source.privacyUrl || selected.privacyUrl || "",
    apiVersion: source.apiVersion || "2024-10-21",
    azureDeployment: source.azureDeployment || "",
    apiKey: "",
    enabled: existing ? !!existing.enabled : true,
  };
}

function validationMessage(data) {
  const draft = data.draft || {};
  if (!draft.presetKey) return "请选择供应商";
  if (!String(draft.name || "").trim()) return "请填写显示名称";
  if (!data.existingMask && !String(draft.apiKey || "").trim()) return "请填写 API Key";
  if (data.requiresBaseUrl && !/^https:\/\//i.test(String(draft.baseUrl || "").trim())) {
    return "请填写以 https:// 开头的服务地址";
  }
  if (data.isAzure && !String(draft.azureDeployment || "").trim()) return "请填写 Azure 部署名称";
  if (!/^https:\/\//i.test(String(draft.privacyUrl || "").trim())) return "请填写有效的隐私政策地址";
  return "";
}

Page({
  data: {
    loading: true,
    loadError: "",
    circleId: "",
    providerId: "",
    returnToModels: false,
    isEditing: false,
    providers: [],
    presets: [],
    selectedPreset: null,
    protocols: PROTOCOLS,
    protocolNames: PROTOCOLS.map((item) => item.name),
    protocolIndex: 0,
    requiresBaseUrl: false,
    isCustom: false,
    isAzure: false,
    advancedOpen: false,
    saveBusy: false,
    existingMask: "",
    operationStatus: "",
    operationMessage: "",
    draft: providerDraft(null, null),
  },

  onLoad(options) {
    if (typeof wx.hideShareMenu === "function") wx.hideShareMenu();
    this.setData({
      circleId: (options && options.circleId) || "",
      providerId: (options && options.providerId) || "",
      returnToModels: !!(options && options.returnToModels === "1"),
    });
    this.loadData();
  },

  loadData() {
    this.setData({ loading: true, loadError: "" });
    api
      .listAiProviders(this.data.circleId)
      .then((data) => {
        const providers = data.providers || [];
        const existing = providers.find((item) => item.id === this.data.providerId) || null;
        const basePresets = data.presets || [];
        const presets = basePresets.map((preset) => {
          const configured = preset.key === "custom"
            ? null
            : providers.find((provider) => provider.presetKey === preset.key && !provider.archived);
          return Object.assign({}, preset, {
            configured: !!configured,
            existingProviderId: (configured && configured.id) || "",
          });
        });
        const firstAvailable = presets.find((preset) => !preset.configured) || presets[0] || {};
        const selectedPreset = presets.find((preset) => preset.key === ((existing && existing.presetKey) || firstAvailable.key)) || firstAvailable;
        const draft = providerDraft(existing, selectedPreset);
        const protocolIndex = Math.max(0, PROTOCOLS.findIndex((item) => item.key === draft.protocol));
        const isCustom = selectedPreset.key === "custom";
        const isAzure = draft.protocol === "azure";
        this.setData({
          providers,
          presets: presets.map((preset) => Object.assign({}, preset, { selected: preset.key === selectedPreset.key })),
          selectedPreset,
          isEditing: !!existing,
          protocolIndex,
          requiresBaseUrl: !!selectedPreset.requiresBaseUrl,
          isCustom,
          isAzure,
          advancedOpen: isCustom || isAzure,
          existingMask: (existing && existing.credentialMask) || "",
          draft,
          loading: false,
        });
      })
      .catch((error) => {
        this.setData({ loading: false, loadError: error.message || "读取供应商配置失败" });
      });
  },

  selectPreset(e) {
    if (this.data.isEditing || this.data.saveBusy) return;
    const key = e.currentTarget.dataset.key;
    const preset = this.data.presets.find((item) => item.key === key);
    if (!preset) return;
    if (preset.configured && preset.existingProviderId) {
      dialog.show({
        title: "供应商已接入",
        content: `当前圈子已经配置了 ${preset.name}，可以直接编辑现有连接。`,
        confirmText: "编辑配置",
        success: (result) => {
          if (!result.confirm) return;
          this.setData({ providerId: preset.existingProviderId });
          this.loadData();
        },
      });
      return;
    }
    const protocolIndex = Math.max(0, PROTOCOLS.findIndex((item) => item.key === preset.protocol));
    this.setData({
      presets: this.data.presets.map((item) => Object.assign({}, item, { selected: item.key === preset.key })),
      selectedPreset: preset,
      protocolIndex,
      requiresBaseUrl: !!preset.requiresBaseUrl,
      isCustom: preset.key === "custom",
      isAzure: preset.protocol === "azure",
      advancedOpen: preset.key === "custom" || preset.protocol === "azure",
      existingMask: "",
      operationStatus: "",
      operationMessage: "",
      draft: providerDraft(null, preset),
    });
  },

  onProtocolChange(e) {
    if (!this.data.isCustom) return;
    const index = Number(e.detail.value || 0);
    const protocol = PROTOCOLS[index] || PROTOCOLS[0];
    this.setData({
      protocolIndex: index,
      isAzure: protocol.key === "azure",
      "draft.protocol": protocol.key,
      operationStatus: "",
      operationMessage: "",
    });
  },

  onInput(e) {
    this.setData({
      [`draft.${e.currentTarget.dataset.field}`]: e.detail.value,
      operationStatus: "",
      operationMessage: "",
    });
  },

  onEnabledChange(e) {
    this.setData({ "draft.enabled": !!e.detail.value });
  },

  toggleAdvanced() {
    this.setData({ advancedOpen: !this.data.advancedOpen });
  },

  submit() {
    if (this.data.saveBusy) return;
    const errorText = validationMessage(this.data);
    if (errorText) {
      wx.showToast({ title: errorText, icon: "none" });
      return;
    }
    const wasNew = !this.data.providerId;
    this.setData({
      saveBusy: true,
      operationStatus: "working",
      operationMessage: "正在保存供应商配置...",
    });
    api
      .saveAiProvider(this.data.circleId, this.data.providerId, this.data.draft)
      .then((result) => {
        const provider = result.provider;
        this.setData({
          providerId: provider.id,
          isEditing: true,
          existingMask: provider.credentialMask,
          "draft.apiKey": "",
          operationStatus: "success",
          operationMessage: "连接配置已保存，请在模型管理中选择具体模型测试",
        });
        if (wasNew) {
          if (this.data.returnToModels) {
            setTimeout(() => wx.navigateBack(), 450);
            return;
          }
          const suggested = provider.protocol === "azure" ? String(this.data.draft.azureDeployment || "") : "";
          const url = `/pages/ai-models/index?circleId=${this.data.circleId}&providerId=${provider.id}&setup=1${suggested ? `&suggestedModelId=${encodeURIComponent(suggested)}` : ""}`;
          setTimeout(() => wx.redirectTo({ url }), 450);
          return;
        }
        setTimeout(() => wx.navigateBack(), 450);
      })
      .catch((error) => {
        if (error.errCode === "AI_PROVIDER_ALREADY_EXISTS" && error.details && error.details.providerId) {
          this.setData({ providerId: error.details.providerId, saveBusy: false });
          wx.showToast({ title: "已切换到现有配置", icon: "none" });
          this.loadData();
          return;
        }
        this.setData({
          operationStatus: "error",
          operationMessage: error.message || "保存失败，请稍后再试",
        });
      })
      .finally(() => this.setData({ saveBusy: false }));
  },

  saveProvider() {
    this.submit();
  },

  retryLoad() {
    this.loadData();
  },
});
