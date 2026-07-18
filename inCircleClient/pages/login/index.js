const api = require("../../utils/api");
const theme = require("../../utils/theme");
const avatar = require("../../utils/avatar");
const dialog = require("../../utils/dialog");
const invite = require("../../utils/invite");
const legal = require("../../utils/legal");
const auth = require("../../utils/auth");
const loginLocation = require("../../utils/login-location");

function normalizePhone(value) {
  return String(value || "").replace(/[^\d]/g, "").slice(0, 11);
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeAccount(value) {
  return String(value || "").trim().replace(/\s/g, "");
}

function modeMeta(mode) {
  if (mode === "register") {
    return {
      title: "创建 InCircle 账号",
      copy: "先设置账号安全信息，再完成你的圈内资料。",
      button: "注册并登录",
      hero: "一个账号绑定一个微信身份，让你的圈子和成员资料始终属于你。",
      icon: "/images/ui-icons/user-plus.svg",
    };
  }
  if (mode === "bind") {
    return {
      title: "完善账号安全",
      copy: "为当前微信设置账号密码，原有圈子和成员资料不会改变。",
      button: "绑定并登录",
      hero: "完成安全升级后，你可以继续使用原来的圈子和成员身份。",
      icon: "/images/ui-icons/shield-check.svg",
    };
  }
  if (mode === "forgot") {
    return {
      title: "重置登录密码",
      copy: "使用当前绑定微信校验身份，不发送短信验证码。",
      button: "确认重置密码",
      hero: "忘记密码时，不发短信；用当前绑定微信校验身份后重置。",
      icon: "/images/ui-icons/key-round.svg",
    };
  }
  return {
    title: "欢迎回来",
    copy: "登录你的账号，回到熟悉的圈子。",
    button: "登录",
    hero: "先用账号密码确认身份，再用当前微信确认这是本人。",
    icon: "/images/ui-icons/log-in.svg",
  };
}

Page({
  data: {
    loading: true,
    submitting: false,
    loginDisabled: false,
    avatarUploading: false,
    mode: "login",
    modeTitle: "账号密码登录",
    modeCopy: "",
    modeIcon: "/images/ui-icons/log-in.svg",
    heroCopy: "",
    primaryButtonText: "登录",
    account: "",
    password: "",
    confirmPassword: "",
    nickName: "",
    wechatNickName: "",
    phone: "",
    title: "",
    profileNote: "",
    displayName: "微信用户",
    avatarUrl: "/images/avatar.png",
    avatarUrlDisplay: "/images/avatar.png",
    setupError: "",
    nextCode: "",
    user: null,
    backendError: "",
    hasBackendError: false,
    feedbackText: "",
    feedbackType: "",
    themePreferenceExplicit: false,
    themeClass: "",
    nextInviteToken: "",
    registerStep: 1,
    passwordVisible: false,
    confirmPasswordVisible: false,
    agreementAccepted: false,
    agreementAttention: false,
    legalProfile: null,
    legalProfileReady: false,
  },

  onLoad(options) {
    theme.applyPageTheme(this);
    const meta = modeMeta("login");
    const credential = invite.parseInviteOptions(options);
    this.setData({
      nextCode: credential.joinCode,
      nextInviteToken: credential.inviteToken,
      modeCopy: meta.copy,
      modeIcon: meta.icon,
      heroCopy: meta.hero,
    });
    this.loadLegalProfile();
  },

  loadLegalProfile(options) {
    this.setData({
      loading: true,
      loginDisabled: true,
      backendError: "",
      hasBackendError: false,
      legalProfileReady: false,
    });
    return api.getPublicLegalProfile({ force: !!(options && options.force) })
      .then((profile) => {
        const normalized = legal.normalizePublicLegalProfile(profile);
        if (!legal.isPublicLegalProfileComplete(normalized)) {
          throw new Error("协议公开信息尚未配置");
        }
        this.setData({
          legalProfile: normalized,
          legalProfileReady: true,
          agreementAccepted: false,
          loginDisabled: false,
        });
        if (auth.getAccessToken()) return this.loadSession();
        this.setAuthMode("login", { keepProfile: true });
        this.setData({ loading: false });
        return null;
      })
      .catch((error) => {
        const message = (error && error.message) || "协议信息加载失败，请稍后重试";
        this.setAuthMode("login", { keepProfile: true });
        this.setData({
          loading: false,
          loginDisabled: true,
          legalProfile: null,
          legalProfileReady: false,
          agreementAccepted: false,
          backendError: message,
          hasBackendError: true,
        });
        this.showFeedback("协议信息加载失败", "error");
        return null;
      });
  },

  loadSession() {
    if (!this.data.legalProfileReady) return this.loadLegalProfile({ force: true });
    this.setData({
      loading: true,
      backendError: "",
      hasBackendError: false,
    });
    return api.getSession({ force: true })
      .then((session) => {
        const sessionAgreements = (session && session.agreements) || {};
        const legalProfile = this.data.legalProfile || {};
        if (
          sessionAgreements.termsVersion
          && sessionAgreements.privacyVersion
          && (
            sessionAgreements.termsVersion !== legalProfile.termsVersion
            || sessionAgreements.privacyVersion !== legalProfile.privacyVersion
          )
        ) {
          return this.loadLegalProfile({ force: true });
        }
        const user = session.user || {};
        this.applyUser(user);
        if (session.loggedIn && !session.needsAccountBinding) {
          if (!session.agreementsAccepted) {
            this.openAgreementConsent();
            return;
          }
          this.goNext(session);
          return;
        }
        if (session.needsAccountBinding) {
          this.setAuthMode("bind", { keepProfile: true });
          if (!this.hasShownBindModal) {
            this.hasShownBindModal = true;
            dialog.show({
              title: "需要绑定账号密码",
              content: "当前微信已有 InCircle 数据，但还没有账号密码。绑定后才能继续进入圈子。",
              confirmText: "去绑定",
              showCancel: false,
            });
          }
        } else this.setAuthMode("login", { keepProfile: true });
        this.setData({ loading: false });
      })
      .catch((error) => {
        const message = error && error.message ? error.message : "后端登录状态检查失败";
        this.setData({
          loading: false,
          backendError: message,
          hasBackendError: true,
        });
        this.showFeedback("后端连接失败", "error");
      });
  },

  applyUser(user) {
    const storedAvatar = user.avatarUrlFileID || user.avatarUrl || "/images/avatar.png";
    const displayAvatar = user.avatarUrl || storedAvatar;
    this.setData({
      user,
      account: user.accountName || this.data.account || "",
      nickName: user.nickName || "",
      wechatNickName: user.wechatNickName || user.nickName || "",
      phone: user.phone || "",
      title: user.title || "",
      profileNote: user.profileNote || "",
      displayName: user.nickName || user.wechatNickName || "微信用户",
      avatarUrl: storedAvatar,
      avatarUrlDisplay: displayAvatar,
    });
  },

  setAuthMode(mode, options) {
    const meta = modeMeta(mode);
    const nextData = {
      mode,
      modeTitle: meta.title,
      modeCopy: meta.copy,
      heroCopy: meta.hero,
      primaryButtonText: meta.button,
      modeIcon: meta.icon,
      setupError: "",
      backendError: "",
      hasBackendError: false,
      password: "",
      confirmPassword: "",
      passwordVisible: false,
      confirmPasswordVisible: false,
      registerStep: 1,
      agreementAccepted: false,
      agreementAttention: false,
    };
    if (!(options && options.keepProfile)) {
      Object.assign(nextData, {
        nickName: "",
        wechatNickName: "",
        phone: "",
        title: "",
        profileNote: "",
        displayName: "微信用户",
        avatarUrl: "/images/avatar.png",
        avatarUrlDisplay: "/images/avatar.png",
      });
    }
    this.setData(nextData);
  },

  switchMode(e) {
    const mode = e.currentTarget.dataset.mode;
    this.setAuthMode(mode || "login", { keepProfile: mode === "bind" });
  },

  backAuthFlow() {
    if ((this.data.mode === "register" || this.data.mode === "bind") && this.data.registerStep === 2) {
      this.setData({ registerStep: 1, setupError: "" });
      return;
    }
    if (this.data.mode !== "bind") this.setAuthMode("login");
  },

  nextRegistrationStep() {
    if (this.data.submitting) return;
    const error = this.validateAccountPassword(true);
    if (error) {
      this.setData({ setupError: error });
      this.showFeedback(error, "warning");
      return;
    }
    this.setData({ registerStep: 2, setupError: "" });
  },

  togglePasswordVisibility() {
    this.setData({ passwordVisible: !this.data.passwordVisible });
  },

  toggleConfirmPasswordVisibility() {
    this.setData({ confirmPasswordVisible: !this.data.confirmPasswordVisible });
  },

  toggleAgreement() {
    if (this.data.submitting) return;
    if (!this.data.legalProfileReady) {
      this.setData({ setupError: "协议信息尚未加载，请重新加载" });
      return;
    }
    this.setData({
      agreementAccepted: !this.data.agreementAccepted,
      agreementAttention: false,
      setupError: "",
    });
  },

  openLegal(e) {
    const type = e.currentTarget.dataset.type === "privacy" ? "privacy" : "terms";
    wx.navigateTo({ url: `/pages/legal/index?type=${type}` });
  },

  requireAgreement() {
    if (!this.data.legalProfileReady) {
      const message = "协议信息尚未加载，请重新加载";
      this.setData({ agreementAttention: true, setupError: message });
      this.showFeedback(message, "error");
      return false;
    }
    if (this.data.agreementAccepted) return true;
    const message = "请先阅读并同意用户服务协议和隐私政策";
    this.setData({ agreementAttention: true, setupError: message });
    this.showFeedback(message, "warning");
    return false;
  },

  showFeedback(message, type) {
    if (this.feedbackTimer) clearTimeout(this.feedbackTimer);
    this.setData({
      feedbackText: message,
      feedbackType: type || "",
    });
    this.feedbackTimer = setTimeout(() => {
      this.setData({
        feedbackText: "",
        feedbackType: "",
      });
    }, 2200);
  },

  onUnload() {
    if (this.feedbackTimer) clearTimeout(this.feedbackTimer);
  },

  onAccountInput(e) {
    this.setData({ account: normalizeAccount(e.detail.value) });
  },

  onPasswordInput(e) {
    this.setData({ password: String(e.detail.value || "") });
  },

  onConfirmPasswordInput(e) {
    this.setData({ confirmPassword: String(e.detail.value || "") });
  },

  onNickInput(e) {
    const value = e.detail.value || "";
    this.setData({
      nickName: value,
      wechatNickName: value || this.data.wechatNickName,
      displayName: value || "微信用户",
    });
  },

  onChooseAvatar(e) {
    if (!this.data.agreementAccepted) {
      this.requireAgreement();
      return;
    }
    const avatarUrl = e.detail && e.detail.avatarUrl ? e.detail.avatarUrl : "";
    if (!avatarUrl) {
      this.showFeedback("未选择头像", "warning");
      return;
    }
    const previousAvatar = this.data.avatarUrl || "/images/avatar.png";
    const previousAvatarDisplay = this.data.avatarUrlDisplay || previousAvatar;
    this.setData({
      avatarUrl,
      avatarUrlDisplay: avatarUrl,
      avatarUploading: true,
      loginDisabled: true,
      setupError: "",
    });
    avatar
      .uploadAvatar(avatarUrl)
      .then((nextAvatar) => avatar.resolveAvatarUrl(nextAvatar).then((displayUrl) => ({ nextAvatar, displayUrl })))
      .then(({ nextAvatar, displayUrl }) => {
        this.setData({
          avatarUrl: nextAvatar,
          avatarUrlDisplay: displayUrl || nextAvatar,
          avatarUploading: false,
          loginDisabled: !!this.data.submitting,
          setupError: "",
        });
        this.showFeedback("头像已上传", "success");
      })
      .catch((error) => {
        this.setData({
          avatarUrl: previousAvatar,
          avatarUrlDisplay: previousAvatarDisplay,
          avatarUploading: false,
          loginDisabled: !!this.data.submitting,
          setupError: (error && error.message) || "头像上传失败，请重新选择",
        });
        this.showFeedback((error && error.message) || "头像上传失败", "warning");
      });
  },

  onPhoneInput(e) {
    this.setData({ phone: normalizePhone(e.detail.value) });
  },

  onTitleInput(e) {
    this.setData({ title: e.detail.value });
  },

  onNoteInput(e) {
    this.setData({ profileNote: e.detail.value });
  },

  buildProfile() {
    const nickName = normalizeText(this.data.nickName || this.data.wechatNickName);
    return {
      nickName,
      wechatNickName: this.data.wechatNickName || "",
      avatarUrl: this.data.avatarUrl || "/images/avatar.png",
      phone: normalizePhone(this.data.phone),
      title: String(this.data.title || "").trim(),
      profileNote: String(this.data.profileNote || "").trim(),
    };
  },

  validateAccountPassword(requireConfirm) {
    const account = normalizeAccount(this.data.account);
    const password = String(this.data.password || "");
    if (account.length < 4) return "请输入至少 4 位账号";
    if (!/^[a-zA-Z0-9_.@-]+$/.test(account)) return "账号只支持手机号、邮箱或英文数字组合";
    if (password.length < 8 || password.length > 64) return "密码需要 8-64 位";
    if (/\s/.test(password)) return "密码不能包含空格";
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "密码至少包含一个字母和一个数字";
    if (requireConfirm && password !== this.data.confirmPassword) return "两次输入的密码不一致";
    return "";
  },

  validateProfile(profile) {
    if (this.data.avatarUploading) return "头像还在上传，请稍等";
    if (avatar.isTemporaryAvatar(profile.avatarUrl)) return "头像还没有上传成功，请重新选择头像";
    if (!profile.nickName || profile.nickName.length < 2) return "请填写至少 2 个字的昵称";
    if (!/^1\d{10}$/.test(profile.phone)) return "请填写 11 位手机号";
    return "";
  },

  submitAuth() {
    if (this.data.submitting) return;
    const mode = this.data.mode;
    if (!this.requireAgreement()) return;
    const agreementAcceptance = legal.acceptancePayload(true, this.data.legalProfile);

    const requireConfirm = mode !== "login";
    let error = this.validateAccountPassword(requireConfirm);
    const payload = {
      account: normalizeAccount(this.data.account),
      password: String(this.data.password || ""),
      themePreferenceExplicit: this.data.themePreferenceExplicit,
      agreementAcceptance,
    };
    if (!error && (mode === "register" || mode === "bind")) {
      const profile = this.buildProfile();
      error = this.validateProfile(profile);
      payload.profile = profile;
    }
    if (error) {
      this.setData({ setupError: error });
      this.showFeedback(error, "warning");
      return;
    }

    const meta = modeMeta(mode);
    this.setData({
      submitting: true,
      loginDisabled: true,
      primaryButtonText: mode === "login" ? "登录中..." : "处理中...",
      setupError: "",
      backendError: "",
      hasBackendError: false,
    });

    const action =
      mode === "register"
        ? api.registerAccount(payload)
        : mode === "bind"
          ? api.bindAccount(payload)
          : mode === "forgot"
            ? api.resetPassword(payload)
            : api.accountLogin(payload.account, payload.password, {
                themePreferenceExplicit: payload.themePreferenceExplicit,
                agreementAcceptance,
              });

    action
      .then((session) => {
        return this.completeLogin(
          session,
          mode === "forgot" ? "密码已重置" : "登录成功"
        );
      })
      .catch((err) => {
        if (mode === "login" && err && err.errCode === "WECHAT_REBIND_CONFIRM_REQUIRED") {
          dialog.show({
            title: "绑定当前微信",
            content: `账号 ${((err.details || {}).accountMasked) || payload.account} 已解除原微信绑定。确认后将绑定到当前微信，旧微信不再可用。`,
            confirmText: "确认绑定",
            tone: "danger",
            success: (res) => {
              if (res.confirm) this.confirmWechatRebind(payload);
            },
          });
          return;
        }
        const message = err && err.message ? err.message : "操作失败";
        if (err && err.errCode === "AGREEMENT_ACCEPTANCE_REQUIRED") {
          this.setData({ agreementAccepted: false, agreementAttention: true });
          return this.loadLegalProfile({ force: true });
        }
        this.setData({
          backendError: message,
          hasBackendError: true,
        });
        this.showFeedback(message, "error");
      })
      .finally(() => {
        this.setData({
          submitting: false,
          loginDisabled: false,
          primaryButtonText: meta.button,
        });
      });
  },

  confirmWechatRebind(payload) {
    if (this.data.submitting) return;
    this.setData({ submitting: true, loginDisabled: true, primaryButtonText: "绑定中..." });
    api
      .accountLogin(payload.account, payload.password, {
        themePreferenceExplicit: payload.themePreferenceExplicit,
        confirmWechatRebind: true,
        agreementAcceptance: payload.agreementAcceptance || legal.acceptancePayload(
          this.data.agreementAccepted,
          this.data.legalProfile
        ),
      })
      .then((session) => {
        return this.completeLogin(session, "微信已重新绑定");
      })
      .catch((error) => {
        const message = (error && error.message) || "绑定失败";
        this.setData({ backendError: message, hasBackendError: true });
        this.showFeedback(message, "error");
      })
      .finally(() => {
        this.setData({ submitting: false, loginDisabled: false, primaryButtonText: modeMeta("login").button });
      });
  },

  retrySession() {
    if (!this.data.legalProfileReady) {
      this.loadLegalProfile({ force: true });
      return;
    }
    this.loadSession();
  },

  openAgreementConsent() {
    const query = invite.inviteQuery(this.data.nextCode, this.data.nextInviteToken);
    wx.reLaunch({ url: `/pages/agreement-consent/index${query}` });
  },

  completeLogin(session, successText) {
    // A login capture is silent: missing privacy or location permission skips it.
    loginLocation.captureAndSave(session, { interactive: false });
    this.showFeedback(successText || "登录成功", "success");
    this.goNext(session);
    return Promise.resolve(session);
  },

  goNext(session) {
    if (this.data.nextInviteToken) {
      wx.redirectTo({
        url: `/pages/circle-join/index${invite.inviteQuery("", this.data.nextInviteToken)}`,
      });
      return;
    }
    if (this.data.nextCode) {
      wx.redirectTo({
        url: `/pages/circle-join/index${invite.inviteQuery(this.data.nextCode, "")}`,
      });
      return;
    }
    const currentCircle = session && session.currentCircle;
    if (session && session.loggedIn && session.hasCircle && currentCircle && currentCircle.id) {
      wx.switchTab({ url: "/pages/index/index" });
      return;
    }
    wx.redirectTo({ url: "/pages/circle-switch/index" });
  },
});
