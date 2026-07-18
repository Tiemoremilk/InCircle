const COMPONENT_SELECTOR = "#incircle-theme-dialog";

function safeCallback(callback, payload) {
  if (typeof callback !== "function") return;
  try {
    callback(payload);
  } catch (error) {
    setTimeout(() => {
      throw error;
    }, 0);
  }
}

function currentDialogComponent() {
  try {
    const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
    const page = pages && pages.length ? pages[pages.length - 1] : null;
    if (!page || typeof page.selectComponent !== "function") return null;
    return page.selectComponent(COMPONENT_SELECTOR);
  } catch (error) {
    return null;
  }
}

function customOptions(options) {
  const source = options || {};
  return {
    title: source.title,
    content: source.content,
    confirmText: source.confirmText,
    cancelText: source.cancelText,
    showCancel: source.showCancel,
    confirmColor: source.confirmColor,
    tone: source.tone,
    maskClosable: source.maskClosable,
    verificationText: source.verificationText,
    verificationLabel: source.verificationLabel,
    verificationPlaceholder: source.verificationPlaceholder,
    confirmOpenType: source.confirmOpenType,
  };
}

function show(options) {
  const source = options || {};
  const component = currentDialogComponent();
  if (component && typeof component.open === "function") {
    return component.open(customOptions(source)).then(
      (result) => {
        safeCallback(source.success, result);
        safeCallback(source.complete, result);
        return result;
      },
      (error) => {
        const failure = error || { errMsg: "showModal:fail" };
        safeCallback(source.fail, failure);
        safeCallback(source.complete, failure);
        return Promise.reject(failure);
      }
    );
  }

  return new Promise((resolve, reject) => {
    if (typeof wx === "undefined" || typeof wx.showModal !== "function") {
      const error = { errMsg: "showModal:fail unavailable" };
      safeCallback(source.fail, error);
      safeCallback(source.complete, error);
      reject(error);
      return;
    }
    wx.showModal(
      Object.assign({}, source, {
        success(result) {
          safeCallback(source.success, result);
          resolve(result);
        },
        fail(error) {
          safeCallback(source.fail, error);
          reject(error);
        },
        complete(result) {
          safeCallback(source.complete, result);
        },
      })
    );
  });
}

module.exports = {
  show,
  currentDialogComponent,
};
