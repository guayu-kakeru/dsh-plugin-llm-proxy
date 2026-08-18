window.__ModuleLoader__.load({
  id: "dsh-plugin-llm-proxy",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;

    const NS = "llm-proxy";
    const DERIVED_KEY_REF = "OPENAI_PROXY_API_KEY";

    // ── 内联样式（自包含，不依赖宿主 CSS 模块） ─────────────────────────────
    const css = {
      wrap: { display: "flex", flexDirection: "column", gap: "16px", padding: "4px 0" },
      field: { display: "flex", flexDirection: "column", gap: "6px" },
      label: { fontSize: "12px", fontWeight: 600, color: "var(--color-text-secondary, #8a93a6)" },
      input: {
        boxSizing: "border-box",
        width: "100%",
        padding: "8px 10px",
        borderRadius: "8px",
        border: "1px solid var(--color-border, rgba(128,138,160,0.35))",
        background: "var(--color-bg-input, transparent)",
        color: "inherit",
        fontSize: "13px",
        outline: "none",
      },
      hint: { fontSize: "11px", color: "var(--color-text-muted, #6b7488)", lineHeight: 1.5 },
      row: { display: "flex", gap: "8px", alignItems: "center" },
      modelRow: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
      modelInput: {
        boxSizing: "border-box",
        padding: "6px 8px",
        borderRadius: "8px",
        border: "1px solid var(--color-border, rgba(128,138,160,0.35))",
        background: "var(--color-bg-input, transparent)",
        color: "inherit",
        fontSize: "12px",
        outline: "none",
      },
      button: {
        padding: "6px 12px",
        borderRadius: "8px",
        border: "1px solid var(--color-border, rgba(128,138,160,0.4))",
        background: "transparent",
        color: "inherit",
        fontSize: "12px",
        cursor: "pointer",
      },
      primary: {
        padding: "8px 16px",
        borderRadius: "8px",
        border: "none",
        background: "var(--color-accent, #3b82f6)",
        color: "#fff",
        fontSize: "13px",
        fontWeight: 600,
        cursor: "pointer",
        alignSelf: "flex-start",
      },
      danger: { color: "#f87171" },
      error: { fontSize: "12px", color: "#f87171" },
      success: { fontSize: "12px", color: "#4ade80" },
      warn: { fontSize: "12px", color: "#fbbf24" },
      title: { fontSize: "14px", fontWeight: 700 },
      sectionTitle: { fontSize: "12px", fontWeight: 700, marginTop: "4px" },
    };

    function textInput(value, onChange, placeholder) {
      return h("input", {
        style: css.input,
        type: "text",
        value,
        placeholder,
        onChange: (event) => onChange(event.target.value),
      });
    }

    /** 读取 llm-proxy 命名空间 + API Key 状态。 */
    function useProxySettings(api) {
      const [state, setState] = React.useState({
        status: "loading",
        error: null,
        view: null,
        keyConfigured: false,
        writable: true,
      });
      React.useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const [settingsResp, credResp] = await Promise.all([
              api.settings.describe({}),
              api.credentials.describe({ refs: [DERIVED_KEY_REF] }),
            ]);
            if (!alive) return;
            if (!settingsResp.result.ok) throw new Error(settingsResp.result.error.message);
            const namespaces = settingsResp.result.value.namespaces;
            const view = namespaces.find((v) => v.ns === NS) ?? null;
            const keyConfigured =
              credResp.result.ok &&
              (credResp.result.value.credentials[DERIVED_KEY_REF]?.configured ?? false);
            setState({
              status: "ready",
              error: null,
              view,
              keyConfigured,
              writable: settingsResp.result.value.writable,
            });
          } catch (err) {
            if (alive) {
              setState({
                status: "error",
                error: String(err?.message ?? err),
                view: null,
                keyConfigured: false,
                writable: true,
              });
            }
          }
        })();
        return () => {
          alive = false;
        };
      }, [api]);
      return state;
    }

    function ProxySettingsSection({ api, rpc }) {
      const loaded = useProxySettings(api);

      const [baseURL, setBaseURL] = React.useState("");
      const [proxy, setProxy] = React.useState("");
      const [keyValue, setKeyValue] = React.useState("");
      const [defaultReasoningEffort, setDefaultReasoningEffort] = React.useState("high");
      const [models, setModels] = React.useState([]);
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(null); // { kind: 'ok'|'err', text }
      const [connState, setConnState] = React.useState({ status: "idle", text: "", models: null }); // 检测连接
      const [modelTests, setModelTests] = React.useState({}); // { [index]: { status, text } }
      const [keyConfigured, setKeyConfigured] = React.useState(false);
      const hydrated = React.useRef(false);
      const revisionRef = React.useRef(undefined);

      const draftKey = String(keyValue).trim();
      const draftProxy = String(proxy).trim();
      const draftBase = String(baseURL).trim();

      React.useEffect(() => {
        if (loaded.status === "ready" && !hydrated.current) {
          hydrated.current = true;
          revisionRef.current = loaded.view?.revision;
          setKeyConfigured(Boolean(loaded.keyConfigured));
          const v = loaded.view?.value ?? {};
          setBaseURL(typeof v.baseURL === "string" ? v.baseURL : "");
          setProxy(typeof v.proxy === "string" ? v.proxy : "");
          setDefaultReasoningEffort(
            v.defaultReasoningEffort === "off" || v.defaultReasoningEffort === "max" ? v.defaultReasoningEffort : "high",
          );
          setModels(
            Array.isArray(v.models)
              ? v.models.map((m) => ({
                  id: m.id ?? "",
                  name: m.name ?? "",
                  contextWindow: m.contextWindow ?? "",
                  maxTokens: m.maxTokens ?? "",
                }))
              : [],
          );
        }
      }, [loaded.status]);

      function updateModel(index, patch) {
        setModels((list) => list.map((m, i) => (i === index ? { ...m, ...patch } : m)));
      }
      function removeModel(index) {
        setModels((list) => list.filter((_, i) => i !== index));
      }
      function addModel() {
        setModels((list) => [...list, { id: "", name: "", contextWindow: "", maxTokens: "" }]);
      }

      async function save() {
        setBusy(true);
        setNotice(null);
        try {
          const modelsWire = models
            .filter((m) => String(m.id).trim() !== "")
            .map((m) => {
              const entry = { id: String(m.id).trim() };
              if (String(m.name).trim()) entry.name = String(m.name).trim();
              if (String(m.contextWindow).trim() !== "") {
                const n = Number(m.contextWindow);
                if (Number.isFinite(n) && n > 0) entry.contextWindow = Math.floor(n);
              }
              if (String(m.maxTokens).trim() !== "") {
                const n = Number(m.maxTokens);
                if (Number.isFinite(n) && n > 0) entry.maxTokens = Math.floor(n);
              }
              return entry;
            });

          const key = String(keyValue).trim();
          const keepKey = key.length > 0 || keyConfigured;

          const section = {
            baseURL: String(baseURL).trim(),
            proxy: String(proxy).trim(),
            defaultReasoningEffort: String(defaultReasoningEffort),
            models: modelsWire,
            ...(keepKey ? { apiKeyEnv: DERIVED_KEY_REF } : {}),
          };

          const settingsResp = await api.settings.replace({
            ns: NS,
            section,
            expectedRevision: revisionRef.current,
          });
          if (!settingsResp.result.ok) throw new Error(settingsResp.result.error.message);
          revisionRef.current = settingsResp.result.value.revision;

          if (key) {
            const credResp = await api.credentials.set({ ref: DERIVED_KEY_REF, value: key });
            if (!credResp.result.ok) throw new Error(credResp.result.error.message);
            setKeyConfigured(true);
          }

          setNotice({ kind: "ok", text: "已保存。请到模型选择器选择「OpenAI 兼容（代理）」下的模型使用。" });
          setKeyValue("");
        } catch (err) {
          setNotice({ kind: "err", text: String(err?.message ?? err) });
        } finally {
          setBusy(false);
        }
      }

      async function clearKey() {
        setBusy(true);
        setNotice(null);
        try {
          const section = {
            baseURL: String(baseURL).trim(),
            proxy: String(proxy).trim(),
            defaultReasoningEffort: String(defaultReasoningEffort),
            models: models
              .filter((m) => String(m.id).trim() !== "")
              .map((m) => {
                const entry = { id: String(m.id).trim() };
                if (String(m.name).trim()) entry.name = String(m.name).trim();
                return entry;
              }),
          };
          const settingsResp = await api.settings.replace({ ns: NS, section, expectedRevision: revisionRef.current });
          if (!settingsResp.result.ok) throw new Error(settingsResp.result.error.message);
          revisionRef.current = settingsResp.result.value.revision;
          const credResp = await api.credentials.unset({ ref: DERIVED_KEY_REF });
          if (!credResp.result.ok) throw new Error(credResp.result.error.message);
          setKeyConfigured(false);
          setKeyValue("");
          setNotice({ kind: "ok", text: "已清除 API Key。" });
        } catch (err) {
          setNotice({ kind: "err", text: String(err?.message ?? err) });
        } finally {
          setBusy(false);
        }
      }

      async function testConnection() {
        if (!rpc) return;
        setConnState({ status: "running", text: "检测中…", models: null });
        try {
          const result = await rpc.call(
            "/llm-proxy",
            "testConnection",
            { baseURL: draftBase, apiKey: draftKey, proxy: draftProxy },
            AbortSignal.timeout(30000),
          );
          if (result.ok) {
            const list = Array.isArray(result.value?.models) ? result.value.models : [];
            const notice = typeof result.value?.notice === "string" ? result.value.notice : null;
            if (notice) {
              setConnState({ status: "warn", text: notice, models: list });
            } else {
              setConnState({
                status: "ok",
                text: list.length > 0 ? `连接成功，发现 ${list.length} 个模型` : "连接成功",
                models: list,
              });
            }
          } else {
            setConnState({ status: "err", text: result.error?.message ?? "连接失败", models: null });
          }
        } catch (err) {
          setConnState({ status: "err", text: String(err?.message ?? err), models: null });
        }
      }

      function adoptDiscoveredModels() {
        if (!Array.isArray(connState.models)) return;
        setModels(connState.models.map((m) => ({ id: m.id ?? "", name: m.name ?? "", contextWindow: "", maxTokens: "" })));
        setConnState((s) => ({ ...s, models: null }));
      }

      async function testModel(index) {
        if (!rpc) return;
        const model = String(models[index]?.id ?? "").trim();
        if (model === "") {
          setModelTests((t) => ({ ...t, [index]: { status: "err", text: "请先填写模型 id" } }));
          return;
        }
        setModelTests((t) => ({ ...t, [index]: { status: "running", text: "检测中…" } }));
        try {
          const result = await rpc.call(
            "/llm-proxy",
            "testModel",
            { baseURL: draftBase, apiKey: draftKey, proxy: draftProxy, model },
            AbortSignal.timeout(30000),
          );
          if (result.ok) {
            const sample = String(result.value?.sample ?? "").trim();
            setModelTests((t) => ({
              ...t,
              [index]: { status: "ok", text: sample ? `请求成功：${sample.slice(0, 80)}` : "请求成功" },
            }));
          } else {
            setModelTests((t) => ({ ...t, [index]: { status: "err", text: result.error?.message ?? "请求失败" } }));
          }
        } catch (err) {
          setModelTests((t) => ({ ...t, [index]: { status: "err", text: String(err?.message ?? err) } }));
        }
      }

      if (loaded.status === "loading") return h("div", { style: css.hint }, "加载中…");
      if (loaded.status === "error")
        return h("div", { style: css.error }, `读取配置失败：${loaded.error}`);

      const readOnly = !loaded.writable;

      return h(
        "div",
        { style: css.wrap },
        h("div", { style: css.title }, "公司模型（代理）"),
        h(
          "div",
          { style: css.hint },
          "配置一个 OpenAI 兼容的私有/公司模型端点，并可选地让请求走指定的 HTTP(S) 正向代理。保存后到模型选择器选择对应模型。",
        ),

        h(
          "div",
          { style: css.field },
          h("span", { style: css.label }, "接口地址 baseURL（必填）"),
          textInput(baseURL, setBaseURL, "https://llm.company.example/v1"),
        ),

        h(
          "div",
          { style: css.field },
          h("span", { style: css.label }, `API Key（可选${keyConfigured ? "，当前已配置" : ""}）`),
          h("input", {
            style: css.input,
            type: "password",
            autoComplete: "off",
            value: keyValue,
            placeholder: keyConfigured ? "留空则保持已保存的密钥" : "留空则不带鉴权头",
            onChange: (event) => setKeyValue(event.target.value),
          }),
          keyConfigured
            ? h("button", { style: { ...css.button, color: "#f87171", alignSelf: "flex-start" }, type: "button", disabled: busy, onClick: clearKey }, "清除密钥")
            : null,
        ),

        h(
          "div",
          { style: css.field },
          h("span", { style: css.label }, "代理地址 proxy（可选）"),
          textInput(proxy, setProxy, "http://proxy.company.example:8080"),
          h("span", { style: css.hint }, "仅对本厂商生效；留空则直连。格式 http(s)://host:port，需认证时可写 http://user:pass@host:port"),
        ),

        h(
          "div",
          { style: css.field },
          h("span", { style: css.label }, "默认思考强度"),
          h(
            "select",
            {
              style: css.input,
              value: defaultReasoningEffort,
              disabled: readOnly,
              onChange: (event) => setDefaultReasoningEffort(event.target.value),
            },
            h("option", { value: "off" }, "Off（关闭思考）"),
            h("option", { value: "high" }, "High（默认）"),
            h("option", { value: "max" }, "Max（最强）"),
          ),
          h("span", { style: css.hint }, "DeepSeek V4 风格：off 发送 thinking:{type:disabled}；high/max 发送 thinking:{type:enabled} + reasoning_effort。保存后在模型选择器里还能按会话切换。" ),
        ),

        h(
          "div",
          { style: css.field },
          h(
            "div",
            { style: css.row },
            h(
              "button",
              { style: css.button, type: "button", disabled: connState.status === "running" || readOnly, onClick: testConnection },
              connState.status === "running" ? "检测中…" : "检测连接",
            ),
            Array.isArray(connState.models) && connState.models.length > 0
              ? h("button", { style: css.button, type: "button", onClick: adoptDiscoveredModels }, "采纳发现的模型")
              : null,
          ),
          connState.status !== "idle"
            ? h(
                "div",
                { style: connState.status === "err" ? css.error : connState.status === "warn" ? css.warn : css.success },
                connState.text,
              )
            : null,
          h("span", { style: css.hint }, "用当前填写的 baseURL、API Key 与代理地址向 /models 发起请求，验证能否通信并拉取模型列表。"),
        ),

        h(
          "div",
          { style: css.field },
          h("div", { style: css.row }, h("span", { style: css.sectionTitle }, "模型列表（至少一个）")),
          ...models.map((m, i) =>
            h(
              "div",
              { key: i, style: css.modelRow },
              h("input", {
                style: { ...css.modelInput, width: "180px" },
                placeholder: "模型 id（必填）",
                value: m.id,
                onChange: (e) => updateModel(i, { id: e.target.value }),
              }),
              h("input", {
                style: { ...css.modelInput, width: "160px" },
                placeholder: "显示名",
                value: m.name,
                onChange: (e) => updateModel(i, { name: e.target.value }),
              }),
              h("input", {
                style: { ...css.modelInput, width: "110px" },
                placeholder: "上下文窗口",
                value: m.contextWindow,
                onChange: (e) => updateModel(i, { contextWindow: e.target.value }),
              }),
              h("input", {
                style: { ...css.modelInput, width: "90px" },
                placeholder: "最大输出",
                value: m.maxTokens,
                onChange: (e) => updateModel(i, { maxTokens: e.target.value }),
              }),
              h(
                "button",
                { style: css.button, type: "button", disabled: (modelTests[i]?.status === "running") || readOnly, onClick: () => testModel(i) },
                modelTests[i]?.status === "running" ? "检测中…" : "检测",
              ),
              h(
                "button",
                { style: { ...css.button, color: "#f87171" }, type: "button", onClick: () => removeModel(i) },
                "移除",
              ),
              modelTests[i]
                ? h("span", { style: modelTests[i].status === "err" ? css.error : css.success }, modelTests[i].text)
                : null,
            ),
          ),
          h("button", { style: css.button, type: "button", onClick: addModel }, "+ 添加模型"),
        ),

        notice ? h("div", { style: notice.kind === "ok" ? css.success : css.error }, notice.text) : null,
        h(
          "button",
          { style: { ...css.primary, opacity: busy || readOnly ? 0.6 : 1 }, type: "button", disabled: busy || readOnly, onClick: save },
          busy ? "保存中…" : "保存",
        ),
      );
    }

    const name = "dsh-plugin-llm-proxy";
    const inject = ["slots", "connection"];

    function apply(ctx) {
      const connection = ctx.get("connection");
      const api = connection.api;
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "llm-proxy",
            order: 20,
            label: () => "公司模型（代理）",
            inject: () => ({ api, rpc: connection.rpc }),
          },
          ProxySettingsSection,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;

    return module.exports;
  },
});
