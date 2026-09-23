/**
 * @file streaming-content-extractor.js
 * 增量流式 JSON 字符串参数提取器与解码状态机
 * 
 * 专门用于在大模型通过 tool_call / function_call 输出 arguments 片段时，
 * 实时提取指定参数（如 "content"）中的字符串内容，进行无闪烁的实时 Unicode 与转义序列还原。
 */

/**
 * 字符串解码状态枚举
 */
const DecoderState = {
    WAITING_FOR_KEY: 0,   // 尚未定位到目标参数的起始引号
    IN_STRING: 1,         // 正在字符串内部，正常输出字符
    IN_ESCAPE: 2,         // 刚遇到反斜杠 '\'
    IN_UNICODE_HEX: 3,    // 遇到 '\u'，正在收集4位十六进制字符
    IN_UNICODE_BRACED: 4, // 遇到 '\u{'，正在收集闭合大括号前的十六进制字符
    COMPLETED: 5,         // 遇到未转义的闭合引号 '"'，字符串已完整结束
};

export class StreamingContentExtractor {
    /**
     * @param {object} [options]
     * @param {string} [options.targetParam='content'] 需要提取的参数名，默认为 'content'
     */
    constructor(options = {}) {
        this.targetParam = options.targetParam || 'content';
        this.state = DecoderState.WAITING_FOR_KEY;

        /** 尚未定位到起始引号前的字符缓冲 */
        this.headerBuffer = '';

        /** 收集中的 Unicode 十六进制字符缓冲 */
        this.unicodeBuffer = '';

        /** 暂存的 UTF-16 高代理项 (High Surrogate: 0xD800-0xDBFF) */
        this.pendingHighSurrogate = null;

        /** 是否已全部结束 */
        this.isDone = false;
    }

    /**
     * 重置状态机
     */
    reset() {
        this.state = DecoderState.WAITING_FOR_KEY;
        this.headerBuffer = '';
        this.unicodeBuffer = '';
        this.pendingHighSurrogate = null;
        this.isDone = false;
    }

    /**
     * 接收一段 arguments 增量文本，返回实时解出的字符串增量
     * @param {string} chunk 增量字符片段
     * @returns {string} 解码后的文本增量
     */
    feed(chunk) {
        if (!chunk || this.isDone) {
            return '';
        }

        let output = '';
        let index = 0;

        // 阶段一：定位目标参数名及起始双引号
        if (this.state === DecoderState.WAITING_FOR_KEY) {
            this.headerBuffer += chunk;

            // 构造正则匹配: "targetParam"\s*:\s*"
            // 允许键名有无转义或前后空白
            const escapedParam = this.targetParam.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const keyPattern = new RegExp(`"(?:\\\\")?${escapedParam}(?:\\\\")?"\\s*:\\s*"`, 'g');
            const match = keyPattern.exec(this.headerBuffer);

            if (match) {
                // 成功找到起始引号！
                const contentStartIndex = match.index + match[0].length;
                const remaining = this.headerBuffer.slice(contentStartIndex);
                this.state = DecoderState.IN_STRING;
                this.headerBuffer = ''; // 释放头部缓存

                // 将起始引号之后的剩余文本直接送入字符解码流程
                chunk = remaining;
                index = 0;
            } else {
                // 尚未遇到目标参数起始引号，保持缓存等待后续 chunk
                // 防止 headerBuffer 异常膨胀（例如如果不是 JSON），保留最后 100 字符防止 key 跨 chunk 截断
                if (this.headerBuffer.length > 2000) {
                    this.headerBuffer = this.headerBuffer.slice(-200);
                }
                return '';
            }
        }

        // 阶段二：逐字符解码字符串内容
        const len = chunk.length;
        while (index < len) {
            const char = chunk[index];

            switch (this.state) {
                case DecoderState.IN_STRING:
                    if (char === '\\') {
                        this.state = DecoderState.IN_ESCAPE;
                    } else if (char === '"') {
                        // 遇到未转义的双引号，字符串结束！
                        this.#flushSurrogate(char => { output += char; });
                        this.state = DecoderState.COMPLETED;
                        this.isDone = true;
                        return output;
                    } else {
                        // 普通字符
                        this.#flushSurrogate(c => { output += c; });
                        output += char;
                    }
                    index++;
                    break;

                case DecoderState.IN_ESCAPE:
                    if (char === '"') {
                        this.#flushSurrogate(c => { output += c; });
                        output += '"';
                        this.state = DecoderState.IN_STRING;
                    } else if (char === '\\') {
                        this.#flushSurrogate(c => { output += c; });
                        output += '\\';
                        this.state = DecoderState.IN_STRING;
                    } else if (char === '/') {
                        this.#flushSurrogate(c => { output += c; });
                        output += '/';
                        this.state = DecoderState.IN_STRING;
                    } else if (char === 'b') {
                        this.#flushSurrogate(c => { output += c; });
                        output += '\b';
                        this.state = DecoderState.IN_STRING;
                    } else if (char === 'f') {
                        this.#flushSurrogate(c => { output += c; });
                        output += '\f';
                        this.state = DecoderState.IN_STRING;
                    } else if (char === 'n') {
                        this.#flushSurrogate(c => { output += c; });
                        output += '\n';
                        this.state = DecoderState.IN_STRING;
                    } else if (char === 'r') {
                        this.#flushSurrogate(c => { output += c; });
                        output += '\r';
                        this.state = DecoderState.IN_STRING;
                    } else if (char === 't') {
                        this.#flushSurrogate(c => { output += c; });
                        output += '\t';
                        this.state = DecoderState.IN_STRING;
                    } else if (char === 'u') {
                        this.unicodeBuffer = '';
                        this.state = DecoderState.IN_UNICODE_HEX;
                    } else {
                        // 其它非标准转义符，原样保留
                        this.#flushSurrogate(c => { output += c; });
                        output += char;
                        this.state = DecoderState.IN_STRING;
                    }
                    index++;
                    break;

                case DecoderState.IN_UNICODE_HEX:
                    if (this.unicodeBuffer.length === 0 && char === '{') {
                        // ES6 扩展格式: \u{1F600}
                        this.state = DecoderState.IN_UNICODE_BRACED;
                        index++;
                        break;
                    }

                    // 4位定长十六进制字符: \uXXXX
                    if (/[0-9a-fA-F]/.test(char)) {
                        this.unicodeBuffer += char;
                        index++;
                        if (this.unicodeBuffer.length === 4) {
                            const codePoint = parseInt(this.unicodeBuffer, 16);
                            this.unicodeBuffer = '';

                            // 检查是否为高代理项 (High Surrogate: 0xD800 - 0xDBFF)
                            if (codePoint >= 0xD800 && codePoint <= 0xDBFF) {
                                // 先刷新之前的残留高代理项（如果有异常）
                                this.#flushSurrogate(c => { output += c; });
                                this.pendingHighSurrogate = codePoint;
                            } else if (codePoint >= 0xDC00 && codePoint <= 0xDFFF && this.pendingHighSurrogate !== null) {
                                // 遇到低代理项，并且前面有高代理项，合成为完整 Unicode 字符 (如 Emoji)
                                const high = this.pendingHighSurrogate;
                                const low = codePoint;
                                this.pendingHighSurrogate = null;
                                const fullCodePoint = 0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00);
                                output += String.fromCodePoint(fullCodePoint);
                            } else {
                                // 普通 Unicode 字符
                                this.#flushSurrogate(c => { output += c; });
                                output += String.fromCharCode(codePoint);
                            }
                            this.state = DecoderState.IN_STRING;
                        }
                    } else {
                        // 非法十六进制字符，回退输出
                        this.#flushSurrogate(c => { output += c; });
                        output += '\\u' + this.unicodeBuffer + char;
                        this.unicodeBuffer = '';
                        this.state = DecoderState.IN_STRING;
                        index++;
                    }
                    break;

                case DecoderState.IN_UNICODE_BRACED:
                    if (char === '}') {
                        if (this.unicodeBuffer.length > 0) {
                            const codePoint = parseInt(this.unicodeBuffer, 16);
                            this.#flushSurrogate(c => { output += c; });
                            try {
                                output += String.fromCodePoint(codePoint);
                            } catch {
                                output += `\\u{${this.unicodeBuffer}}`;
                            }
                        }
                        this.unicodeBuffer = '';
                        this.state = DecoderState.IN_STRING;
                    } else if (/[0-9a-fA-F]/.test(char)) {
                        this.unicodeBuffer += char;
                    } else {
                        // 遇到非十六进制字符且非闭合大括号，放弃解析
                        this.#flushSurrogate(c => { output += c; });
                        output += `\\u{${this.unicodeBuffer}${char}`;
                        this.unicodeBuffer = '';
                        this.state = DecoderState.IN_STRING;
                    }
                    index++;
                    break;

                case DecoderState.COMPLETED:
                    // 已经闭合，跳过后续所有字符
                    return output;
            }
        }

        return output;
    }

    /**
     * 结束输入并清理未决的代理项
     * @returns {string} 尾部残留输出
     */
    flush() {
        let output = '';
        this.#flushSurrogate(c => { output += c; });
        this.isDone = true;
        return output;
    }

    /**
     * 刷新孤立的高代理项
     * @param {(char: string) => void} emit
     */
    #flushSurrogate(emit) {
        if (this.pendingHighSurrogate !== null) {
            emit(String.fromCharCode(this.pendingHighSurrogate));
            this.pendingHighSurrogate = null;
        }
    }
}
