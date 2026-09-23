import test from 'node:test';
import assert from 'node:assert/strict';
import { GameContentInterceptor } from '../fetch-interceptor.js';

test('GameContentInterceptor - SSE 流式拦截与 delta.content 实时重构', async () => {
    const interceptor = new GameContentInterceptor({
        enabled: true,
        targetFunctions: ['game_content'],
        targetParam: 'content',
        consumeToolCalls: true,
    });

    // 模拟服务端发出的 SSE 数据块
    const sseChunks = [
        `data: ${JSON.stringify({ id: 'chat-1', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'game_content', arguments: '' } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ id: 'chat-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"content": "欢迎进入' } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ id: 'chat-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '小猫之神' } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ id: 'chat-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '的世界！\n🐾"}' } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ id: 'chat-1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
        'data: [DONE]\n\n',
    ];

    // 构建一个 ReadableStream 模拟 response.body
    const encoder = new TextEncoder();
    const sourceStream = new ReadableStream({
        start(controller) {
            for (const chunk of sseChunks) {
                controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
        }
    });

    const mockResponse = new Response(sourceStream, {
        headers: { 'content-type': 'text/event-stream' },
        status: 200,
    });

    const wrappedResponse = interceptor.wrapEventStreamResponse(mockResponse);
    const reader = wrappedResponse.body.getReader();
    const decoder = new TextDecoder();
    let accumulatedText = '';
    let finalFinishReason = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        const lines = text.split('\n');
        for (const line of lines) {
            if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                const parsed = JSON.parse(line.slice(6));
                const deltaContent = parsed.choices?.[0]?.delta?.content;
                if (deltaContent) {
                    accumulatedText += deltaContent;
                }
                if (parsed.choices?.[0]?.finish_reason) {
                    finalFinishReason = parsed.choices[0].finish_reason;
                }
                // 确保 tool_calls 被消费移除了
                assert.equal(parsed.choices?.[0]?.delta?.tool_calls, undefined);
            }
        }
    }

    assert.equal(accumulatedText, '欢迎进入小猫之神的世界！\n🐾');
    assert.equal(finalFinishReason, 'stop');
});

test('GameContentInterceptor - 非流式 JSON 响应拦截', async () => {
    const interceptor = new GameContentInterceptor({
        enabled: true,
        targetFunctions: ['game_content'],
        targetParam: 'content',
        consumeToolCalls: true,
    });

    const rawJson = {
        id: 'chat-2',
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                        {
                            id: 'call_99',
                            type: 'function',
                            function: {
                                name: 'game_content',
                                arguments: JSON.stringify({ content: '非流式回复文本内容' }),
                            }
                        }
                    ]
                },
                finish_reason: 'tool_calls'
            }
        ]
    };

    const mockResponse = new Response(JSON.stringify(rawJson), {
        headers: { 'content-type': 'application/json' },
        status: 200,
    });

    const wrappedResponse = await interceptor.wrapJsonResponse(mockResponse);
    const parsed = await wrappedResponse.json();

    assert.equal(parsed.choices[0].message.content, '非流式回复文本内容');
    assert.equal(parsed.choices[0].message.tool_calls, undefined);
    assert.equal(parsed.choices[0].finish_reason, 'stop');
});

test('GameContentInterceptor - 其它常规工具调用不被误拦截', async () => {
    const interceptor = new GameContentInterceptor({
        enabled: true,
        targetFunctions: ['game_content'],
        targetParam: 'content',
        consumeToolCalls: true,
    });

    const rawJson = {
        id: 'chat-3',
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content: '正在查询天气...',
                    tool_calls: [
                        {
                            id: 'call_weather',
                            type: 'function',
                            function: {
                                name: 'get_weather',
                                arguments: '{"city":"Beijing"}',
                            }
                        }
                    ]
                },
                finish_reason: 'tool_calls'
            }
        ]
    };

    const mockResponse = new Response(JSON.stringify(rawJson), {
        headers: { 'content-type': 'application/json' },
        status: 200,
    });

    const wrappedResponse = await interceptor.wrapJsonResponse(mockResponse);
    const parsed = await wrappedResponse.json();

    assert.equal(parsed.choices[0].message.content, '正在查询天气...');
    assert.equal(parsed.choices[0].message.tool_calls.length, 1);
    assert.equal(parsed.choices[0].message.tool_calls[0].function.name, 'get_weather');
    assert.equal(parsed.choices[0].finish_reason, 'tool_calls');
});
