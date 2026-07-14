const api = require("../../utils/api");
const notice = require("../../utils/notice");
const editIntent = require("../../utils/editIntent");
const dialog = require("../../utils/dialog");

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toMoney(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
}

function personName(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  return String(value.memberName || value.name || value.nickname || value.from || value.to || "").trim();
}

function normalizeDebtors(value) {
  const seen = {};
  return asArray(value).reduce((list, item) => {
    const name = personName(item);
    if (!name || seen[name]) return list;
    seen[name] = true;
    list.push(name);
    return list;
  }, []);
}

function normalizeTransfers(value, debtors, payerName) {
  const transfers = asArray(value)
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const from = personName(item.from || item.memberName || item.name);
      const to = personName(item.to) || payerName;
      const amount = toMoney(item.amount);
      if (!from || !to) return null;
      return { from, to, amount };
    })
    .filter(Boolean);
  if (transfers.length) return transfers;
  return asArray(debtors)
    .map((item) => ({ from: personName(item), to: payerName, amount: toMoney(item && item.amount) }))
    .filter((item) => item.from && item.to);
}

function decorateBill(bill) {
  const payerName = personName(bill.payerName || bill.creatorName || bill.hostName) || "发起人";
  const rawDebtors = asArray(bill.debtors);
  const debtors = normalizeDebtors(rawDebtors);
  const transfers = normalizeTransfers(bill.transfers, rawDebtors, payerName);
  const hasDebtors = debtors.length > 0;
  const hasTransfers = transfers.length > 0;
  const expenseItems = asArray(bill.expenseItems).length ? asArray(bill.expenseItems) : [{ name: bill.title, amount: bill.amount }];
  const amount = toMoney(bill.amount || expenseItems.reduce((sum, item) => sum + Number(item.amount || 0), 0));
  const participants = asArray(bill.participants);
  const participantCount = participants.length || debtors.length + (payerName ? 1 : 0);
  const perPerson = toMoney(bill.perPerson || (participantCount ? amount / participantCount : 0));
  const unsettledCount = Number.isFinite(Number(bill.unsettledCount)) ? Number(bill.unsettledCount) : debtors.length;
  const transferText = hasTransfers
    ? transfers.map((item) => `${item.from} 转 ${item.to} ¥${item.amount}`).join("；")
    : "";
  return Object.assign({}, bill, {
    payerName,
    amount,
    perPerson,
    unsettledCount,
    debtors,
    transfers,
    expenseItems,
    hasDebtors,
    hasTransfers,
    hasExpenseItems: expenseItems.length > 0,
    statusClass: bill.status === "已结清" ? "pill-green" : "pill-red",
    perPersonLabel: bill.splitMode === "自定义金额" ? "平均应付" : "人均",
    debtorText: hasDebtors ? bill.debtors.join("、") : "全员已结清",
    reminderText: bill.lastReminder || "还没提醒过，先礼貌摇一下。",
    shareText: hasDebtors
      ? `【${bill.title}】${bill.payerName} 垫付 ${bill.amount} 元，还有 ${bill.unsettledCount} 人没结清。${transferText}`
      : `【${bill.title}】已结清，感谢各位手速。`,
  });
}

Page({
  data: {
    ready: false,
    bill: null,
    actionLoadingType: "",
  },

  onLoad(options) {
    this.billId = options.id;
    const sharedCircleId = options.circleId || "";
    const app = getApp();
    const currentCircleId = app && app.globalData ? app.globalData.currentCircleId : "";
    const prepare = sharedCircleId && sharedCircleId !== currentCircleId
      ? api.switchCircle(sharedCircleId)
      : Promise.resolve();
    prepare
      .then(() => this.loadBill())
      .catch((error) => {
        wx.showToast({ title: (error && error.message) || "无法进入分享所属圈子", icon: "none" });
      });
  },

  loadBill() {
    api.getBill(this.billId).then((bill) => {
      this.setData({
        bill: decorateBill(bill),
        ready: true,
      });
    });
  },

  editBill() {
    const bill = this.data.bill || {};
    if (!bill.canEdit) {
      wx.showToast({ title: bill.editDisabledReason || "当前 AA 不能编辑", icon: "none" });
      return;
    }
    editIntent.setEditIntent("bill", bill.id || this.billId);
    api.clearCache(["incircleTools"]);
    wx.switchTab({ url: "/pages/tools/index" });
  },

  startAction(type) {
    if (this.data.actionLoadingType) return false;
    this.setData({ actionLoadingType: type });
    return true;
  },

  finishAction() {
    this.setData({ actionLoadingType: "" });
  },

  showActionError(error) {
    wx.showToast({
      title: (error && error.message) || "操作失败，请稍后重试",
      icon: "none",
    });
  },

  runAction(type, task) {
    if (!this.startAction(type)) return Promise.resolve();
    return Promise.resolve()
      .then(task)
      .catch((error) => {
        this.showActionError(error);
      })
      .then(() => {
        this.finishAction();
      });
  },

  remindBill() {
    this.runAction("remindBill", () =>
      notice.requestSettlementReminder().then((noticeOptions) =>
        api.remindBill(this.data.bill.id, noticeOptions).then((bill) => {
        const nextBill = decorateBill(bill);
        this.setData({ bill: nextBill });
        wx.setClipboardData({
          data: nextBill.shareText,
          success: () => {
            wx.showToast({
              title: noticeOptions.accepted ? "服务通知已处理" : "提醒文案已复制",
              icon: "none",
            });
          },
        });
        })
      )
    );
  },

  markSettled() {
    this.runAction("settleBill", () => api.settleBill(this.data.bill.id).then((bills) => {
      const bill = bills.find((item) => item.id === this.data.bill.id) || bills[0];
      this.setData({ bill: decorateBill(bill) });
      wx.showToast({ title: "已标记结清", icon: "success" });
    }));
  },

  copySummary() {
    wx.setClipboardData({
      data: this.data.bill.shareText,
      success: () => {
        wx.showToast({ title: "结算摘要已复制", icon: "success" });
      },
    });
  },

  deleteBill() {
    const bill = this.data.bill || {};
    if (!bill.canDelete || this.data.actionLoadingType) return;
    dialog.show({
      title: "删除 AA",
      content: `确认删除「${bill.title || "这个 AA 账单"}」吗？结算记录和提醒状态会一起删除。`,
      confirmText: "删除",
      confirmColor: "#B34A34",
      success: (res) => {
        if (!res.confirm) return;
        this.runAction("deleteBill", () =>
          api.deleteBill(bill.id || this.billId).then(() => {
            wx.showToast({ title: "AA 已删除", icon: "success" });
            wx.navigateBack({
              fail: () => wx.switchTab({ url: "/pages/tools/index" }),
            });
          })
        );
      },
    });
  },

  onShareAppMessage() {
    const bill = this.data.bill || {};
    const app = getApp();
    const circleId = bill.circleId || (app && app.globalData && app.globalData.currentCircleId) || "";
    return {
      title: bill.title ? `AA 结算：${bill.title}` : "InCircle AA 结算",
      path: `/pages/bill-detail/index?id=${bill.id || this.billId}&circleId=${circleId}`,
    };
  },
});
