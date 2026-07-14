function getSettlementTemplateId() {
  try {
    const app = typeof getApp === "function" ? getApp() : null;
    const templates = (app && app.globalData && app.globalData.subscribeTemplates) || {};
    return templates.settlementReminderTemplateId || "";
  } catch (error) {
    return "";
  }
}

function requestSettlementReminder() {
  const templateId = getSettlementTemplateId();
  if (!templateId) {
    return Promise.resolve({
      enabled: false,
      templateId: "",
      accepted: false,
      message: "未配置服务通知模板，已使用站内提醒",
    });
  }
  if (!wx.requestSubscribeMessage) {
    return Promise.resolve({
      enabled: false,
      templateId,
      accepted: false,
      message: "当前基础库暂不支持服务通知授权",
    });
  }
  return new Promise((resolve) => {
    wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success: (res) => {
        const status = res && res[templateId];
        resolve({
          enabled: true,
          templateId,
          accepted: status === "accept",
          status,
          message: status === "accept" ? "已授权本次结款服务通知" : "未授权服务通知，仍会生成站内提醒",
        });
      },
      fail: (error) => {
        resolve({
          enabled: true,
          templateId,
          accepted: false,
          status: "fail",
          message: error && error.errMsg ? error.errMsg : "服务通知授权失败",
        });
      },
    });
  });
}

module.exports = {
  getSettlementTemplateId,
  requestSettlementReminder,
};

