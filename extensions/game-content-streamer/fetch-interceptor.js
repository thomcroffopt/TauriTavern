/**
 * @file fetch-interceptor.js
 * 网络层 Fetch 拦截器与 SSE 流式转换管道
 * 
 * 拦截 chat-completions 请求，实时将 tool_calls 中的 game_content 参数提取并伪装为 delta.content。
 */

import { StreamingContentExtractor } from './streaming-content-extractor.js';

/**
 * 默认配置
 */
export const DEFAULT_CONFIG = {
    enabled: true,
    targetFunctions: ['game_content', 'game content'],
    targetParam: 'content',
    consumeToolCalls: true,
};

export class GameContentInterceptor {
    /**
     * @param {object} [initialConfig]
     */
    constructor(initialConfig = {}) {
        this.config = { ...DEFAULT_CONFIG, ...initialConfig };
        this.originalFetch = null;
        this.isHooked = false;
    }

    /**
     * 更新运行时配置
     * @param {Partial<typeof DEFAULT_CONFIG>} newConfig
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
    }

    /**
     * 安装拦截钩子
     */
    install() {
        if (this.isHooked || typeof window === 'undefined') {
            return;
        }

        this.originalFetch = window.fetch;
        const self = this;

        window.fetch = async function (...args) {
            const [resource] = args;
            const url = typeof resource === 'string'
                ? resource
                : (resource && resource.url ? resource.url : '');

            // 仅对聊天补全接口实施探测与拦截
            const isChatCompletions = url.includes('/api/backends/chat-completions/generate')
                || url.includes('/chat/completions')
                || url.includes('/generate');

            if (!self.config.enabled || !isChatCompletions) {
                return self.originalFetch.apply(this, args);
            }

            const response = await self.originalFetch.apply(this, args);

            // 失败或无正文的响应不作修改
            if (!response.ok || !response.body) {
                return response;
            }

            const contentType = response.headers.get('content-type') || '';

            // 情况一：SSE 流式响应
            if (contentType.includes('text/event-stream')) {
                return self.wrapEventStreamResponse(response);
            }

            // 情况二：普通非流式 JSON 响应
            if (contentType.includes('application/json')) {
                return self.wrapJsonResponse(response);
            }

            return response;
        };

        this.isHooked = true;
        console.log('[GameContentInterceptor] 拦截器已成功激活');
    }

    /**
     * 卸载拦截钩子，恢复原生 fetch
     */
    uninstall() {
        if (!this.isHooked || !this.originalFetch) {
            return;
        }
        window.fetch = this.originalFetch;
        this.originalFetch = null;
        this.isHooked = false;
        console.log('[GameContentInterceptor] 拦截器已卸载');
    }

    /**
     * 检查函数名是否属于目标函数
     * @param {string} name
     * @returns {boolean}
     */
    isTargetFunction(name) {
        if (!name) return false;
        const normalized = name.trim().toLowerCase();
        return this.config.targetFunctions.some(target => target.trim().toLowerCase() === normalized);
    }

    /**
     * 包装 SSE 流式响应
     * @param {Response} originalResponse
     * @returns {Response}
     */
    wrapEventStreamResponse(originalResponse) {
        const self = this;
        const extractorMap = new Map(); // key: callIndex/callId, value: StreamingContentExtractor
        const targetCallIndices = new Set();
        let streamHasTargetCalls = false;
        let utf8Remainder = '';

        const textDecoder = new TextDecoder('utf-8');
        const textEncoder = new TextEncoder();

        const transformStream = new TransformStream({
            transform(chunk, controller) {
                // 将二进制 chunk 转为文本，并结合上一次未切分的尾部
                const text = utf8Remainder + textDecoder.decode(chunk, { stream: true });
                const lines = text.split(/\r?\n/);
                utf8Remainder = lines.pop() || ''; // 最后一个可能是不完整行，留存

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:')) {
                        // 其它 SSE 行（例如 event:、id:、注释或空行）原样传递
                        controller.enqueue(textEncoder.encode(line + '\n'));
                        continue;
                    }

                    const rawData = trimmed.slice(5).trim();
                    if (rawData === '[DONE]') {
                        // 刷新所有 extractor
                        for (const extractor of extractorMap.values()) {
                            extractor.flush();
                        }
                        controller.enqueue(textEncoder.encode(line + '\n'));
                        continue;
                    }

                    let parsed;
                    try {
                        parsed = JSON.parse(rawData);
                    } catch {
                        // 非标准 JSON，原样放行
                        controller.enqueue(textEncoder.encode(line + '\n'));
                        continue;
                    }

                    let mutated = false;
                    const choice = parsed.choices?.[0];
                    const delta = choice?.delta;

                    if (delta && Array.isArray(delta.tool_calls)) {
                        const remainingToolCalls = [];

                        for (let i = 0; i < delta.tool_calls.length; i++) {
                            const tc = delta.tool_calls[i];
                            const callIndex = typeof tc.index === 'number' ? tc.index : i;
                            const funcName = tc.function?.name;

                            if (funcName && self.isTargetFunction(funcName)) {
                                targetCallIndices.add(callIndex);
                                streamHasTargetCalls = true;
                            }

                            if (targetCallIndices.has(callIndex)) {
                                streamHasTargetCalls = true;
                                mutated = true;
                                if (!extractorMap.has(callIndex)) {
                                    extractorMap.set(callIndex, new StreamingContentExtractor({
                                        targetParam: self.config.targetParam,
                                    }));
                                }

                                const extractor = extractorMap.get(callIndex);
                                const argsDelta = tc.function?.arguments || '';
                                const extractedText = extractor.feed(argsDelta);

                                if (extractedText) {
                                    delta.content = (delta.content || '') + extractedText;
                                }

                                // 若启用消费 tool_calls，则不保留进当前 chunk 的 tool_calls
                                if (!self.config.consumeToolCalls) {
                                    remainingToolCalls.push(tc);
                                }
                            } else {
                                remainingToolCalls.push(tc);
                            }
                        }

                        if (self.config.consumeToolCalls) {
                            if (remainingToolCalls.length > 0) {
                                delta.tool_calls = remainingToolCalls;
                            } else {
                                delete delta.tool_calls;
                            }
                        }
                    }

                    // 如果该流已经被认定为包含 target tool_calls 且消费掉了，将 finish_reason 设为 stop
                    if (streamHasTargetCalls && self.config.consumeToolCalls && choice?.finish_reason === 'tool_calls') {
                        choice.finish_reason = 'stop';
                        mutated = true;
                    }

                    if (mutated) {
                        const newLine = `data: ${JSON.stringify(parsed)}\n`;
                        controller.enqueue(textEncoder.encode(newLine));
                    } else {
                        controller.enqueue(textEncoder.encode(line + '\n'));
                    }
                }
            },
            flush(controller) {
                if (utf8Remainder) {
                    controller.enqueue(textEncoder.encode(utf8Remainder));
                    utf8Remainder = '';
                }
            }
        });

        const newStream = originalResponse.body.pipeThrough(transformStream);
        return new Response(newStream, {
            status: originalResponse.status,
            statusText: originalResponse.statusText,
            headers: originalResponse.headers,
        });
    }

    /**
     * 包装非流式 JSON 响应
     * @param {Response} originalResponse
     * @returns {Promise<Response>}
     */
    async wrapJsonResponse(originalResponse) {
        let json;
        try {
            json = await originalResponse.json();
        } catch {
            return originalResponse;
        }

        const choice = json.choices?.[0];
        const message = choice?.message;

        if (message && Array.isArray(message.tool_calls)) {
            const remainingToolCalls = [];
            let extractedCombined = '';

            for (const tc of message.tool_calls) {
                const funcName = tc.function?.name;
                if (this.isTargetFunction(funcName)) {
                    let parsedArgs;
                    try {
                        parsedArgs = JSON.parse(tc.function?.arguments || '{}');
                    } catch {
                        parsedArgs = {};
                    }

                    const contentVal = parsedArgs[this.config.targetParam];
                    if (typeof contentVal === 'string') {
                        extractedCombined += (extractedCombined ? '\n' : '') + contentVal;
                    }

                    if (!this.config.consumeToolCalls) {
                        remainingToolCalls.push(tc);
                    }
                } else {
                    remainingToolCalls.push(tc);
                }
            }

            if (extractedCombined) {
                message.content = (message.content ? message.content + '\n' : '') + extractedCombined;
                if (this.config.consumeToolCalls) {
                    if (remainingToolCalls.length > 0) {
                        message.tool_calls = remainingToolCalls;
                    } else {
                        delete message.tool_calls;
                    }
                    if (choice.finish_reason === 'tool_calls') {
                        choice.finish_reason = 'stop';
                    }
                }
            }
        }

        return new Response(JSON.stringify(json), {
            status: originalResponse.status,
            statusText: originalResponse.statusText,
            headers: originalResponse.headers,
        });
    }
}
