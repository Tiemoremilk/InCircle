const api = require("../../utils/api");
const dialog = require("../../utils/dialog");
const time = require("../../utils/time");

function decorateMembers(members) {
  return (members || []).map((member) => Object.assign({}, member, {
    joinedAtText: member.joinedAt ? `加入于 ${time.displayDateTime(member.joinedAt)}` : "加入时间未记录",
  }));
}

Page({
  data: {
    loading: true,
    circleId: "",
    circle: null,
    members: [],
    canManage: false,
    canExit: false,
    canDissolve: false,
    inviteCode: "",
    inviteToken: "",
    invitePath: "/pages/circle-join/index",
    inviteCodeRotating: false,
    inviteQrCode: null,
    inviteQrFileID: "",
    inviteQrImageUrl: "",
    inviteQrLoading: false,
    inviteQrSaving: false,
    inviteQrButtonText: "生成入圈码",
    saveBusy: false,
    destructiveBusy: "",
    aiStatus: null,
    platformAiEnabled: true,
    aiBusy: false,
    draft: {
      name: "",
      notice: "",
      slogan: "",
    },
  },

  onLoad(options) {
    if (typeof wx.showShareMenu === "function") {
      wx.showShareMenu({ withShareTicket: true });
    }
    this.setData({
      circleId: options && options.id ? options.id : "",
    });
    this.loadSettings();
  },

  onShow() {
    if (!this.data.circleId || this.data.loading) return;
    this.refreshAiAvailability();
  },

  loadSettings() {
    api.getCircleSettings(this.data.circleId, { force: true }).then((data) => {
      const platformAiEnabled = data.platformAiEnabled !== false;
      const aiRequest = platformAiEnabled && data.canManage
        ? api.getAiStatus(this.data.circleId).catch(() => null)
        : Promise.resolve(null);
      return aiRequest.then((aiStatus) => ({
        data,
        aiStatus,
        platformAiEnabled: platformAiEnabled && (!aiStatus || aiStatus.platformEnabled !== false),
      }));
    }).then(({ data, aiStatus, platformAiEnabled }) => {
      const circle = data.circle || {};
      this.setData({
        circle,
        members: decorateMembers(data.members),
        canManage: !!data.canManage,
        canExit: !!data.canExit,
        canDissolve: !!data.canDissolve,
        inviteCode: data.inviteCode || "",
        inviteToken: data.inviteToken || "",
        invitePath: data.invitePath || "/pages/circle-join/index",
        inviteCodeRotating: false,
        inviteQrCode: null,
        inviteQrFileID: "",
        inviteQrImageUrl: "",
        inviteQrButtonText: "生成入圈码",
        aiStatus,
        platformAiEnabled,
        draft: {
          name: circle.name || "",
          notice: circle.notice || "",
          slogan: circle.slogan || "",
        },
        loading: false,
      });
    });
  },

  refreshAiAvailability() {
    api.getCircleSettings(this.data.circleId, { force: true }).then((data) => {
      const platformAiEnabled = data.platformAiEnabled !== false;
      if (!platformAiEnabled || !data.canManage) {
        this.setData({ platformAiEnabled, aiStatus: null });
        return null;
      }
      return api.getAiStatus(this.data.circleId, { force: true }).then((aiStatus) => {
        this.setData({ platformAiEnabled: true, aiStatus });
      });
    }).catch(() => {});
  },

  toggleAi(e) {
    if (!this.data.platformAiEnabled) return;
    const aiStatus = this.data.aiStatus;
    const enabled = !!e.detail.value;
    if (!aiStatus || !aiStatus.canManage || this.data.aiBusy) return;
    this.setData({ aiBusy: true, "aiStatus.enabled": enabled });
    api
      .updateAiSettings(this.data.circleId, { enabled })
      .then((settings) => {
        this.setData({ aiStatus: settings });
        wx.showToast({
          title: enabled && !settings.configured ? "已开启，待配置模型" : enabled ? "AI 助手已开启" : "AI 助手已关闭",
          icon: enabled && !settings.configured ? "none" : "success",
        });
      })
      .catch((error) => {
        this.setData({ "aiStatus.enabled": !enabled });
        wx.showToast({ title: error.message || "设置失败", icon: "none" });
      })
      .finally(() => this.setData({ aiBusy: false }));
  },

  openAiManage() {
    if (!this.data.aiStatus || !this.data.aiStatus.canManage) return;
    wx.navigateTo({ url: `/pages/ai-manage/index?circleId=${this.data.circleId}` });
  },

  openCircleMember(e) {
    const membershipId = e.currentTarget.dataset.id || "";
    if (!membershipId || this.data.destructiveBusy) return;
    wx.navigateTo({ url: `/pages/circle-member/index?circleId=${this.data.circleId}&id=${membershipId}` });
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({
      [`draft.${field}`]: e.detail.value,
    });
  },

  saveCircle() {
    if (!this.data.canManage || this.data.saveBusy || this.data.destructiveBusy) return;
    this.setData({ saveBusy: true });
    api
      .updateCircleInfo(this.data.circle.id, {
        name: this.data.draft.name,
        notice: this.data.draft.notice,
        slogan: this.data.draft.slogan,
      })
      .then((data) => {
        const circle = data.circle || {};
        this.setData({
          circle,
          draft: {
            name: circle.name || "",
            notice: circle.notice || "",
            slogan: circle.slogan || "",
          },
        });
        wx.showToast({
          title: "已保存",
          icon: "success",
        });
      })
      .catch((error) => {
        wx.showToast({
          title: error.message || "保存失败",
          icon: "none",
        });
      })
      .finally(() => {
        this.setData({ saveBusy: false });
      });
  },

  copyInviteCode() {
    if (this.data.inviteCodeRotating) return;
    wx.setClipboardData({
      data: this.data.inviteCode,
      success: () => {
        wx.showToast({
          title: "邀请码已复制",
          icon: "success",
        });
      },
    });
  },

  inviteSharePath() {
    if (this.data.invitePath) return this.data.invitePath;
    if (this.data.inviteToken) {
      return `/pages/circle-join/index?token=${encodeURIComponent(this.data.inviteToken)}`;
    }
    return "/pages/circle-join/index";
  },

  rotateInviteCode() {
    if (
      !this.data.canManage
      || this.data.inviteCodeRotating
      || this.data.inviteQrLoading
      || this.data.inviteQrSaving
      || this.data.destructiveBusy
    ) return;
    dialog.show({
      title: "更换邀请码",
      content: "更换后，当前邀请码、已保存的入圈码图片和之前分享的邀请入口都会立即失效，旧邀请码无法恢复。",
      tone: "primary",
      cancelText: "暂不更换",
      confirmText: "确认更换",
    }).then((result) => {
      if (!result.confirm) return;
      this.setData({ inviteCodeRotating: true });
      api
        .rotateInviteCode(this.data.circle.id)
        .then((data) => {
          const circle = data.circle || this.data.circle;
          this.setData({
            circle,
            members: decorateMembers(data.members || this.data.members),
            canManage: !!data.canManage,
            canExit: !!data.canExit,
            canDissolve: !!data.canDissolve,
            inviteCode: data.inviteCode || "",
            inviteToken: data.inviteToken || "",
            invitePath: data.invitePath || "/pages/circle-join/index",
            inviteQrCode: null,
            inviteQrFileID: "",
            inviteQrImageUrl: "",
            inviteQrButtonText: "生成入圈码",
          });
          wx.showToast({ title: "邀请码已更换", icon: "success" });
        })
        .catch((error) => {
          wx.showToast({ title: error.message || "更换失败，请稍后重试", icon: "none" });
        })
        .finally(() => this.setData({ inviteCodeRotating: false }));
    });
  },

  resolveInviteQrUrl(qrCode) {
    return Promise.resolve((qrCode && (qrCode.imageUrl || qrCode.url || qrCode.fileID)) || "");
  },

  loadInviteQrCode() {
    if (this.data.inviteCodeRotating) return Promise.reject(new Error("邀请码正在更换"));
    if (this.data.inviteQrLoading) return Promise.resolve(this.data.inviteQrCode);
    if (this.data.inviteQrCode && this.data.inviteQrImageUrl) return Promise.resolve(this.data.inviteQrCode);
    const circleId = this.data.circle && this.data.circle.id;
    if (!circleId) {
      wx.showToast({ title: "圈子信息未就绪", icon: "none" });
      return Promise.reject(new Error("圈子信息未就绪"));
    }
    this.setData({
      inviteQrLoading: true,
      inviteQrButtonText: "生成中...",
    });
    return api
      .getInviteQrCode(circleId)
      .then((qrCode) =>
        this.resolveInviteQrUrl(qrCode).then((imageUrl) => {
          this.setData({
            inviteQrCode: qrCode,
            inviteQrFileID: (qrCode && qrCode.fileID) || "",
            inviteQrImageUrl: imageUrl,
            inviteQrButtonText: "查看入圈码",
          });
          return qrCode;
        })
      )
      .catch((error) => {
        const isConfigError = error && error.errCode === "WECHAT_CONFIG_REQUIRED";
        const detail =
          error && error.details && error.details.errmsg ? `\n\n微信返回：${error.details.errmsg}` : "";
        dialog.show({
          title: isConfigError ? "缺少微信配置" : "入圈码生成失败",
          content: isConfigError
            ? "服务器还没有配置 WECHAT_APP_SECRET，无法生成可扫码进入小程序的官方入圈码。配置后重新部署，再点生成入圈码。"
            : `${(error && error.message) || "请稍后重试"}${detail}`,
          showCancel: false,
          confirmText: "知道了",
        });
        throw error;
      })
      .finally(() => {
        this.setData({
          inviteQrLoading: false,
          inviteQrButtonText: this.data.inviteQrImageUrl ? "查看入圈码" : "生成入圈码",
        });
      });
  },

  handleInviteQrAction() {
    if (this.data.inviteQrLoading || this.data.inviteCodeRotating) return;
    if (this.data.inviteQrImageUrl) {
      this.previewInviteQrCode();
      return;
    }
    this.loadInviteQrCode().catch(() => {});
  },

  previewInviteQrCode() {
    if (!this.data.inviteQrImageUrl) {
      this.loadInviteQrCode()
        .then(() => this.previewInviteQrCode())
        .catch(() => {});
      return;
    }
    wx.previewImage({
      current: this.data.inviteQrImageUrl,
      urls: [this.data.inviteQrImageUrl],
    });
  },

  saveInviteQrCode() {
    if (this.data.inviteQrSaving || this.data.inviteCodeRotating) return;
    const finishSave = () => {
      this.setData({ inviteQrSaving: false });
    };
    const saveFile = () => {
      this.setData({ inviteQrSaving: true });
      wx.downloadFile({
        url: this.data.inviteQrImageUrl,
        success: (download) => {
          wx.saveImageToPhotosAlbum({
            filePath: download.tempFilePath,
            success: () => {
              finishSave();
              wx.showToast({ title: "已保存到相册", icon: "success" });
            },
            fail: (error) => {
              finishSave();
              if (error && /auth|authorize|deny/i.test(error.errMsg || "")) {
                dialog.show({
                  title: "需要相册权限",
                  content: "请允许保存到相册，之后就能把入圈码发到微信群或线下展示。",
                  confirmText: "去设置",
                  confirmOpenType: "openSetting",
                });
                return;
              }
              wx.showToast({ title: "保存失败", icon: "none" });
            },
          });
        },
        fail: () => {
          finishSave();
          wx.showToast({ title: "下载入圈码失败", icon: "none" });
        },
      });
    };
    if (this.data.inviteQrImageUrl) {
      saveFile();
      return;
    }
    this.loadInviteQrCode().then(saveFile).catch(() => {});
  },

  exitCircle() {
    if (this.data.destructiveBusy) return;
    dialog.show({
      title: "退出圈子",
      content: "退出后不再看到这个圈子的新活动、AA 和资料，历史记录仍会保留。",
      confirmText: "退出",
      tone: "danger",
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ destructiveBusy: "exit" });
        api
          .exitCircle(this.data.circle.id)
          .then((data) => {
            wx.showToast({
              title: "已退出圈子",
              icon: "success",
            });
            const url = data.hasCircles ? "/pages/circle-switch/index" : "/pages/circle-join/index";
            wx.redirectTo({ url });
          })
          .catch((error) => {
            wx.showToast({
              title: error.message || "退出失败",
              icon: "none",
            });
          })
          .finally(() => {
            this.setData({ destructiveBusy: "" });
          });
      },
    });
  },

  dissolveCircle() {
    if (this.data.destructiveBusy) return;
    dialog.show({
      title: "解散圈子",
      content: "解散后会永久删除该圈子、成员关系和圈内业务数据。这个操作不能撤销。",
      confirmText: "解散",
      confirmColor: "#B34A34",
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ destructiveBusy: "dissolve" });
        api
          .dissolveCircle(this.data.circle.id)
          .then((data) => {
            wx.showToast({
              title: "圈子已解散",
              icon: "success",
            });
            const url = data.hasCircles ? "/pages/circle-switch/index" : "/pages/circle-join/index";
            wx.redirectTo({ url });
          })
          .catch((error) => {
            wx.showToast({
              title: error.message || "解散失败",
              icon: "none",
            });
          })
          .finally(() => {
            this.setData({ destructiveBusy: "" });
          });
      },
    });
  },

  onShareAppMessage() {
    const circle = this.data.circle || {};
    return {
      title: circle.name ? `${circle.name} 邀你加入` : "邀请你加入 InCircle 熟人圈",
      path: this.inviteSharePath(),
    };
  },
});
