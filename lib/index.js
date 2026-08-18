// dsh-plugin-llm-proxy — 一个带 HTTP(S) 代理支持的自定义厂商 LLM 适配器。
//
// 它注册一条固定的 provider 路由 `openai-proxy`，用 OpenAI 兼容的
// chat/completions 协议与私有 / 公司模型网关通信。请求通过全局 `fetch`
// 发出；当配置了 `proxy` 时，适配器用 undici 的 `ProxyAgent` 作为
// dispatcher，把该厂商的请求流量转发到指定的 HTTP(S) 正向代理
// （`http://host:port`）。
//
// 配置（cordis.patch.yml / settings.yaml 里的 `llm-proxy` 段）：
//   baseURL:  https://llm.company.example/v1   # 公司模型网关
//   apiKeyEnv: COMPANY_LLM_API_KEY             # 可选；留空则不带鉴权头
//   proxy:    http://proxy.company.example:8080 # 可选；正向代理地址
//   defaultReasoningEffort: high                # 可选；off | high | max（默认 high）
//   models:                                    # 公司模型目录（至少一个）
//     - id: company-model
//       name: Company Model
//       contextWindow: 32768
//       maxTokens: 8192
//
// 思考强度映射（DeepSeek V4 官方风格）：
//   off  → thinking: { type: "disabled" }
//   high → thinking: { type: "enabled" }, reasoning_effort: "high"
//   max  → thinking: { type: "enabled" }, reasoning_effort: "max"
//
// @module dsh-plugin-llm-proxy

import z from "@deepseek-ai/schemastery";
import { ProxyAgent } from "undici";
import { EventSourceParserStream } from "eventsource-parser/stream";
import {
  CallId,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  QUOTA_EXCEEDED_CODE,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  RetryPolicySchema,
  assertUsableApiKey,
  attributionHeaders,
  contentHasImage,
  isContextWindowExceededError,
  isQuotaExceededError,
  resolveRetryPolicy,
} from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { deepEqualJson, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";

const name = "llm-proxy";
const inject = ["llm"];
const NS = settingsNamespace("llm-proxy");
const PROVIDER = "openai-proxy";
const DISPLAY_NAME = "OpenAI 兼容（代理）";

const DEFAULT_CONTEXT_WINDOW = 32768;
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
const DEFAULT_REASONING_EFFORT = "high";

// 思考强度（推理等级）：与 DeepSeek V4 官方 wire 对齐。
// off  → thinking: {type:"disabled"}
// high → thinking: {type:"enabled"} + reasoning_effort: "high"
// max  → thinking: {type:"enabled"} + reasoning_effort: "max"
const OFF_REASONING_EFFORT = ReasoningEffortId("off");
const HIGH_REASONING_EFFORT = ReasoningEffortId("high");
const MAX_REASONING_EFFORT = ReasoningEffortId("max");
const REASONING_EFFORTS = [
  { id: OFF_REASONING_EFFORT, name: "Off" },
  { id: HIGH_REASONING_EFFORT, name: "High" },
  { id: MAX_REASONING_EFFORT, name: "Max" },
];

// ── 序列化：harness 消息 → OpenAI chat/completions ─────────────────────────

/** 把消息里的 text 块拼成一个字符串（用于 user / tool-result 内容）。 */
function flattenText(blocks) {
  return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}

/** 明确拒绝图片内容，避免被文本扁平化路径悄悄吞掉。 */
function assertTextOnly(blocks) {
  if (contentHasImage(blocks)) {
    throw new LlmError("The llm-proxy adapter does not support image content.", "UNSUPPORTED_CONTENT");
  }
}

/** 序列化一条 assistant 消息（文本 + 推理 + 工具调用）。 */
function serializeAssistant(message) {
  const text = flattenText(message.content);
  const reasoning = message.content
    .filter((block) => block.type === "reasoning")
    .map((block) => block.text)
    .join("");
  const toolCalls = message.content
    .filter((block) => block.type === "tool-call")
    .map((block) => ({
      id: block.id,
      type: "function",
      function: { name: block.name, arguments: block.arguments },
    }));
  return {
    role: "assistant",
    content: text,
    ...(toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

/** 序列化对话历史；tool-result 展开为独立的 `{role: 'tool'}` 消息。 */
function serializeMessages(messages) {
  const wire = [];
  for (const message of messages) {
    assertTextOnly(message.content);
    if (message.role === "system") {
      wire.push({ role: "system", content: flattenText(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      wire.push(serializeAssistant(message));
      continue;
    }
    const toolResults = message.content.filter((block) => block.type === "tool-result");
    const text = flattenText(message.content);
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: "user", content: text });
    }
    for (const result of toolResults) {
      wire.push({
        role: "tool",
        tool_call_id: result.toolCallId,
        content: flattenText(result.content) || "(no output)",
      });
    }
  }
  return wire;
}

/** 把 adapter 拥有的思考强度解析为 DeepSeek wire 字段（off 不落到 reasoning_effort）。 */
function resolveThinking(options, defaults = {}) {
  if (options.purpose === "session-title") return { thinking: "disabled" };
  const effort = options.reasoningEffort === void 0 ? defaults.reasoningEffort : options.reasoningEffort;
  if (effort === "off") return { thinking: "disabled" };
  if (effort === "high" || effort === "max") return { thinking: "enabled", reasoningEffort: effort };
  if (effort === void 0) return {};
  throw new LlmError(`llm-proxy does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
}

/** 组装 wire 请求体。始终流式；可选字段省略而非传 null。 */
function serializeRequest(options, defaults = {}) {
  const messages = [];
  if (options.system !== void 0) {
    messages.push({ role: "system", content: options.system });
  }
  messages.push(...serializeMessages(options.messages));
  const tools = options.tools?.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
  const resolvedThinking = resolveThinking(options, defaults);
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(resolvedThinking.thinking !== void 0 ? { thinking: { type: resolvedThinking.thinking } } : {}),
    ...(resolvedThinking.reasoningEffort !== void 0 ? { reasoning_effort: resolvedThinking.reasoningEffort } : {}),
    ...(tools !== void 0 && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== void 0 ? { temperature: options.temperature } : {}),
    ...(options.maxTokens === void 0 ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop !== void 0 ? { stop: options.stop } : {}),
  };
}

// ── SSE 解析与翻译 ──────────────────────────────────────────────────────────

/** 把 SSE 字节流解析为 data 载荷，`[DONE]` 作为最后一个值。 */
async function* parseSse(stream, onComment) {
  const events = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ onComment }));
  for await (const { data } of events) {
    yield data;
    if (data === "[DONE]") return;
  }
  throw new LlmError("SSE stream ended without [DONE]", "STREAM_CLOSED");
}

/** wire finish_reason → harness FinishReason。 */
function mapFinishReason(reason) {
  switch (reason) {
    case "stop": return { kind: "stop" };
    case "tool_calls": return { kind: "tool-calls" };
    case "length": return { kind: "max-tokens" };
    default:
      return { kind: "error", failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } };
  }
}

/** wire usage → harness TokenUsage（缓存命中从 inputTokens 中减出，保证互斥）。 */
function mapUsage(usage) {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...(cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== void 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/** 为某个打开的块组装最终 ContentBlock。 */
function closeBlock(block) {
  switch (block.kind) {
    case "text":
      return { type: "text", text: block.text };
    case "reasoning":
      return { type: "reasoning", text: block.text };
    case "tool-call":
      return { type: "tool-call", id: CallId(block.callId ?? ""), name: block.name ?? "", arguments: block.text };
  }
}

/** 消费 SSE data 载荷，产出 StreamChunk。 */
async function* translate(payloads) {
  let nextIndex = 0;
  let textBlock;
  let reasoningBlock;
  const toolBlocks = new Map();
  const order = [];
  let pendingFinish;
  let pendingUsage;

  function open(kind) {
    const block = { index: nextIndex++, kind, text: "" };
    order.push(block);
    return block;
  }

  for await (const payload of payloads) {
    if (payload === "[DONE]") {
      for (const block of order) {
        yield { type: "block-end", index: block.index, block: closeBlock(block) };
      }
      if (pendingUsage) yield { type: "usage", usage: pendingUsage };
      const reason = pendingFinish ?? { kind: "stop" };
      yield {
        type: "finish",
        reason:
          reason.kind === "stop" && order.length === 0
            ? { kind: "error", failure: { message: "model returned a completed response with no content", code: EMPTY_RESPONSE_CODE } }
            : reason,
      };
      return;
    }

    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;

      const reasoning = delta?.reasoning_content;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open("reasoning");
          yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
        }
        reasoningBlock.text += reasoning;
        yield { type: "reasoning-delta", index: reasoningBlock.index, text: reasoning };
      }

      const content = delta?.content;
      if (typeof content === "string" && content.length > 0) {
        if (!textBlock) {
          textBlock = open("text");
          yield { type: "block-start", index: textBlock.index, blockType: "text" };
        }
        textBlock.text += content;
        yield { type: "text-delta", index: textBlock.index, text: content };
      }

      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index);
        if (!block) {
          block = open("tool-call");
          toolBlocks.set(call.index, block);
          yield { type: "block-start", index: block.index, blockType: "tool-call" };
        }
        if (call.id !== void 0) block.callId = call.id;
        if (call.function?.name !== void 0) block.name = call.function.name;
        const fragment = call.function?.arguments ?? "";
        block.text += fragment;
        yield {
          type: "tool-call-delta",
          index: block.index,
          id: CallId(block.callId ?? ""),
          ...(block.name !== void 0 ? { name: block.name } : {}),
          argumentsDelta: fragment,
        };
      }

      if (typeof choice.finish_reason === "string") pendingFinish = mapFinishReason(choice.finish_reason);
    }
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
  }

  throw new LlmError("SSE payload stream ended without [DONE]", "STREAM_CLOSED");
}

/** HTTP 状态码 → 稳定 LlmError code。 */
function httpErrorCode(status, error) {
  if (status === 401 || status === 403) return "AUTH";
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(" ");
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
  if (status === 429) return "RATE_LIMIT";
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
    return "INVALID_REQUEST";
  }
  if (status >= 500) return "SERVER";
  return `HTTP_${status}`;
}

// ── 配置 schema 与解析 ──────────────────────────────────────────────────────

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
});

const Config = z.object({
  baseURL: z.string().default(""),
  apiKeyEnv: z.string().role("credential-ref"),
  proxy: z.string().default(""),
  models: z.array(catalogModel).default([]),
  defaultReasoningEffort: z.union(["off", "high", "max"]).default(DEFAULT_REASONING_EFFORT),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
});

/** 校验并规范化代理地址：空 → undefined；否则必须是 http(s) URL。 */
function resolveProxy(raw) {
  const value = raw === void 0 ? "" : String(raw).trim();
  if (value === "") return undefined;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`llm-proxy: proxy must be a valid URL like http://host:port, got ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`llm-proxy: proxy must use http:// or https:// (got ${parsed.protocol}//)`);
  }
  return value;
}

function resolveModels(models) {
  const seen = new Set();
  return (models ?? []).map((model) => {
    if (model.id.length === 0) throw new Error("llm-proxy: catalog model ids must be non-empty");
    if (seen.has(model.id)) throw new Error(`llm-proxy: duplicate catalog model "${model.id}"`);
    seen.add(model.id);
    return {
      id: model.id,
      ...(model.name === void 0 ? {} : { name: model.name }),
      ...(model.description === void 0 ? {} : { description: model.description }),
      ...(model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens }),
    };
  });
}

function resolveAdapterOptions(config) {
  const baseURL = (config.baseURL ?? "").trim().replace(/\/+$/, "");
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error("llm-proxy: streamIdleTimeoutMs must be a positive finite number no greater than " + MAX_TIMER_DELAY_MS);
  }
  return {
    baseURL,
    apiKeyEnv: config.apiKeyEnv === void 0 ? undefined : credentialRef(config.apiKeyEnv),
    proxy: resolveProxy(config.proxy),
    models: resolveModels(config.models),
    defaultReasoningEffort: config.defaultReasoningEffort ?? DEFAULT_REASONING_EFFORT,
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, "llm-proxy: retryPolicy"),
  };
}

function modelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...(model.description === void 0 ? {} : { description: model.description }),
    inputModalities: ["text"],
  };
}

// ── 适配器 ─────────────────────────────────────────────────────────────────

class OpenAIProxyAdapter extends LlmAdapter {
  constructor(config) {
    super();
    this.config = config;
  }

  providerInfo(provider) {
    return { id: provider, name: DISPLAY_NAME };
  }

  providerRetryPolicy() {
    return this.config.options().retryPolicy;
  }

  listModels(provider) {
    return Promise.resolve(this.config.options().models.map((model) => modelInfo(provider, model)));
  }

  resolveModel(provider, model) {
    const connection = this.config.options();
    const configured = connection.models.find((entry) => entry.id === model);
    const contextWindow = configured?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const defaultEffort = connection.defaultReasoningEffort ?? DEFAULT_REASONING_EFFORT;
    return Promise.resolve({
      ...(configured === void 0
        ? { provider, id: model, name: model, inputModalities: ["text"] }
        : modelInfo(provider, configured)),
      context: { contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? DEFAULT_MAX_TOKENS,
      reasoning: {
        efforts: REASONING_EFFORTS,
        defaultEffort:
          defaultEffort === "off" ? OFF_REASONING_EFFORT
          : defaultEffort === "max" ? MAX_REASONING_EFFORT
          : HIGH_REASONING_EFFORT,
      },
    });
  }

  async *stream(options) {
    const connection = this.config.options();
    if (connection.baseURL === "") {
      throw new LlmError(
        `llm-proxy: baseURL is not configured for provider route "${PROVIDER}"; set it under the llm-proxy settings section (or cordis.patch.yml)`,
        "MISSING_CONFIGURATION",
      );
    }
    const apiKey = await this.config.resolveApiKey(connection);
    const consumer = new AbortController();
    const signal = options.signal === void 0 ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
    const watchdog = idleWatchdog(signal, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE);
    const iterator = this.request(options, watchdog.signal, connection, apiKey, () => watchdog.pulse())[Symbol.asyncIterator]();

    let exhausted = false;
    try {
      while (true) {
        const result = await watchdog.next(iterator);
        if (result.done) {
          exhausted = true;
          return;
        }
        yield result.value;
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== void 0) {
        throw new LlmError(`llm-proxy: stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
      }
      if (options.signal?.aborted) {
        throw new LlmError("llm-proxy: request aborted by caller", "ABORTED", { cause: error });
      }
      if (error instanceof LlmError) throw error;
      throw new LlmError(`llm-proxy: API stream from ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
    } finally {
      consumer.abort("llm-proxy stream consumer stopped");
      watchdog[Symbol.dispose]();
      if (!exhausted && iterator.return !== void 0) {
        try {
          await iterator.return();
        } catch (_abortedTransportTeardown) {}
      }
    }
  }

  async *request(options, signal, connection, apiKey, onComment) {
    const body = serializeRequest(options, { reasoningEffort: connection.defaultReasoningEffort ?? DEFAULT_REASONING_EFFORT });
    const payload = JSON.stringify(body);
    const headers = {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...attributionHeaders(),
      ...(apiKey !== void 0 ? { authorization: `Bearer ${apiKey}` } : {}),
      ...(options.sessionId !== void 0 ? { "x-harness-session-id": String(options.sessionId) } : {}),
    };
    const dispatcher = this.config.dispatcher(connection);

    let response;
    try {
      response = await fetch(`${connection.baseURL}/chat/completions`, {
        method: "POST",
        headers,
        body: payload,
        signal,
        ...(dispatcher !== void 0 ? { dispatcher } : {}),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new LlmError(`llm-proxy: request to ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
    }

    if (!response.ok) {
      let message = `llm-proxy: API error (HTTP ${response.status})`;
      let providerError;
      try {
        providerError = (await response.json()).error;
        if (providerError?.message) message = providerError.message;
      } catch {}
      throw new LlmError(message, httpErrorCode(response.status, providerError), { status: response.status });
    }
    if (!response.body) throw new LlmError("llm-proxy: API returned no response body", "EMPTY_RESPONSE");
    yield* translate(parseSse(response.body, onComment));
  }
}

// ── 连接 / 模型检测（host RPC） ────────────────────────────────────────────

/** 为一次检测调用构建临时 ProxyAgent；代理非法则抛错。 */
function testProxyDispatcher(rawProxy) {
  const url = resolveProxy(rawProxy);
  return url === undefined ? undefined : new ProxyAgent(url);
}

/** 组装一个 RpcResult 错误分支；details 必须匹配该 code 在 RpcErrorDetailsMap 里的形状。 */
function rpcError(code, message, details) {
  return { ok: false, error: { code, message, details: details ?? {} } };
}

/** 归一化 /models 返回的模型列表（兼容 data/models 字段或裸数组）。 */
function normalizeModels(list) {
  const source = Array.isArray(list) ? list : Array.isArray(list?.data) ? list.data : Array.isArray(list?.models) ? list.models : [];
  const out = [];
  for (const entry of source) {
    if (entry === null || typeof entry !== "object") continue;
    const id = entry.id ?? entry.name ?? entry.model;
    if (id === undefined || id === null) continue;
    out.push({
      id: String(id),
      name: String(entry.name ?? entry.display_name ?? id),
    });
  }
  return out;
}

/** GET {baseURL}/models 拉取模型列表（用做“检测连接”）。网络不可达抛普通 Error；HTTP 非 2xx 抛带 `status` 的 Error。 */
async function fetchModelsList(baseURL, apiKey, dispatcher, signal) {
  const headers = {
    accept: "application/json",
    ...attributionHeaders(),
    ...(apiKey !== undefined && apiKey.length > 0 ? { authorization: `Bearer ${apiKey}` } : {}),
  };
  let response;
  try {
    response = await fetch(`${baseURL}/models`, {
      method: "GET",
      headers,
      signal,
      ...(dispatcher !== undefined ? { dispatcher } : {}),
    });
  } catch (error) {
    const cause = error?.cause?.message ?? error?.message ?? String(error);
    throw new Error(`could not reach ${baseURL}: ${cause}`);
  }
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    const text = await response.text().catch(() => "");
    if (text.trim()) {
      try {
        const body = JSON.parse(text);
        const msg = body?.error?.message ?? body?.message ?? body?.detail ?? body?.error;
        if (typeof msg === "string" && msg.trim()) detail = msg.trim();
      } catch {
        if (text.trim().length <= 200) detail = text.trim();
      }
    }
    const err = new Error(detail);
    err.status = response.status;
    throw err;
  }
  return normalizeModels(await response.json());
}

/** 发一条最小 chat/completions 请求，返回首个文本片段（用做“检测模型”）。 */
async function fetchModelSample(baseURL, model, apiKey, dispatcher, signal) {
  const headers = {
    "content-type": "application/json",
    ...attributionHeaders(),
    ...(apiKey !== undefined && apiKey.length > 0 ? { authorization: `Bearer ${apiKey}` } : {}),
  };
  const body = {
    model,
    messages: [{ role: "user", content: "ping" }],
    stream: false,
    max_tokens: 16,
  };
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
    ...(dispatcher !== undefined ? { dispatcher } : {}),
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const parsed = await response.json();
      if (parsed?.error?.message) detail = parsed.error.message;
    } catch {}
    throw new Error(detail);
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : content == null ? "" : String(content);
}

/**
 * 在 host 侧注册一条 `/llm-proxy` 逻辑 RPC 通道，供设置页调用：
 *   - testConnection → 检测 baseURL + API Key（+ 可选代理）能否通信，并返回模型列表
 *   - testModel       → 用指定模型发一条最小补全请求
 */
function registerTestRpc(ctx) {
  ctx.inject(["connection"], (connectionCtx) => {
    const handler = async (endpoint, payload, signal) => {
      try {
        if (endpoint === "testConnection") {
          const baseURL = String(payload?.baseURL ?? "").trim().replace(/\/+$/, "");
          if (baseURL === "") return rpcError("bad-request", "baseURL 不能为空", { issues: [] });
          let dispatcher;
          try {
            dispatcher = testProxyDispatcher(payload?.proxy);
          } catch (error) {
            return rpcError("bad-request", String(error?.message ?? error), { issues: [] });
          }
          try {
            const models = await fetchModelsList(baseURL, payload?.apiKey, dispatcher, signal);
            return { ok: true, value: { models } };
          } catch (error) {
            if (typeof error?.status === "number") {
              if (error.status === 401 || error.status === 403) {
                return rpcError("model-discovery-failed", `API Key 无效（${error.message}）`, { settingsNs: NS, baseURL });
              }
              return {
                ok: true,
                value: {
                  models: [],
                  notice: `端点可达，但该网关不提供 /models 列表（${error.message}）。请手动填写模型，或用每行模型的「检测」验证。`,
                },
              };
            }
            return rpcError("model-discovery-failed", String(error?.message ?? error), { settingsNs: NS, baseURL });
          } finally {
            dispatcher?.close().catch(() => {});
          }
        }
        if (endpoint === "testModel") {
          const baseURL = String(payload?.baseURL ?? "").trim().replace(/\/+$/, "");
          const model = String(payload?.model ?? "").trim();
          if (baseURL === "") return rpcError("bad-request", "baseURL 不能为空", { issues: [] });
          if (model === "") return rpcError("bad-request", "model 不能为空", { issues: [] });
          let dispatcher;
          try {
            dispatcher = testProxyDispatcher(payload?.proxy);
          } catch (error) {
            return rpcError("bad-request", String(error?.message ?? error), { issues: [] });
          }
          try {
            const sample = await fetchModelSample(baseURL, model, payload?.apiKey, dispatcher, signal);
            return { ok: true, value: { sample } };
          } catch (error) {
            return rpcError("model-unavailable", String(error?.message ?? error), { provider: PROVIDER, model });
          } finally {
            dispatcher?.close().catch(() => {});
          }
        }
        return rpcError("bad-request", `unknown endpoint ${JSON.stringify(endpoint)}`, { issues: [] });
      } catch (error) {
        return rpcError("internal", String(error?.message ?? error));
      }
    };
    connectionCtx.connection.rpc.handle("/llm-proxy", handler, { authority: "loopback" });
  });
}

// ── 插件入口 ───────────────────────────────────────────────────────────────

function apply(ctx, config) {
  let current = () => config;
  let lastRaw;
  let lastGood;
  let proxyAgent;
  let proxyAgentUrl;

  const options = () => {
    const raw = current();
    if (raw === lastRaw && lastGood !== void 0) return lastGood;
    try {
      const next = resolveAdapterOptions(raw);
      lastRaw = raw;
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === void 0) throw error;
      ctx.logger.error("llm-proxy: keeping the last good configuration after an invalid settings section");
      ctx.logger.error(error);
      return lastGood;
    }
  };
  options();

  // 按代理 URL 惰性构建 / 复用 undici ProxyAgent；URL 变化时重建。
  const dispatcher = (connection) => {
    const url = connection.proxy;
    if (url === undefined) return undefined;
    if (proxyAgent !== void 0 && proxyAgentUrl === url) return proxyAgent;
    proxyAgent?.close().catch(() => {});
    proxyAgent = new ProxyAgent(url);
    proxyAgentUrl = url;
    return proxyAgent;
  };

  ctx.effect(() => () => {
    proxyAgent?.close().catch(() => {});
    proxyAgent = undefined;
    proxyAgentUrl = undefined;
  }, "llm-proxy: proxy agent teardown");

  const resolveApiKey = async (connection) => {
    if (connection.apiKeyEnv === void 0) return undefined;
    const ref = connection.apiKeyEnv;
    const credentials = ctx.get("credentials");
    if (credentials !== void 0) {
      const hit = await credentials.resolve(ref);
      if (hit !== void 0 && hit.value.length > 0) return assertUsableApiKey(hit.value, "llm-proxy", ref);
    }
    const ambient = process.env[ref];
    if (ambient !== void 0 && ambient.length > 0) return assertUsableApiKey(ambient, "llm-proxy", ref);
    throw new LlmError(
      `llm-proxy: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials service or export it in the launching environment`,
      "MISSING_CREDENTIAL",
    );
  };

  const adapter = new OpenAIProxyAdapter({ options, resolveApiKey, dispatcher });

  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: DISPLAY_NAME, settingsNs: NS, settingsPath: [] },
  ]);
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
  let registeredPolicy = options().retryPolicy;

  const ensureRegistrationFacts = () => {
    const policy = options().retryPolicy;
    if (deepEqualJson(policy, registeredPolicy)) return;
    registration.replace([PROVIDER]);
    registeredPolicy = policy;
  };

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source;
    },
    onChange: ensureRegistrationFacts,
  });

  registerTestRpc(ctx);
}

export { Config, apply, inject, name };
