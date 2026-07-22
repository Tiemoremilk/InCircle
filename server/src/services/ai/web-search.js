const { AppError } = require("../../errors");
const { readResponseText, safeHttpsRequest, validateProviderBaseUrl } = require("./network");

const activeByUser = new Map();

function cleanText(value, max) {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizedUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") return "";
    url.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "spm"].forEach((key) => url.searchParams.delete(key));
    return url.toString().replace(/\/$/, "");
  } catch (error) {
    return "";
  }
}

function normalizeResults(query, rows, limit) {
  const seenUrls = new Set();
  const seenTitles = new Set();
  const results = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const url = normalizedUrl(row && row.url);
    const title = cleanText(row && row.title, 240);
    const titleKey = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    if (!url || !title || !titleKey || seenUrls.has(url) || seenTitles.has(titleKey)) continue;
    let hostname = "";
    try { hostname = new URL(url).hostname.replace(/^www\./, ""); } catch (error) { continue; }
    if (/\b(ad|ads|advertisement)\b/i.test(String(row.category || ""))) continue;
    seenUrls.add(url);
    seenTitles.add(titleKey);
    results.push({
      id: "",
      query,
      title,
      url,
      snippet: cleanText(row.content || row.snippet, 800),
      source: hostname,
      publishedAt: cleanText(row.publishedDate || row.published_at, 40),
    });
    if (results.length >= limit) break;
  }
  return results;
}

class WebSearchService {
  constructor(config, options) {
    this.config = config || {};
    this.request = options && options.request;
  }

  configured() {
    return !!(this.config.searxngEnabled && this.config.searxngBaseUrl);
  }

  async validateConfiguration() {
    if (!this.configured()) return false;
    await validateProviderBaseUrl(this.config.searxngBaseUrl);
    return true;
  }

  async search(query, options) {
    const userKey = String(options && options.userKey || "anonymous");
    if ((activeByUser.get(userKey) || 0) >= 2) {
      throw new AppError("搜索请求过于频繁，请稍后再试", { statusCode: 429, errCode: "WEB_SEARCH_RATE_LIMITED" });
    }
    activeByUser.set(userKey, (activeByUser.get(userKey) || 0) + 1);
    try {
      const endpoint = new URL(`${this.config.searxngBaseUrl}/search`);
      endpoint.searchParams.set("q", cleanText(query, 300));
      endpoint.searchParams.set("format", "json");
      endpoint.searchParams.set("language", this.config.searxngLanguage || "zh-CN");
      endpoint.searchParams.set("safesearch", String(this.config.searxngSafesearch || 1));
      let lastError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = this.request
            ? await this.request(endpoint, { timeoutMs: this.config.searxngTimeoutMs })
            : await safeHttpsRequest(endpoint.toString(), {
              method: "GET",
              timeoutMs: this.config.searxngTimeoutMs,
              headers: { accept: "application/json", "user-agent": "InCircle-WebSearch/1.0" },
              signal: options && options.signal,
            });
          if (response.statusCode !== 200) {
            if (response.resume) response.resume();
            throw new AppError("搜索服务返回异常", { statusCode: 502, errCode: "WEB_SEARCH_UPSTREAM_ERROR" });
          }
          const text = typeof response.body === "string" ? response.body : await readResponseText(response, 1024 * 1024);
          let payload;
          try { payload = JSON.parse(text); } catch (error) {
            throw new AppError("搜索服务返回格式异常", { statusCode: 502, errCode: "WEB_SEARCH_INVALID_RESPONSE" });
          }
          return normalizeResults(cleanText(query, 300), payload.results, this.config.searxngMaxResultsPerQuery || 8);
        } catch (error) {
          lastError = error;
          if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }
      throw lastError;
    } finally {
      const next = Math.max(0, (activeByUser.get(userKey) || 1) - 1);
      if (next) activeByUser.set(userKey, next); else activeByUser.delete(userKey);
    }
  }
}

module.exports = { WebSearchService, normalizeResults, normalizedUrl };
