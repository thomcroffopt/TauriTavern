import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamingContentExtractor } from '../streaming-content-extractor.js';

test('StreamingContentExtractor - 单次完整输入解析', () => {
    const extractor = new StreamingContentExtractor();
    const input = '{"content": "你好，这是一段测试文本。\\n包含换行与\\"引号\\"。"}';
    const result = extractor.feed(input);
    assert.equal(result, '你好，这是一段测试文本。\n包含换行与"引号"。');
    assert.equal(extractor.isDone, true);
});

test('StreamingContentExtractor - 逐字符碎片流式解析', () => {
    const extractor = new StreamingContentExtractor();
    const raw = '{"content": "小猫之神正在思考...\\n✨ 状态正常！"}';
    let reconstructed = '';

    for (const char of raw) {
        reconstructed += extractor.feed(char);
    }
    reconstructed += extractor.flush();

    assert.equal(reconstructed, '小猫之神正在思考...\n✨ 状态正常！');
    assert.equal(extractor.isDone, true);
});

test('StreamingContentExtractor - 转义序列跨 chunk 截断', () => {
    const extractor = new StreamingContentExtractor();
    const chunks = [
        '{"content": "第一行',
        '\\', // 转义斜杠切在边界
        'n第二行',
        '\\',
        '"带有引号\\',
        '"和反斜杠',
        '\\\\',
        '"}',
    ];

    let output = '';
    for (const chunk of chunks) {
        output += extractor.feed(chunk);
    }
    output += extractor.flush();

    assert.equal(output, '第一行\n第二行"带有引号"和反斜杠\\');
});

test('StreamingContentExtractor - Unicode 跨 chunk 截断解析', () => {
    const extractor = new StreamingContentExtractor();
    // \u4e2d\u6587 (中文)
    const chunks = [
        '{"content": "这是',
        '\\u4',  // 切在十六进制中间
        'e2d',
        '\\u',   // 切在 \u 和十六进制之间
        '6587',
        '"}',
    ];

    let output = '';
    for (const chunk of chunks) {
        output += extractor.feed(chunk);
    }
    output += extractor.flush();

    assert.equal(output, '这是中文');
});

test('StreamingContentExtractor - UTF-16 代理对 Emoji (Surrogate Pairs) 跨 chunk', () => {
    const extractor = new StreamingContentExtractor();
    // 😀 在 JSON 中为 \uD83D\uDE00
    const chunks = [
        '{"content": "开心的小猫',
        '\\uD83D', // 高代理项
        '\\uDE00', // 低代理项
        '！"}',
    ];

    let output = '';
    for (const chunk of chunks) {
        output += extractor.feed(chunk);
    }
    output += extractor.flush();

    assert.equal(output, '开心的小猫😀！');
});

test('StreamingContentExtractor - 前后包含其他参数与空格', () => {
    const extractor = new StreamingContentExtractor();
    const chunks = [
        '{\n  "meta": {"id": 100},\n  ',
        '"content"  :  "这是核心',
        '正文内容"',
        ',\n  "status": "ok"\n}',
    ];

    let output = '';
    for (const chunk of chunks) {
        output += extractor.feed(chunk);
    }
    output += extractor.flush();

    assert.equal(output, '这是核心正文内容');
    assert.equal(extractor.isDone, true);
});

test('StreamingContentExtractor - 自定义参数名', () => {
    const extractor = new StreamingContentExtractor({ targetParam: 'game_text' });
    const chunks = [
        '{"status": 200, "game_text": "自定义文本参数", "extra": 1}',
    ];

    let output = '';
    for (const chunk of chunks) {
        output += extractor.feed(chunk);
    }
    output += extractor.flush();

    assert.equal(output, '自定义文本参数');
});
