import { join } from "node:path";
import type { IntranetAiConfig, NativeAiChatRequest, NativeAiStreamResponse } from "@markra/app/runtime";
import { isRecord } from "@markra/shared";
import { createElectronSettings } from "./settings";

const storePath = "settings.json";
const configKey = "modelService";
const emptyConfig = { baseUrl: "", model: "", apiKey: "" };
// New agent tools need explicit approval here before the intranet request can advertise them.
const localTools = new Set([
  "batch_edit", "delete_content", "get_editor_context", "insert_content", "inspect_document_structure",
  "list_assets", "load_skill", "locate_content", "move_content", "prepare_workspace_change_plan",
  "read_document", "read_workspace_file", "replace_content", "search_document", "search_workspace",
  "validate_edit", "view_asset"
]);

function normalizeConfig(input: unknown): IntranetAiConfig {
  if (!isRecord(input) || typeof input.baseUrl !== "string" || typeof input.model !== "string" || typeof input.apiKey !== "string") {
    throw new Error("内网 AI 配置无效。");
  }
  const baseUrl = input.baseUrl.trim();
  const model = input.model.trim();
  const apiKey = input.apiKey.trim();
  if (!baseUrl && !model && !apiKey) return emptyConfig;
  const url = URL.parse(baseUrl);
  if (!url || !["http:", "https:"].includes(url.protocol) || !/^https?:\/\//i.test(baseUrl) ||
    url.username || url.password || /[?#]/.test(baseUrl)) {
    throw new Error("请输入不含账号、查询参数和片段的 HTTP(S) 服务地址。");
  }
  if (!model) throw new Error("请输入模型名称。");
  if (/[^\x21-\x7e]/.test(apiKey)) throw new Error("API Key 格式无效。");
  const prefix = url.pathname.replace(/\/+$/, "");
  url.pathname = prefix.endsWith("/v1") ? prefix : `${prefix}/v1`;
  return { baseUrl: url.href, model, apiKey };
}

export function createElectronAi(userDataPath: string) {
  // This directory is outside the renderer's generic settings store.
  const store = createElectronSettings(join(userDataPath, "intranet-ai"));
  let configuration: Promise<IntranetAiConfig> | undefined;
  const getConfig = () => configuration ??= store.get(storePath, configKey)
    .then((config) => config === undefined ? emptyConfig : normalizeConfig(config));
  let saves = Promise.resolve<unknown>(undefined);

  return {
    getConfig,
    async saveConfig(input: unknown) {
      const next = normalizeConfig(input);
      const save = saves.then(async () => {
        // Keep the last on-disk config active until this write succeeds.
        await getConfig().catch(() => undefined);
        await store.set(storePath, configKey, next);
        await store.save(storePath);
        configuration = Promise.resolve(next);
        return next;
      });
      saves = save.catch(() => undefined);
      return save;
    },
    async request(input: Pick<NativeAiChatRequest, "url" | "body">, signal: AbortSignal,
      onChunk?: (chunk: string) => unknown): Promise<NativeAiStreamResponse> {
      const { baseUrl, model, apiKey } = await getConfig();
      signal.throwIfAborted();
      if (!baseUrl || !model) throw new Error("请先在设置中配置内网 AI 服务。");
      const endpoint = `${baseUrl}/chat/completions`;
      if (input?.url !== endpoint || typeof input.body !== "string") throw new Error("请求不匹配已保存的模型服务地址。");
      let data: unknown;
      try {
        data = JSON.parse(input.body);
      } catch {
        throw new Error("内网 AI 请求格式无效。");
      }
      if (!isRecord(data) || data.model !== model || !Array.isArray(data.messages)) {
        throw new Error("请求不匹配已保存的模型或消息格式无效。");
      }
      const tools = Array.isArray(data.tools) ? data.tools.filter((tool: unknown) => isRecord(tool) &&
        tool.type === "function" && isRecord(tool.function) && typeof tool.function.name === "string" &&
        localTools.has(tool.function.name)) : [];
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({ model, messages: data.messages, stream: Boolean(onChunk), ...(tools.length ? { tools } : {}) }),
        redirect: "error",
        signal
      }).catch(() => {
        signal.throwIfAborted();
        throw new Error("无法连接已配置的内网 AI 服务，或服务返回了重定向。");
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status, body: { error: `内网 AI 服务返回 HTTP ${response.status}。` } };
      }
      if (!onChunk || !response.headers.get("content-type")?.includes("text/event-stream")) {
        const body: unknown = await response.json().catch(() => {
          signal.throwIfAborted();
          throw new Error("内网 AI 服务返回的内容格式无效。");
        });
        return { status: response.status, body };
      }
      if (!response.body) throw new Error("内网 AI 服务未返回流式内容。");
      for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
        signal.throwIfAborted();
        onChunk(chunk);
      }
      return { status: response.status };
    }
  };
}
