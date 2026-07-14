const api = require("../../utils/api");
const time = require("../../utils/time");
const dialog = require("../../utils/dialog");

Page({
  data: { loading: true, member: null, removing: false },

  onLoad(options) {
    this.circleId = (options && options.circleId) || "";
    this.membershipId = (options && options.id) || "";
    this.loadMember();
  },

  loadMember() {
    api
      .getCircleMember(this.circleId, this.membershipId)
      .then((member) => this.setData({
        member: Object.assign({}, member, {
          joinedAtText: member.joinedAt ? time.displayDateTime(member.joinedAt) : "未记录",
          hasTags: !!(member.tags && member.tags.length),
          hasSkills: !!(member.skills && member.skills.length),
          hasInterests: !!(member.interests && member.interests.length),
        }),
        loading: false,
      }))
      .catch((error) => {
        this.setData({ loading: false });
        wx.showToast({ title: (error && error.message) || "成员信息加载失败", icon: "none" });
      });
  },

  removeMember() {
    const member = this.data.member || {};
    if (!member.canRemove || this.data.removing) return;
    dialog.show({
      title: "移除成员",
      content: `确认将「${member.name || "该成员"}」移出当前圈子？历史共享业务会保留。`,
      confirmText: "移除",
      tone: "danger",
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ removing: true });
        api
          .removeCircleMember(this.circleId, this.membershipId, "圈主移除成员")
          .then(() => {
            wx.showToast({ title: "成员已移除", icon: "success" });
            setTimeout(() => wx.navigateBack(), 250);
          })
          .catch((error) => wx.showToast({ title: (error && error.message) || "移除失败", icon: "none" }))
          .finally(() => this.setData({ removing: false }));
      },
    });
  },
});
