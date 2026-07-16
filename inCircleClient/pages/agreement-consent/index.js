const api = require("../../utils/api");
const auth = require("../../utils/auth");
const invite = require("../../utils/invite");
const legal = require("../../utils/legal");
const theme = require("../../utils/theme");

function withDocumentCheck(document, checked) {
  const baseStatus = document.baseStatus || "";
  return Object.assign({}, document, {
    checked,
    status: checked && baseStatus ? "已确认" : baseStatus,
    statusState: checked && baseStatus ? "confirmed" : (baseStatus ? "attention" : ""),
  });
}

function documentRows(profile, agreements) {
  const changed = Array.isArray(agreements.changedDocuments) ? agreements.changedDocuments : [];
  const updated = agreements.reason === "updated";
  const row = (type, title, version, icon) => {
    const needsConfirmation = !updated || changed.length === 0 || changed.includes(type);
    return withDocumentCheck({
      type,
      title,
      version,
      icon,
      baseStatus: updated ? (needsConfirmation ? "有更新" : "") : "待确认",
    }, !needsConfirmation);
  };
  return [
    row("terms", "用户服务协议", profile.termsVersion, "/images/ui-icons/file-text.svg"),
    row("privacy", "隐私政策", profile.privacyVersion, "/images/ui-icons/fingerprint.svg"),
  ];
}

Page({
  data: {
    loading: true,
    submitting: false,
    leaving: false,
    accepted: false,
    errorMessage: "",
    title: "请补充协议确认",
    copy: "你的账号尚未留存当前协议的确认记录，请阅读后完成确认。",
    profile: null,
    session: null,
    user: null,
    documents: [],
    nextCode: "",
    nextInviteToken: "",
    themeClass: "",
  },

  onLoad(options) {
    theme.applyPageTheme(this);
    const credential = invite.parseInviteOptions(options);
    this.setData({
      nextCode: credential.joinCode,
      nextInviteToken: credential.inviteToken,
    });
    if (!auth.getAccessToken()) {
      this.returnToLogin();
      return;
    }
    this.loadData();
  },

  loadData() {
    if (!auth.getAccessToken()) {
      this.returnToLogin();
      return;
    }
    this.setData({ loading: true, errorMessage: "", accepted: false, documents: [] });
    Promise.all([
      api.getPublicLegalProfile({ force: true }),
      api.getSession({ force: true }),
    ])
      .then(([profileSource, session]) => {
        const profile = legal.normalizePublicLegalProfile(profileSource);
        if (!legal.isPublicLegalProfileComplete(profile)) throw new Error("协议信息尚未配置完整");
        if (!session || !session.loggedIn) {
          this.returnToLogin();
          return;
        }
        if (session.agreementsAccepted) {
          this.goNext(session);
          return;
        }
        const agreements = session.agreements || {};
        const updated = agreements.reason === "updated";
        const documents = documentRows(profile, agreements);
        this.setData({
          loading: false,
          profile,
          session,
          user: session.user || null,
          title: updated ? "协议内容已更新" : "请补充协议确认",
          copy: updated
            ? "用户服务协议或隐私政策已有新版本，请阅读并确认后继续使用。"
            : "你的账号尚未留存当前协议的确认记录，请阅读后完成确认。",
          documents,
          accepted: documents.length > 0 && documents.every((item) => item.checked),
        });
      })
      .catch((error) => {
        if (error && ["TOKEN_INVALID", "TOKEN_EXPIRED", "TOKEN_REVOKED", "LOGIN_REQUIRED"].includes(error.errCode)) {
          auth.clearAccessToken();
          this.returnToLogin();
          return;
        }
        this.setData({
          loading: false,
          errorMessage: (error && error.message) || "协议状态读取失败，请稍后重试",
        });
      });
  },

  toggleAccepted() {
    if (this.data.submitting || this.data.leaving) return;
    const accepted = !this.data.accepted;
    this.setData({
      accepted,
      documents: (this.data.documents || []).map((item) => withDocumentCheck(item, accepted)),
    });
  },

  toggleDocument(e) {
    if (this.data.submitting || this.data.leaving) return;
    const type = e.currentTarget.dataset.type;
    const documents = (this.data.documents || []).map((item) => (
      item.type === type ? withDocumentCheck(item, !item.checked) : item
    ));
    this.setData({
      documents,
      accepted: documents.length > 0 && documents.every((item) => item.checked),
    });
  },

  openLegal(e) {
    const type = e.currentTarget.dataset.type === "privacy" ? "privacy" : "terms";
    wx.navigateTo({ url: `/pages/legal/index?type=${type}` });
  },

  submitAcceptance() {
    if (!this.data.accepted || this.data.submitting || !this.data.profile) return;
    this.setData({ submitting: true, errorMessage: "" });
    api.acceptAgreements(legal.acceptancePayload(true, this.data.profile))
      .then((session) => this.goNext(session || this.data.session))
      .catch((error) => {
        if (error && error.errCode === "AGREEMENT_ACCEPTANCE_REQUIRED") {
          this.loadData();
          return;
        }
        this.setData({ errorMessage: (error && error.message) || "协议确认失败，请重试" });
      })
      .finally(() => this.setData({ submitting: false }));
  },

  declineAndLogout() {
    if (this.data.submitting || this.data.leaving) return;
    this.setData({ leaving: true, errorMessage: "" });
    api.logout()
      .catch(() => null)
      .finally(() => {
        auth.clearAccessToken();
        this.returnToLogin();
      });
  },

  retryLoad() {
    this.loadData();
  },

  returnToLogin() {
    const query = invite.inviteQuery(this.data.nextCode, this.data.nextInviteToken);
    wx.reLaunch({ url: `/pages/login/index${query}` });
  },

  goNext(session) {
    if (this.data.nextInviteToken) {
      wx.reLaunch({
        url: `/pages/circle-join/index${invite.inviteQuery("", this.data.nextInviteToken)}`,
      });
      return;
    }
    if (this.data.nextCode) {
      wx.reLaunch({
        url: `/pages/circle-join/index${invite.inviteQuery(this.data.nextCode, "")}`,
      });
      return;
    }
    if (session && session.loggedIn && session.hasCircle && session.currentCircle) {
      wx.switchTab({ url: "/pages/index/index" });
      return;
    }
    wx.reLaunch({ url: "/pages/circle-switch/index" });
  },
});
