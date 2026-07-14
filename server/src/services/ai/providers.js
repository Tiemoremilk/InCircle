const { AppError } = require("../../errors");
const { StringDecoder } = require("string_decoder");
const { parseHttpsUrl, readResponseText, safeHttpsRequest, validateProviderBaseUrl } = require("./network");

const PROVIDER_PRESETS = Object.freeze({
  openai: {
    key: "openai",
    name: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    privacyUrl: "https://openai.com/policies/privacy-policy/",
  },
  deepseek: {
    key: "deepseek",
    name: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    privacyUrl: "https://www.deepseek.com/zh/privacy-policy/",
  },
  moonshot: {
    key: "moonshot",
    name: "Moonshot / Kimi",
    protocol: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    privacyUrl: "https://platform.moonshot.cn/docs/privacy-policy",
  },
  zhipu: {
    key: "zhipu",
    name: "智谱 GLM",
    protocol: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    privacyUrl: "https://open.bigmodel.cn/dev/howuse/privacy",
  },
  doubao: {
    key: "doubao",
    name: "火山方舟 / 豆包",
    protocol: "openai",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    privacyUrl: "https://www.volcengine.com/docs/6256/64902",
  },
  qwen: {
    key: "qwen",
    name: "通义千问",
    protocol: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    privacyUrl: "https://terms.alicdn.com/legal-agreement/terms/privacy_policy_full/20221109181402219/20221109181402219.html",
  },
  siliconflow: {
    key: "siliconflow",
    name: "SiliconFlow",
    protocol: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
    privacyUrl: "https://siliconflow.cn/zh-cn/privacy-policy",
  },
  openrouter: {
    key: "openrouter",
    name: "OpenRouter",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    privacyUrl: "https://openrouter.ai/privacy",
  },
  anthropic: {
    key: "anthropic",
    name: "Anthropic Claude",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    privacyUrl: "https://www.anthropic.com/legal/privacy",
  },
  gemini: {
    key: "gemini",
    name: "Google Gemini",
    protocol: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    privacyUrl: "https://policies.google.com/privacy",
  },
  azure: {
    key: "azure",
    name: "Azure OpenAI",
    protocol: "azure",
    baseUrl: "",
    privacyUrl: "https://privacy.microsoft.com/privacystatement",
    constrainedCustomUrl: true,
  },
  custom: {
    key: "custom",
    name: "自定义兼容服务",
    protocol: "openai",
    baseUrl: "",
    privacyUrl: "",
    superAdminOnly: true,
  },
});

const PROVIDER_PRESENTATION = Object.freeze({
  openai: { shortName: "OA", description: "OpenAI 官方模型与兼容接口" },
  deepseek: { shortName: "DS", description: "DeepSeek 对话与推理模型" },
  moonshot: { shortName: "KM", description: "Kimi 长文本与通用对话模型" },
  zhipu: { shortName: "GL", description: "智谱 GLM 系列模型" },
  doubao: { shortName: "DB", description: "火山方舟豆包与推理模型" },
  qwen: { shortName: "QW", description: "阿里云通义千问兼容接口" },
  siliconflow: { shortName: "SF", description: "多模型聚合与推理服务" },
  openrouter: { shortName: "OR", description: "海外多模型聚合接口" },
  anthropic: { shortName: "CL", description: "Anthropic Claude 系列模型" },
  gemini: { shortName: "GM", description: "Google Gemini 系列模型" },
  azure: { shortName: "AZ", description: "Azure 托管的 OpenAI 部署" },
  custom: { shortName: "API", description: "自定义兼容协议与服务地址" },
});

function listProviderPresets(isSuperAdmin) {
  return Object.values(PROVIDER_PRESETS)
    .filter((preset) => isSuperAdmin || !preset.superAdminOnly)
    .map((preset) => {
      const presentation = PROVIDER_PRESENTATION[preset.key] || {};
      return {
        key: preset.key,
        name: preset.name,
        shortName: presentation.shortName || "AI",
        description: presentation.description || "AI 模型服务",
        protocol: preset.protocol,
        baseUrl: preset.baseUrl,
        privacyUrl: preset.privacyUrl,
        requiresBaseUrl: !preset.baseUrl,
        supportsModelSync: preset.protocol !== "azure",
      };
    });
}

function normalizeProtocol(value) {
  const protocol = String(value || "").trim().toLowerCase();
  if (!["openai", "anthropic", "gemini", "azure"].includes(protocol)) {
    throw new AppError("暂不支持这个供应商协议", { statusCode: 400, errCode: "AI_PROTOCOL_UNSUPPORTED" });
  }
  return protocol;
}

function httpsPrivacyUrl(value) {
  const source = String(value || "").trim();
  if (!source) throw new AppError("请填写供应商隐私政策地址", { statusCode: 400, errCode: "AI_PRIVACY_URL_REQUIRED" });
  try {
    return parseHttpsUrl(source).toString();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("隐私政策地址格式不正确", { statusCode: 400, errCode: "AI_PRIVACY_URL_INVALID" });
  }
}

async function normalizeProviderDraft(input, isSuperAdmin) {
  const draft = input && typeof input === "object" ? input : {};
  const presetKey = String(draft.presetKey || "openai").trim().toLowerCase();
  const preset = PROVIDER_PRESETS[presetKey];
  if (!preset || (preset.superAdminOnly && !isSuperAdmin)) {
    throw new AppError("无权使用这个供应商配置", { statusCode: 403, errCode: "AI_PROVIDER_PRESET_FORBIDDEN" });
  }
  const protocol = presetKey === "custom" ? normalizeProtocol(draft.protocol || "openai") : preset.protocol;
  const rawBaseUrl = preset.baseUrl || String(draft.baseUrl || "").trim();
  if (presetKey === "azure" && !/^https:\/\/[a-z0-9-]+\.openai\.azure\.com\/?$/i.test(rawBaseUrl)) {
    throw new AppError("Azure 地址应为 https://资源名.openai.azure.com", {
      statusCode: 400,
      errCode: "AI_AZURE_URL_INVALID",
    });
  }
  const baseUrl = await validateProviderBaseUrl(rawBaseUrl);
  const privacyUrl = httpsPrivacyUrl(draft.privacyUrl || preset.privacyUrl);
  const name = String(draft.name || preset.name).trim().slice(0, 60) || preset.name;
  return {
    presetKey,
    protocol,
    name,
    baseUrl,
    privacyUrl,
    apiVersion: protocol === "azure" ? String(draft.apiVersion || "2024-10-21").trim().slice(0, 40) : "",
    azureDeployment: protocol === "azure" ? String(draft.azureDeployment || "").trim().slice(0, 120) : "",
    isCustom: presetKey === "custom",
  };
}

function joinUrl(baseUrl, suffix) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}/${String(suffix || "").replace(/^\/+/, "")}`;
}

function providerHeaders(provider, apiKey) {
  if (provider.protocol === "anthropic") {
    return {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
  }
  if (provider.protocol === "gemini") {
    return { "content-type": "application/json", "x-goog-api-key": apiKey };
  }
  if (provider.protocol === "azure") {
    return { "content-type": "application/json", "api-key": apiKey };
  }
  return { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
}

function providerStreamHeaders(provider, apiKey) {
  return Object.assign({}, providerHeaders(provider, apiKey), {
    accept: "text/event-stream",
    "cache-control": "no-cache",
  });
}

function normalizeProviderStreamError(error, signal) {
  if (error instanceof AppError) return error;
  if (signal && signal.aborted) return error;
  if (error && (error.errCode === "AI_PROVIDER_TIMEOUT" || error.code === "AI_PROVIDER_TIMEOUT" || error.code === "ETIMEDOUT")) {
    return new AppError("AI 供应商响应超时，请稍后重试", {
      statusCode: 504,
      errCode: "AI_PROVIDER_TIMEOUT",
    });
  }
  if (error && (error.name === "AbortError" || error.code === "ECONNRESET" || error.code === "EPIPE")) {
    return new AppError("AI 供应商的流式连接中断，请稍后重试", {
      statusCode: 502,
      errCode: "AI_PROVIDER_STREAM_DISCONNECTED",
    });
  }
  return new AppError("AI 供应商连接异常，请稍后重试", {
    statusCode: 502,
    errCode: "AI_PROVIDER_CONNECTION_FAILED",
  });
}

async function providerHttpsRequest(url, options) {
  try {
    return await safeHttpsRequest(url, options);
  } catch (error) {
    throw normalizeProviderStreamError(error, options && options.signal);
  }
}

const REASONING_ADAPTER_ALIASES = Object.freeze({
  "reasoning-effort": "openai-effort",
  reasoning_effort: "openai-effort",
  openai: "openai-effort",
  "openai-effort": "openai-effort",
  thinking: "thinking-object",
  thinking_object: "thinking-object",
  "thinking-object": "thinking-object",
  enable_thinking: "enable-thinking",
  "enable-thinking": "enable-thinking",
  chat_template_kwargs: "chat-template-thinking",
  "chat-template-thinking": "chat-template-thinking",
  reasoning: "openrouter-reasoning",
  openrouter: "openrouter-reasoning",
  "openrouter-reasoning": "openrouter-reasoning",
  anthropic: "anthropic-thinking",
  "anthropic-thinking": "anthropic-thinking",
  gemini: "gemini-budget",
  thinking_config: "gemini-budget",
  "gemini-budget": "gemini-budget",
});

const FIXED_REASONING_MODEL_PATTERNS = Object.freeze([
  /(?:^|[/_.-])deepseek-(?:reasoner|r1)(?:$|[/_.-])/,
  /(?:^|[/_.-])(?:qwq|qvq)(?:$|[/_.-])/,
  /(?:^|[/_.-])qwen(?:2\.5|3(?:\.\d+)?)[^/]*(?:thinking|reasoning)(?:$|[/_.-])/,
  /(?:^|[/_.-])glm-(?:z1|zero)(?:$|[/_.-])/,
  /(?:^|[/_.-])kimi-(?:k1(?:\.5)?|thinking)(?:$|[/_.-])/,
  /(?:^|[/_.-])kimi[^/]*(?:thinking|reasoning)(?:$|[/_.-])/,
  /(?:^|[/_.-])(?:doubao|seed)[^/]*(?:thinking|reasoning)(?:$|[/_.-])/,
  /(?:^|[/_.-])(?:o1|o3|o4)(?:$|[-_.])/,
  /(?:^|[/_.-])(?:magistral|minimax-m[12]|step-3|hunyuan-t1|ernie-x1|baichuan-m1)(?:$|[/_.-])/,
  /(?:^|[/_.-])(?:phi-4-reasoning|command-a-reasoning|sonar-reasoning|sonar-deep-research)(?:$|[/_.-])/,
  /(?:^|[/_.-])(?:grok-(?:3-mini|4)|gpt-oss)(?:$|[/_.-])/,
]);

const NON_REASONING_MODEL_PATTERNS = Object.freeze([
  /(?:^|[/_.-])(?:non|no)[-_.]?(?:thinking|reasoning)(?:$|[/_.-])/,
  /(?:^|[/_.-])deepseek-(?:chat|coder)(?:$|[/_.-])/,
  /(?:^|[/_.-])qwen3(?:\.\d+)?[^/]*(?:instruct|nonthinking)(?:$|[/_.-])/,
  /(?:^|[/_.-])kimi-k2[^/]*instruct(?:$|[/_.-])/,
]);

function capability(control, adapter, defaultEnabled) {
  return {
    control,
    adapter: adapter || "none",
    defaultEnabled: typeof defaultEnabled === "boolean" ? defaultEnabled : control !== "none",
    toggleable: control === "toggle",
  };
}

function normalizedModelIdentity(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[:@]/g, "-")
    .replace(/\s+/g, "-");
}

function matchesModel(patterns, modelId) {
  return patterns.some((pattern) => pattern.test(modelId));
}

function parsedMetadata(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function normalizedStringList(value) {
  const source = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : [];
  return source
    .map((item) => String(item && typeof item === "object" ? item.name || item.id || item.key || "" : item || "").trim().toLowerCase().slice(0, 120))
    .filter(Boolean);
}

function normalizedReasoningControl(value) {
  const source = String(value || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (["toggle", "switch", "switchable", "hybrid", "optional"].includes(source)) return "toggle";
  if (["always", "fixed", "required", "reasoning-only", "thinking-only"].includes(source)) return "always";
  if (["none", "unsupported", "disabled", "no"].includes(source)) return "none";
  if (["prompt", "auto", "unknown"].includes(source)) return "prompt";
  return "";
}

function normalizedReasoningAdapter(value) {
  const source = String(value || "").trim().toLowerCase();
  return REASONING_ADAPTER_ALIASES[source] || "";
}

function booleanMetadata(values) {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (value === 1 || value === "1" || String(value).toLowerCase() === "true") return true;
    if (value === 0 || value === "0" || String(value).toLowerCase() === "false") return false;
  }
  return undefined;
}

function providerFamily(provider, model) {
  const source = provider || {};
  const target = model || {};
  const protocol = String(source.protocol || source.provider_protocol || target.protocol || target.provider_protocol || "openai").toLowerCase();
  const presetKey = String(source.preset_key || source.provider_preset_key || target.preset_key || target.provider_preset_key || "").toLowerCase();
  if (protocol === "anthropic" || protocol === "gemini" || protocol === "azure") return protocol;
  if (presetKey && presetKey !== "custom") return presetKey;
  const baseUrl = String(source.base_url || source.provider_base_url || target.base_url || target.provider_base_url || "").toLowerCase();
  if (/openrouter\.ai/.test(baseUrl)) return "openrouter";
  if (/api\.deepseek\.com/.test(baseUrl)) return "deepseek";
  if (/moonshot\.(?:cn|ai)/.test(baseUrl)) return "moonshot";
  if (/bigmodel\.cn|api\.z\.ai/.test(baseUrl)) return "zhipu";
  if (/volces\.com|volcengine\.com/.test(baseUrl)) return "doubao";
  if (/dashscope(?:-intl)?\.aliyuncs\.com/.test(baseUrl)) return "qwen";
  if (/siliconflow\.(?:cn|com)/.test(baseUrl)) return "siliconflow";
  if (/api\.openai\.com/.test(baseUrl)) return "openai";
  return presetKey || "custom";
}

function metadataReasoningCapability(provider, model) {
  const source = provider || {};
  const target = model || {};
  const metadata = Object.assign({}, parsedMetadata(source.metadata), parsedMetadata(target.metadata));
  const nested = parsedMetadata(metadata.capabilities);
  const control = normalizedReasoningControl(
    metadata.reasoningControl || metadata.reasoning_control || nested.reasoningControl || nested.reasoning_control
  );
  const adapter = normalizedReasoningAdapter(
    metadata.reasoningAdapter || metadata.reasoning_adapter || nested.reasoningAdapter || nested.reasoning_adapter
  );
  const parameters = new Set(normalizedStringList(
    metadata.supportedParameters || metadata.supported_parameters || nested.supportedParameters || nested.supported_parameters
  ));
  const parameterAdapter = parameters.has("reasoning_effort") || parameters.has("reasoning-effort")
    ? "openai-effort"
    : parameters.has("enable_thinking") || parameters.has("enable-thinking")
      ? "enable-thinking"
      : parameters.has("chat_template_kwargs")
        ? "chat-template-thinking"
        : parameters.has("thinking") || parameters.has("thinking_config")
          ? "thinking-object"
          : parameters.has("reasoning") || parameters.has("include_reasoning")
            ? "openrouter-reasoning"
            : "";
  const supported = booleanMetadata([
    metadata.supportsReasoning, metadata.supports_reasoning, metadata.reasoningSupported, metadata.reasoning_supported,
    metadata.supportsThinking, metadata.supports_thinking, nested.supportsReasoning, nested.supports_reasoning,
    nested.reasoning, nested.thinking,
  ]);
  if (control === "none" || supported === false) return capability("none", "none", false);
  if (control === "always") return capability("always", "fixed", true);
  if (control === "toggle" && (adapter || parameterAdapter)) return capability("toggle", adapter || parameterAdapter, true);
  if (adapter || parameterAdapter) return capability("toggle", adapter || parameterAdapter, true);
  return null;
}

function reasoningCapability(provider, model) {
  const source = provider || {};
  const target = model || {};
  const protocol = String(source.protocol || source.provider_protocol || target.protocol || target.provider_protocol || "openai").toLowerCase();
  const family = providerFamily(source, target);
  const modelId = normalizedModelIdentity(target.model_id || target.modelId || "");

  // Explicit non-thinking variants win over broad family names such as qwen3 or kimi-k2.
  if (matchesModel(NON_REASONING_MODEL_PATTERNS, modelId)) return capability("none", "none", false);
  // Separate reasoning endpoints cannot truthfully expose an off option.
  if (matchesModel(FIXED_REASONING_MODEL_PATTERNS, modelId)) return capability("always", "fixed", true);

  if (protocol === "anthropic") {
    return /claude-(?:3[-_.]?7|(?:sonnet|opus|haiku)[-_.]?[4-9]|[4-9](?:$|[-_.]))/.test(modelId)
      ? capability("toggle", "anthropic-thinking", true)
      : capability("prompt", "prompt", true);
  }

  if (protocol === "gemini") {
    if (/gemini-(?:2\.5|2-5)-flash(?:-lite)?/.test(modelId)) {
      return capability("toggle", "gemini-budget", true);
    }
    if (/gemini-(?:2\.5|2-5)-pro|gemini-3/.test(modelId)) {
      return capability("always", "fixed", true);
    }
    return capability("none", "none", false);
  }

  const metadataCapability = metadataReasoningCapability(source, target);
  if (metadataCapability) return metadataCapability;

  if (family === "deepseek") {
    if (/(?:^|[/_.-])deepseek-v(?:3[-_.]?[1-9]|4)(?:$|[/_.-])/.test(modelId)) {
      return capability("toggle", "thinking-object", true);
    }
    return capability("prompt", "prompt", true);
  }

  if (family === "zhipu" || /(?:^|[/_.-])glm-(?:4[-_.]?[5-9]|[5-9])/.test(modelId)) {
    return capability("toggle", "thinking-object", true);
  }

  // Ark deployment IDs are often opaque ep-* values, so the provider preset is the
  // reliable signal. Unsupported legacy endpoints are retried without this parameter.
  if (family === "doubao" || /(?:^|[/_.-])(?:doubao|seed)[-_.]/.test(modelId)) {
    return capability("toggle", "thinking-object", true);
  }

  if (family === "moonshot") {
    if (/kimi-k2(?:[-_.]\d+)*|kimi-latest/.test(modelId)) return capability("toggle", "thinking-object", true);
    return capability("none", "none", false);
  }

  if (family === "qwen") {
    return /(?:^|[/_.-])qwen3(?:\.\d+)?(?:$|[/_.-])/.test(modelId) || /qwen-(?:plus|max|turbo)-latest/.test(modelId)
      ? capability("toggle", "enable-thinking", true)
      : capability("none", "none", false);
  }

  if (family === "siliconflow") {
    if (/(?:^|[/_.-])qwen3(?:\.\d+)?(?:$|[/_.-])/.test(modelId)) return capability("toggle", "enable-thinking", true);
    return capability("prompt", "prompt", true);
  }

  if (family === "openrouter") return capability("toggle", "openrouter-reasoning", true);

  if (family === "openai" || family === "azure") {
    if (/(?:^|[/_.-])gpt-5\.[1-9](?:$|[-_.])/.test(modelId)) return capability("toggle", "openai-effort", true);
    if (/(?:^|[/_.-])gpt-5(?:$|[-_.])/.test(modelId)) return capability("always", "fixed", true);
    return capability("none", "none", false);
  }

  // OpenAI-compatible aggregators commonly preserve the upstream controls for these
  // model families. Unknown IDs remain auto-only so we never advertise a fake switch.
  if (/(?:^|[/_.-])qwen3(?:\.\d+)?(?:$|[/_.-])/.test(modelId)) return capability("toggle", "enable-thinking", true);
  if (/(?:^|[/_.-])glm-(?:4[-_.]?[5-9]|[5-9])/.test(modelId)) return capability("toggle", "thinking-object", true);
  if (/(?:^|[/_.-])deepseek-v(?:3[-_.]?[1-9]|4)(?:$|[/_.-])/.test(modelId)) return capability("toggle", "thinking-object", true);
  if (/(?:^|[/_.-])(?:doubao|seed)[-_.]/.test(modelId)) return capability("toggle", "thinking-object", true);
  const inferredCompatibleReasoning = /(?:^|[/_.-])(?:gpt-5\.[1-9]|gemini-(?:2\.5|3)|claude[^/]*(?:3[-_.]?7|(?:sonnet|opus|haiku)[-_.]?[4-9])|kimi-k2(?:[-_.]\d+)*|kimi-latest|mimo-v2)(?:$|[/_.-])/;
  if (family === "custom" && inferredCompatibleReasoning.test(modelId)) {
    return capability("toggle", "openai-effort", true);
  }
  return capability("prompt", "prompt", true);
}

function normalizeReasoningMode(value) {
  const source = String(value || "").trim().toLowerCase();
  if (["auto", "on", "off"].includes(source)) return source;
  if (value === true) return "on";
  if (value === false) return "off";
  return "auto";
}

function resolveReasoningMode(provider, model, requestedMode) {
  const capability = reasoningCapability(provider, model);
  const selection = normalizeReasoningMode(requestedMode);
  let enabled = selection !== "off";
  let supported = true;
  if (capability.control === "always") {
    enabled = true;
    supported = selection !== "off";
  } else if (capability.control === "none") {
    enabled = false;
    supported = selection !== "on";
  } else if (capability.control === "prompt") {
    enabled = true;
    supported = selection === "auto";
  }
  return Object.assign({}, capability, {
    selection,
    enabled,
    supported,
    explicit: selection !== "auto",
  });
}

function applyReasoningMode(body, mode, maxTokens, allowParameter) {
  if (
    !allowParameter || !mode || !mode.supported || !mode.toggleable ||
    mode.adapter === "prompt" || mode.selection === "auto"
  ) return false;
  const enabled = mode.selection === "on";
  if (mode.adapter === "thinking-object") {
    body.thinking = { type: enabled ? "enabled" : "disabled" };
    return true;
  }
  if (mode.adapter === "enable-thinking") {
    body.enable_thinking = enabled;
    return true;
  }
  if (mode.adapter === "chat-template-thinking") {
    body.chat_template_kwargs = Object.assign({}, body.chat_template_kwargs, { enable_thinking: enabled });
    return true;
  }
  if (mode.adapter === "openrouter-reasoning") {
    body.reasoning = { enabled };
    if (enabled) body.include_reasoning = true;
    return true;
  }
  if (mode.adapter === "openai-effort") {
    body.reasoning_effort = enabled ? "medium" : "none";
    return true;
  }
  if (mode.adapter === "anthropic-thinking") {
    if (enabled) {
      const outputLimit = Math.max(1152, Number(maxTokens || 2048));
      const budgetTokens = Math.max(1024, Math.min(2048, Math.floor(outputLimit / 2)));
      body.max_tokens = outputLimit;
      body.thinking = { type: "enabled", budget_tokens: budgetTokens };
    }
    return enabled;
  }
  if (mode.adapter === "gemini-budget") {
    body.generationConfig = Object.assign({}, body.generationConfig, {
      thinkingConfig: {
        thinkingBudget: enabled ? Math.max(128, Math.min(2048, Number(maxTokens || 2048))) : 0,
        includeThoughts: enabled,
      },
    });
    return true;
  }
  return false;
}

function completionRequest(provider, model, apiKey, messages, systemPrompt, maxTokens, options) {
  const headers = providerStreamHeaders(provider, apiKey);
  const modelId = String(model.model_id || "");
  const requestOptions = options || {};
  const reasoningMode = resolveReasoningMode(provider, model, requestOptions.reasoningMode);
  const allowReasoningParameter = requestOptions.allowReasoningParameter !== false;
  const tokenLimit = /^(?:o1|o3|o4|gpt-5)(?:\b|[-_.])/i.test(modelId)
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
  if (provider.protocol === "anthropic") {
    const request = {
      url: joinUrl(provider.base_url, "/v1/messages"),
      headers,
      body: {
        model: model.model_id,
        system: systemPrompt,
        messages: messages.map((message) => ({ role: message.role, content: message.content })),
        max_tokens: maxTokens,
        stream: true,
      },
    };
    request.reasoningMode = reasoningMode;
    request.reasoningParameterApplied = applyReasoningMode(request.body, reasoningMode, maxTokens, allowReasoningParameter);
    return request;
  }
  if (provider.protocol === "gemini") {
    const request = {
      url: `${joinUrl(provider.base_url, `/models/${encodeURIComponent(model.model_id)}:streamGenerateContent`)}?alt=sse`,
      headers,
      body: {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: messages.map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          parts: [{ text: message.content }],
        })),
        generationConfig: { maxOutputTokens: maxTokens },
      },
    };
    request.reasoningMode = reasoningMode;
    request.reasoningParameterApplied = applyReasoningMode(request.body, reasoningMode, maxTokens, allowReasoningParameter);
    return request;
  }
  if (provider.protocol === "azure") {
    const deployment = provider.azure_deployment || model.model_id;
    const version = encodeURIComponent(provider.api_version || "2024-10-21");
    const request = {
      url: `${joinUrl(provider.base_url, `/openai/deployments/${encodeURIComponent(deployment)}/chat/completions`)}?api-version=${version}`,
      headers,
      body: {
        messages: [{ role: "system", content: systemPrompt }].concat(messages),
        stream: true,
        ...tokenLimit,
      },
    };
    request.reasoningMode = reasoningMode;
    request.reasoningParameterApplied = applyReasoningMode(request.body, reasoningMode, maxTokens, allowReasoningParameter);
    return request;
  }
  const request = {
    url: joinUrl(provider.base_url, "/chat/completions"),
    headers,
    body: {
      model: modelId,
      messages: [{ role: "system", content: systemPrompt }].concat(messages),
      stream: true,
      ...tokenLimit,
    },
  };
  request.reasoningMode = reasoningMode;
  request.reasoningParameterApplied = applyReasoningMode(request.body, reasoningMode, maxTokens, allowReasoningParameter);
  return request;
}

function isReasoningPart(value) {
  if (!value || typeof value !== "object") return false;
  return value.thought === true || /reason|thinking|analysis/.test(String(value.type || value.channel || "").toLowerCase());
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      if (isReasoningPart(item)) return "";
      return contentText(item.text || item.content || item.output_text || "");
    }).join("");
  }
  if (value && typeof value === "object") {
    if (isReasoningPart(value)) return "";
    return contentText(value.text || value.content || value.output_text || "");
  }
  return "";
}

function reasoningText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(reasoningText).join("");
  if (!value || typeof value !== "object") return "";
  const type = String(value.type || "").toLowerCase();
  if (/signature|encrypted/.test(type)) return "";
  return reasoningText(
    value.text || value.content || value.reasoning_content || value.reasoning ||
    value.thinking || value.analysis || value.summary || ""
  );
}

function embeddedReasoningText(value) {
  if (Array.isArray(value)) {
    return value.filter(isReasoningPart).map(reasoningText).join("");
  }
  return isReasoningPart(value) ? reasoningText(value) : "";
}

function firstReasoningText(values) {
  for (const value of values) {
    const text = reasoningText(value);
    if (text) return text;
  }
  return "";
}

function jsonDelta(protocol, payload) {
  if (!payload || typeof payload !== "object") return { text: "", reasoning: "" };
  if (protocol === "anthropic") {
    const delta = payload.delta || {};
    const blocks = Array.isArray(payload.content) ? payload.content : [];
    const startedBlock = payload.content_block || {};
    return {
      text: payload.type === "content_block_delta" && delta.type !== "thinking_delta"
        ? contentText(delta.text || delta.content)
        : blocks.filter((block) => block && block.type !== "thinking").map(contentText).join(""),
      reasoning: payload.type === "content_block_delta" && (delta.type === "thinking_delta" || delta.thinking)
        ? reasoningText(delta.thinking || delta.text)
        : payload.type === "content_block_start" && startedBlock.type === "thinking"
          ? reasoningText(startedBlock.thinking || startedBlock.text)
          : blocks.filter((block) => block && block.type === "thinking").map(reasoningText).join(""),
      usage: payload.usage || (payload.message && payload.message.usage) || null,
    };
  }
  if (protocol === "gemini") {
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    const parts = candidates[0] && candidates[0].content && Array.isArray(candidates[0].content.parts) ? candidates[0].content.parts : [];
    return {
      text: parts.filter((part) => part && part.thought !== true).map((part) => contentText(part.text)).join(""),
      reasoning: parts.filter((part) => part && part.thought === true).map((part) => reasoningText(part.text)).join(""),
      usage: payload.usageMetadata || null,
    };
  }
  const eventType = String(payload.type || "").toLowerCase();
  if (eventType === "response.output_text.delta") {
    return { text: contentText(payload.delta), reasoning: "", usage: payload.usage || null };
  }
  if (/^response\.reasoning(?:_[a-z_]+)?\.delta$/.test(eventType)) {
    return { text: "", reasoning: reasoningText(payload.delta), usage: payload.usage || null };
  }
  const source = payload.data && typeof payload.data === "object" ? payload.data : payload;
  const choices = Array.isArray(source.choices) ? source.choices : [];
  const first = choices[0] || {};
  const message = first.delta || first.message || {};
  const reasoningChannel = /reason|thinking|analysis/.test(String(message.channel || message.type || "").toLowerCase());
  return {
    text: reasoningChannel ? "" : contentText(message.content || message.output_text || source.output_text || ""),
    reasoning: firstReasoningText([
      message.reasoning_content,
      message.reasoning,
      message.thinking,
      message.analysis,
      message.reasoning_details,
      first.reasoning_content,
      first.reasoning,
      first.thinking,
      first.reasoning_details,
      source.reasoning_content,
      source.reasoning,
      source.thinking,
      source.reasoning_details,
      reasoningChannel ? message.content || message.output_text : "",
      embeddedReasoningText(message.content),
    ]),
    usage: source.usage || payload.usage || null,
  };
}

function normalizedUsage(protocol, value) {
  const usage = value || {};
  if (protocol === "gemini") {
    return {
      inputTokens: Number(usage.promptTokenCount || 0),
      outputTokens: Number(usage.candidatesTokenCount || 0),
    };
  }
  return {
    inputTokens: Number(usage.input_tokens || usage.prompt_tokens || 0),
    outputTokens: Number(usage.output_tokens || usage.completion_tokens || 0),
  };
}

function providerStreamDone(protocol, payload) {
  if (!payload || typeof payload !== "object") return false;
  if (protocol === "anthropic") return payload.type === "message_stop";
  if (protocol === "gemini") {
    return (Array.isArray(payload.candidates) ? payload.candidates : []).some((candidate) => !!candidate.finishReason);
  }
  if (["response.completed", "response.incomplete", "response.failed"].includes(String(payload.type || "").toLowerCase())) return true;
  const source = payload.data && typeof payload.data === "object" ? payload.data : payload;
  return (Array.isArray(source.choices) ? source.choices : []).some(
    (choice) => choice && choice.finish_reason !== null && typeof choice.finish_reason !== "undefined"
  );
}

function providerFinishReason(protocol, payload) {
  if (!payload || typeof payload !== "object") return "";
  if (protocol === "anthropic") {
    return String(
      (payload.delta && payload.delta.stop_reason) ||
      (payload.message && payload.message.stop_reason) ||
      payload.stop_reason || ""
    );
  }
  if (protocol === "gemini") {
    const candidate = (Array.isArray(payload.candidates) ? payload.candidates : []).find(
      (item) => item && item.finishReason
    );
    return String((candidate && candidate.finishReason) || "");
  }
  const eventType = String(payload.type || "").toLowerCase();
  if (eventType === "response.incomplete") {
    return String((payload.incomplete_details && payload.incomplete_details.reason) || "incomplete");
  }
  if (eventType === "response.failed") return "failed";
  const source = payload.data && typeof payload.data === "object" ? payload.data : payload;
  const choice = (Array.isArray(source.choices) ? source.choices : []).find(
    (item) => item && item.finish_reason !== null && typeof item.finish_reason !== "undefined"
  );
  return String((choice && choice.finish_reason) || "");
}

async function consumeEventStream(response, protocol, onDelta, stats, onReasoning) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let usage = { inputTokens: 0, outputTokens: 0 };
  const metrics = stats || {};
  const rawChunks = [];
  let rawBytes = 0;
  const consumePayload = async (payload) => {
    metrics.events = Number(metrics.events || 0) + 1;
    if (payload && payload.error) {
      throw new AppError("AI 供应商返回了错误，请稍后重试", {
        statusCode: 502,
        errCode: "AI_PROVIDER_RESPONSE_ERROR",
        details: { providerErrorCode: String(payload.error.code || payload.error.type || "").slice(0, 80) },
      });
    }
    const delta = jsonDelta(protocol, payload);
    if ((delta.text || delta.reasoning) && !metrics.firstDeltaAt) metrics.firstDeltaAt = Date.now();
    const finishReason = providerFinishReason(protocol, payload);
    const done = providerStreamDone(protocol, payload);
    if (delta.text || delta.reasoning || delta.usage || done) {
      metrics.recognizedEvents = Number(metrics.recognizedEvents || 0) + 1;
    }
    if (delta.usage) usage = normalizedUsage(protocol, delta.usage);
    if (finishReason) metrics.finishReason = finishReason.slice(0, 120);
    if (delta.reasoning) {
      metrics.reasoningDeltas = Number(metrics.reasoningDeltas || 0) + 1;
      if (typeof onReasoning === "function") await onReasoning(delta.reasoning);
    }
    if (delta.text) {
      metrics.textDeltas = Number(metrics.textDeltas || 0) + 1;
      await onDelta(delta.text);
    }
    if (done) {
      metrics.doneSeen = true;
      return true;
    }
    return false;
  };
  const consumeLine = async (line) => {
    const value = String(line || "").trim();
    if (!value || value.startsWith(":")) return;
    let data = "";
    if (/^data\s*:/i.test(value)) data = value.replace(/^data\s*:/i, "").trim();
    else if (value.startsWith("{") || value.startsWith("[")) data = value;
    else return;
    if (!data) return;
    if (data === "[DONE]") {
      metrics.doneSeen = true;
      return true;
    }
    let payload;
    try {
      payload = JSON.parse(data);
    } catch (error) {
      metrics.parseErrors = Number(metrics.parseErrors || 0) + 1;
      return;
    }
    return consumePayload(payload);
  };
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    metrics.networkChunks = Number(metrics.networkChunks || 0) + 1;
    if (!metrics.firstChunkAt) metrics.firstChunkAt = Date.now();
    metrics.responseBytes = Number(metrics.responseBytes || 0) + buffer.length;
    if (rawBytes + buffer.length <= 4 * 1024 * 1024) {
      rawChunks.push(buffer);
      rawBytes += buffer.length;
    }
    pending += decoder.write(buffer);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || "";
    for (const line of lines) {
      if (await consumeLine(line)) return usage;
    }
  }
  pending += decoder.end();
  for (const line of pending.split(/\r?\n/)) {
    if (await consumeLine(line)) return usage;
  }
  if (!metrics.recognizedEvents && rawChunks.length) {
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(rawChunks).toString("utf8"));
    } catch (error) {
      payload = null;
    }
    const payloads = Array.isArray(payload) ? payload : payload ? [payload] : [];
    for (const item of payloads) {
      if (await consumePayload(item)) break;
    }
  }
  return usage;
}

async function providerError(response) {
  const statusCode = Number(response.statusCode || 502);
  response.resume();
  let code = "AI_PROVIDER_FAILED";
  if (statusCode === 401 || statusCode === 403) code = "AI_PROVIDER_AUTH_FAILED";
  else if (statusCode === 404) code = "AI_MODEL_NOT_FOUND";
  else if (statusCode === 429) code = "AI_PROVIDER_RATE_LIMITED";
  throw new AppError(
    code === "AI_PROVIDER_AUTH_FAILED" ? "供应商拒绝了 API Key，请检查配置" :
      code === "AI_MODEL_NOT_FOUND" ? "供应商没有找到这个模型" :
        code === "AI_PROVIDER_RATE_LIMITED" ? "供应商请求过于频繁，请稍后再试" : "AI 供应商暂时不可用",
    { statusCode: 502, errCode: code, details: { providerStatus: statusCode } }
  );
}

async function streamProviderCompletion(options) {
  try {
    const stats = options.stats || {};
    const requestArgs = [
      options.provider,
      options.model,
      options.apiKey,
      options.messages,
      options.systemPrompt,
      options.maxTokens,
    ];
    let request = completionRequest(...requestArgs, { reasoningMode: options.reasoningMode });
    let response = await providerHttpsRequest(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    stats.statusCode = Number(response.statusCode || 0);
    stats.reasoningControl = request.reasoningMode.control;
    stats.reasoningEnabled = request.reasoningMode.enabled;
    stats.reasoningMode = request.reasoningMode.selection;
    if ([400, 422].includes(Number(response.statusCode)) && request.reasoningParameterApplied) {
      // Several OpenAI-compatible gateways lag behind their upstream reasoning fields.
      // A parameter rejection is safe to retry because no generation has started yet.
      await readResponseText(response, 128 * 1024);
      stats.reasoningParameterFallback = true;
      request = completionRequest(...requestArgs, {
        reasoningMode: options.reasoningMode,
        allowReasoningParameter: false,
      });
      response = await providerHttpsRequest(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
      stats.statusCode = Number(response.statusCode || 0);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) return providerError(response);
    const contentType = String(response.headers["content-type"] || "").toLowerCase();
    stats.contentType = contentType.slice(0, 120);
    return await consumeEventStream(response, options.provider.protocol, options.onDelta, stats, options.onReasoning);
  } catch (error) {
    throw normalizeProviderStreamError(error, options.signal);
  }
}

function providerModelMetadata(item) {
  const source = item && typeof item === "object" ? item : {};
  const rawCapabilities = source.capabilities || source.features || source.supported_features;
  const reasoningCapabilityValue = rawCapabilities && typeof rawCapabilities === "object" && !Array.isArray(rawCapabilities)
    ? Object.prototype.hasOwnProperty.call(rawCapabilities, "reasoning")
      ? rawCapabilities.reasoning
      : rawCapabilities.thinking
    : undefined;
  const reasoningDescriptor = reasoningCapabilityValue && typeof reasoningCapabilityValue === "object"
    ? reasoningCapabilityValue
    : {};
  const capabilityNames = Array.isArray(rawCapabilities)
    ? normalizedStringList(rawCapabilities)
    : rawCapabilities && typeof rawCapabilities === "object"
      ? Object.keys(rawCapabilities).filter((key) => {
        const value = rawCapabilities[key];
        return value === true || (value && typeof value === "object" && value.supported !== false);
      }).map((key) => key.toLowerCase().slice(0, 120))
      : [];
  const supportedParameters = normalizedStringList(
    source.supported_parameters || source.supportedParameters || source.parameters ||
    reasoningDescriptor.supported_parameters || reasoningDescriptor.supportedParameters || reasoningDescriptor.parameters
  );
  const supportsReasoning = booleanMetadata([
    source.supports_reasoning, source.supportsReasoning, source.reasoning_supported, source.reasoningSupported,
    source.supports_thinking, source.supportsThinking, reasoningCapabilityValue,
    reasoningDescriptor.supported, reasoningDescriptor.enabled,
  ]);
  const reasoningControl = normalizedReasoningControl(
    source.reasoning_control || source.reasoningControl || reasoningDescriptor.control || reasoningDescriptor.mode
  );
  const reasoningAdapter = normalizedReasoningAdapter(
    source.reasoning_adapter || source.reasoningAdapter || reasoningDescriptor.adapter || reasoningDescriptor.parameter
  );
  const metadata = {};
  if (supportedParameters.length) metadata.supportedParameters = Array.from(new Set(supportedParameters)).slice(0, 80);
  if (capabilityNames.length) metadata.capabilities = Array.from(new Set(capabilityNames)).slice(0, 80);
  if (typeof supportsReasoning === "boolean") metadata.supportsReasoning = supportsReasoning;
  else if (capabilityNames.some((name) => /reason|thinking/.test(name))) metadata.supportsReasoning = true;
  if (reasoningControl) metadata.reasoningControl = reasoningControl;
  if (reasoningAdapter) metadata.reasoningAdapter = reasoningAdapter;
  return metadata;
}

async function listProviderModels(provider, apiKey, options) {
  if (provider.protocol === "azure") {
    throw new AppError("Azure OpenAI 请手动添加部署名称", {
      statusCode: 400,
      errCode: "AI_MODEL_SYNC_UNSUPPORTED",
    });
  }
  const suffix = provider.protocol === "anthropic" ? "/v1/models" : "/models";
  const response = await providerHttpsRequest(joinUrl(provider.base_url, suffix), {
    method: "GET",
    headers: providerHeaders(provider, apiKey),
    signal: options && options.signal,
    timeoutMs: (options && options.timeoutMs) || 20000,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) return providerError(response);
  const text = await readResponseText(response, 4 * 1024 * 1024);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new AppError("模型列表格式无法识别", { statusCode: 502, errCode: "AI_MODEL_LIST_INVALID" });
  }
  const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
  return rows
    .map((item) => {
      const rawId = String((item && (item.id || item.name)) || "").replace(/^models\//, "").trim();
      return rawId ? {
        modelId: rawId,
        displayName: String(item.displayName || item.display_name || rawId).slice(0, 120),
        contextWindow: Number(item.context_window || item.inputTokenLimit || 0),
        metadata: providerModelMetadata(item),
      } : null;
    })
    .filter(Boolean)
    .slice(0, 500);
}

module.exports = {
  PROVIDER_PRESETS,
  completionRequest,
  consumeEventStream,
  jsonDelta,
  listProviderModels,
  listProviderPresets,
  normalizeProviderStreamError,
  normalizeReasoningMode,
  normalizedUsage,
  normalizeProviderDraft,
  providerModelMetadata,
  providerFinishReason,
  reasoningCapability,
  resolveReasoningMode,
  streamProviderCompletion,
};
