class AppError extends Error {
  constructor(message, options) {
    super(message);
    this.name = "AppError";
    this.statusCode = (options && options.statusCode) || 400;
    this.errCode = (options && options.errCode) || "APP_ERROR";
    this.details = options && options.details;
  }
}

function toErrorResponse(error, options) {
  const statusCode = error && error.statusCode ? error.statusCode : 500;
  const exposeInternal = !!(options && options.exposeInternal);
  const isInternal = statusCode >= 500 && !(error instanceof AppError);
  return {
    statusCode,
    body: {
      success: false,
      errCode: (error && error.errCode) || "INTERNAL_ERROR",
      errMsg: isInternal && !exposeInternal ? "服务器内部错误，请稍后重试" : (error && error.message) || "Server error",
      details: isInternal && !exposeInternal ? undefined : error && error.details,
    },
  };
}

module.exports = {
  AppError,
  toErrorResponse,
};
