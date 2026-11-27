import type { ChatCompletionStreamOptions } from "@markra/ai";
import { getAppRuntime } from "../../runtime";

export type NativeAiHttpRequest = {
  headers: Record<string, string>;
  method: "GET";
  url: string;
};

export type NativeAiChatRequest = {
  body: string;
  headers: Record<string, string>;
  url: string;
};

export type NativeAiHttpResponse = {
  body: unknown;
  status: number;
};

export type NativeAiStreamResponse = {
  body?: unknown;
  status: number;
};

export function requestNativeAiJson(request: NativeAiHttpRequest): Promise<NativeAiHttpResponse> {
  return getAppRuntime().ai.requestAiJson(request);
}

export function requestNativeChat(request: NativeAiChatRequest): Promise<NativeAiHttpResponse> {
  return getAppRuntime().ai.requestChat(request);
}

export function requestNativeChatStream(
  request: NativeAiChatRequest,
  onChunk: (chunk: string) => unknown,
  signal?: AbortSignal
): Promise<NativeAiStreamResponse> {
  return getAppRuntime().ai.requestChatStream(request, onChunk, signal);
}

export function nativeChatStreamOptions(intranetSignal?: AbortSignal):
  Pick<ChatCompletionStreamOptions, "fallbackTransport" | "streamTransport" | "useVercelAiSdk"> {
  if (intranetSignal) return {
    streamTransport: (request, onChunk) => {
      intranetSignal.throwIfAborted();
      return requestNativeChatStream(request, onChunk, intranetSignal);
    }
  };
  return {
    fallbackTransport: requestNativeChat,
    streamTransport: requestNativeChatStream,
    useVercelAiSdk: true
  };
}
