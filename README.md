# dsh-plugin-llm-proxy

一个 DeepSeek Harness **自定义厂商**适配器：让你把公司自建 / 私有的
OpenAI 兼容模型（chat/completions 协议）接入 DSH，并让该厂商的请求流量
**通过一个指定的 HTTP(S) 正向代理**转发。

典型场景：公司模型网关只能通过内网代理访问（`http://proxy.company.example:8080`）。

## 能力

- 注册一条 provider 路由 `openai-proxy`（显示名「OpenAI 兼容（代理）」）。
- 完整走 harness 的流式协议：文本、推理（`reasoning_content`）、工具调用、usage、finish。
- 配置项：`baseURL`（端点）、`apiKeyEnv`（可选，API Key 的环境变量名）、
  `proxy`（可选，正向代理地址）、`models`（模型目录）、
  `defaultReasoningEffort`（默认思考强度）、`streamIdleTimeoutMs`、`retryPolicy`。
- 思考强度（推理等级）：每个模型暴露 `off` / `high` / `max` 三档，可在模型选择器里
  按会话切换；新会话默认档由 `defaultReasoningEffort` 决定（不设置则跟随网关默认）。

## 安装

```bash
dsh plugin --profile web add file:./dsh-plugin-llm-proxy
```

（`dsh plugin` 会把 `dsh.profile.bundles` 里补上本包；`cordis.patch.yml` 负责把
`llm-proxy` 这一行插进组合。）

装完后**重启** `dsh web` 使新 bundle 生效。

## 配置

**推荐：在界面里配。** 装好并重启后，打开「设置」，左侧会出现一个新页面
**「公司模型（代理）」**，直接在上面填 `baseURL`、`API Key`、`代理地址`、
`默认思考强度`、`模型列表`并点保存即可，无需编辑任何配置文件。

> 兼容：以下两种 YAML 方式仍然可用（属于你自己的 patch 层 / 用户设置层，
> 升级不被覆盖；界面里填写的值最终也写进 `settings.yaml` 的 `llm-proxy` 段）：

### 方式一：写进 profile 的 `cordis.patch.yml`

编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`，在末尾追加：

```yaml
- id: llm-proxy
  config:
    baseURL: https://llm.company.example/v1      # 公司模型网关
    apiKeyEnv: COMPANY_LLM_API_KEY               # 可选；删掉则不带鉴权头
    proxy: http://proxy.company.example:8080     # 可选；正向代理地址
    defaultReasoningEffort: high                 # 可选；off | high | max（不设置则跟随网关默认）
    models:
      - id: company-model
        name: Company Model
        contextWindow: 32768
        maxTokens: 8192
```

### 方式二：写进 `$DSH_HOME/settings.yaml`

```yaml
llm-proxy:
  baseURL: https://llm.company.example/v1
  apiKeyEnv: COMPANY_LLM_API_KEY
  proxy: http://proxy.company.example:8080
  defaultReasoningEffort: high
  models:
    - id: company-model
      name: Company Model
      contextWindow: 32768
      maxTokens: 8192
```

然后在「设置 → 模型」页能看到名为「OpenAI 兼容（代理）」的厂商卡片；它属于
未知适配器族，UI 只提示「高级配置在 settings.yaml（llm-proxy）」，字段请按上面
两种方式之一填写。

## 使用

- 配置并重启后，在对话上方的模型选择器里选择 `OpenAI 兼容（代理）` →
  `Company Model` 即可；选中后可在同一选择器里切换该模型的**思考强度**
  （`Off` / `High` / `Max`）。
- API Key：把密钥写到环境变量 `COMPANY_LLM_API_KEY`，或到「设置 → 模型」卡片里
  输入（会通过 credentials 服务保存为该引用）。

## 思考强度 wire 映射

| 档位 | 发送字段 |
|---|---|
| （未设置） | 不发送 `thinking` / `reasoning_effort`，跟随网关默认 |
| `off` | `thinking: { "type": "disabled" }` |
| `high` | `thinking: { "type": "enabled" }` + `reasoning_effort: "high"` |
| `max` | `thinking: { "type": "enabled" }` + `reasoning_effort: "max"` |

- 配置了 `defaultReasoningEffort` 时，新会话默认使用该档；否则不发送思考字段，
  跟随网关默认。会话内通过模型选择器切换只影响该会话。
- 会话标题生成请求（`purpose: session-title`）固定发送 `thinking: disabled`，省 token。

## 说明 / 边界

- 代理只作用于**本插件注册的 `openai-proxy` 厂商**，不影响官方 DeepSeek 或其他厂商。
- 代理地址支持 `http://` / `https://`；如代理需要账号密码，可写成
  `http://user:pass@host:port`（undici `ProxyAgent` 原生支持）。
- 请求通过 Node 全局 `fetch` + undici `ProxyAgent` 发出（Node 的 `fetch` 不会
  自动读取 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量，这正是需要显式配置 `proxy` 的原因）。
