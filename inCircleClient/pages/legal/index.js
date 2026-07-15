const api = require("../../utils/api");
const legal = require("../../utils/legal");

Page({
  data: {
    document: null,
    contactEmail: "",
    documentType: "terms",
    legalLoading: true,
    legalError: "",
  },

  onLoad(options) {
    const documentType = options && options.type === "privacy" ? "privacy" : "terms";
    const document = legal.getDocument(documentType);
    this.setData({ documentType });
    wx.setNavigationBarTitle({ title: document.shortTitle });
    this.loadPublicLegalProfile();
  },

  loadPublicLegalProfile(options) {
    if (this.data.legalLoading && this.data.document) return;
    this.setData({ legalLoading: true, legalError: "" });
    api.getPublicLegalProfile({ force: !!(options && options.force) })
      .then((profile) => {
        const normalized = legal.normalizePublicLegalProfile(profile);
        if (!legal.isPublicLegalProfileComplete(normalized)) {
          throw new Error("协议公开信息尚未配置");
        }
        this.setData({
          document: legal.getDocument(this.data.documentType, normalized),
          contactEmail: normalized.contactEmail,
          legalLoading: false,
          legalError: "",
        });
      })
      .catch((error) => {
        this.setData({
          document: null,
          contactEmail: "",
          legalLoading: false,
          legalError: (error && error.message) || "协议信息加载失败，请稍后重试",
        });
      });
  },

  retryLegalProfile() {
    this.loadPublicLegalProfile({ force: true });
  },

  copyContactEmail() {
    if (!this.data.contactEmail) return;
    wx.setClipboardData({ data: this.data.contactEmail });
  },
});
