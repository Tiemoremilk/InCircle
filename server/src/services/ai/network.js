const dns = require("dns").promises;
const https = require("https");
const net = require("net");

const { AppError } = require("../../errors");

function blockedIpv4(address) {
  const parts = String(address || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function blockedIp(address) {
  const value = String(address || "").toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (net.isIPv4(value)) return blockedIpv4(value);
  if (!net.isIPv6(value)) return true;
  if (
    value === "::" || value === "::1" || value.startsWith("::") || value.startsWith("fc") ||
    value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") ||
    value.startsWith("fea") || value.startsWith("feb") || value.startsWith("ff")
  ) return true;
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? blockedIpv4(mapped[1]) : false;
}

function parseHttpsUrl(value, options) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch (error) {
    throw new AppError("供应商地址格式不正确", { statusCode: 400, errCode: "AI_PROVIDER_URL_INVALID" });
  }
  if (url.protocol !== "https:") {
    throw new AppError("供应商地址必须使用 HTTPS", { statusCode: 400, errCode: "AI_PROVIDER_HTTPS_REQUIRED" });
  }
  if (url.username || url.password) {
    throw new AppError("供应商地址不能包含账号或密码", { statusCode: 400, errCode: "AI_PROVIDER_URL_CREDENTIALS" });
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new AppError("供应商地址不能指向本机或内网", { statusCode: 400, errCode: "AI_PROVIDER_URL_BLOCKED" });
  }
  if (net.isIP(hostname) && blockedIp(hostname)) {
    throw new AppError("供应商地址不能指向本机或内网", { statusCode: 400, errCode: "AI_PROVIDER_URL_BLOCKED" });
  }
  if (options && options.baseUrl && (url.search || url.hash)) {
    throw new AppError("供应商基础地址不能包含查询参数或片段", { statusCode: 400, errCode: "AI_PROVIDER_URL_INVALID" });
  }
  return url;
}

async function resolvePublicAddresses(hostname) {
  const lookupHostname = String(hostname || "").replace(/^\[|\]$/g, "");
  let records;
  try {
    records = await dns.lookup(lookupHostname, { all: true, verbatim: true });
  } catch (error) {
    throw new AppError("供应商地址无法解析，请检查域名", {
      statusCode: 400,
      errCode: "AI_PROVIDER_DNS_FAILED",
    });
  }
  const publicRecords = records.filter((record) => !blockedIp(record.address));
  if (!publicRecords.length) {
    throw new AppError("供应商地址解析到了本机或内网，已拒绝连接", {
      statusCode: 400,
      errCode: "AI_PROVIDER_DNS_BLOCKED",
    });
  }
  // Pin only public answers. Some public DNS providers return an unusable private
  // IPv6 compatibility record alongside a valid public IPv4 address.
  return publicRecords;
}

async function validateProviderBaseUrl(value) {
  const url = parseHttpsUrl(value, { baseUrl: true });
  await resolvePublicAddresses(url.hostname);
  return url.toString().replace(/\/$/, "");
}

function pinnedLookup(records) {
  return (hostname, options, callback) => {
    const opts = typeof options === "object" ? options : {};
    const done = typeof options === "function" ? options : callback;
    const familyRecord = opts.family ? records.find((record) => record.family === opts.family) : records[0];
    const selected = familyRecord || records[0];
    if (opts.all) {
      done(null, records.map((record) => ({ address: record.address, family: record.family })));
      return;
    }
    done(null, selected.address, selected.family);
  };
}

function requestOnce(url, options, records) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, options.headers || {});
    const body = options.body ? Buffer.from(options.body) : null;
    if (body && !headers["content-length"]) headers["content-length"] = String(body.length);
    const idleTimeoutMs = Math.max(0, Number(options.timeoutMs || 300000));
    const connectTimeoutMs = Math.min(idleTimeoutMs || 30000, 30000);
    let connectTimer = null;
    let response = null;
    let settled = false;
    const timeoutError = (message) => Object.assign(new Error(message), { code: "AI_PROVIDER_TIMEOUT" });
    const clearConnectTimer = () => {
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = null;
    };
    const removeAbortListener = () => {
      if (options.signal && typeof options.signal.removeEventListener === "function") {
        options.signal.removeEventListener("abort", abort);
      }
    };
    const cleanup = () => {
      clearConnectTimer();
      removeAbortListener();
    };
    const abort = () => {
      const error = Object.assign(new Error("请求已取消"), { name: "AbortError" });
      if (response && !response.destroyed) response.destroy(error);
      request.destroy(error);
    };
    const request = https.request(
      url,
      {
        method: options.method || "GET",
        headers,
        lookup: pinnedLookup(records),
        servername: url.hostname.replace(/^\[|\]$/g, ""),
      },
      (incoming) => {
        response = incoming;
        clearConnectTimer();
        if (idleTimeoutMs && typeof incoming.setTimeout === "function") {
          incoming.setTimeout(idleTimeoutMs, () => incoming.destroy(timeoutError("供应商流长时间没有数据")));
        }
        incoming.once("end", cleanup);
        incoming.once("close", cleanup);
        incoming.once("error", cleanup);
        settled = true;
        resolve(incoming);
      }
    );
    // TLS establishment and model time-to-first-token are different phases.
    // Stop the short connection timer as soon as TLS is ready.
    connectTimer = setTimeout(() => request.destroy(timeoutError("连接 AI 供应商超时")), connectTimeoutMs);
    request.once("socket", (socket) => {
      if (!socket || !socket.connecting) {
        clearConnectTimer();
        return;
      }
      socket.once("secureConnect", clearConnectTimer);
      socket.once("error", clearConnectTimer);
    });
    if (idleTimeoutMs) {
      request.setTimeout(idleTimeoutMs, () => request.destroy(timeoutError("供应商流长时间没有数据")));
    }
    if (options.signal) {
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    }
    request.on("error", (error) => {
      if (!settled) {
        cleanup();
        reject(error);
      }
    });
    if (body) request.write(body);
    request.end();
  });
}

async function safeHttpsRequest(value, options, redirectCount) {
  const url = parseHttpsUrl(value);
  const records = await resolvePublicAddresses(url.hostname);
  const response = await requestOnce(url, options || {}, records);
  if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
    response.resume();
    if ((redirectCount || 0) >= 2) {
      throw new AppError("供应商重定向次数过多", { statusCode: 502, errCode: "AI_PROVIDER_REDIRECT_LIMIT" });
    }
    const target = new URL(response.headers.location, url);
    if (target.origin !== url.origin) {
      throw new AppError("供应商返回了跨域重定向，已拒绝转发凭据", {
        statusCode: 502,
        errCode: "AI_PROVIDER_REDIRECT_BLOCKED",
      });
    }
    return safeHttpsRequest(target.toString(), options, (redirectCount || 0) + 1);
  }
  return response;
}

async function readResponseText(response, limit) {
  const chunks = [];
  let total = 0;
  const max = limit || 1024 * 1024;
  for await (const chunk of response) {
    total += chunk.length;
    if (total > max) {
      response.destroy();
      throw new AppError("供应商响应过大", { statusCode: 502, errCode: "AI_PROVIDER_RESPONSE_TOO_LARGE" });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

module.exports = {
  blockedIp,
  parseHttpsUrl,
  readResponseText,
  requestOnce,
  resolvePublicAddresses,
  safeHttpsRequest,
  validateProviderBaseUrl,
};
