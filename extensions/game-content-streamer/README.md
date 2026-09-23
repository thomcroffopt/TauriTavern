# GameContent 实时流式传输助手插件 (GameContent Streamer)

专为 **Reborn 2.2** 等使用 `game_content` 工具调用（Tool Call）输出正文的酒馆预设打造。

---

## 📖 背景与原理

在部分高级酒馆预设（例如 Reborn 2.2）中，为了规避部分大模型厂商的安全截断或内容审核，预设配置了 `<censorship_bypass>`（防截断 2.0），指示模型**严禁直接输出正文，必须调用 `game_content(content="...")` 输出**。

然而，酒馆的前端在接收到模型的工具调用时，流式数据位于 `delta.tool_calls[i].function.arguments` 中，默认不会驱动打字机实时渲染，导致模型生成时**界面一片空白或卡在 `'...'`，无法流式打字**。

本插件通过在前端轻量拦截流式 SSE 协议：
1. 实时检测大模型返回的 `game_content` 工具调用。
2. 通过高性能流式状态机，将分片传输的 JSON 参数实时还原为纯文本（自动处理 Unicode 代理对与复杂转义）。
3. 动态伪装为原生的 `delta.content`，复用 TauriTavern / SillyTavern 原生打字机机制、Markdown 渲染与自动滚动。
4. 自动消费该工具调用（将 `finish_reason` 标记为 `stop`），避免触发多余的第二轮工具交互。

---

## 🚀 侧载安装方法 (Sideloading)

本插件为纯前端第三方扩展，零修改宿主源码，支持即插即用。

### 方式一：在 TauriTavern 中安装（推荐）

1. 打开 TauriTavern 的数据根目录（可在客户端设置 `System -> Data Directory` 中查看）：
   - 默认用户路径：`<你的数据根目录>/default-user/extensions/`
   - 全局路径：`<你的数据根目录>/extensions/third-party/`
2. 将本插件文件夹 `game-content-streamer` 完整复制到上述扩展目录中：
   ```text
   data/
   └── default-user/
       └── extensions/
           └── game-content-streamer/
               ├── manifest.json
               ├── index.js
               ├── fetch-interceptor.js
               ├── streaming-content-extractor.js
               ├── style.css
               └── README.md
   ```
3. 重启或刷新 TauriTavern，在右侧面板的 **Extensions（扩展设置）** 中即可看到 `⚡ GameContent 流式传输助手`。

### 方式二：在标准 SillyTavern 中安装

1. 打开 SillyTavern 目录下的 `public/scripts/extensions/third-party/`。
2. 将 `game-content-streamer` 文件夹复制进去。
3. 刷新浏览器页面即可自动激活生效。

---

## ⚙️ 配置说明

在酒馆的扩展设置面板中，可以随时调整以下选项：

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| **启用实时流式拦截** | `true` | 总开关。开启后拦截并实时打字机渲染。 |
| **目标函数名** | `game_content, game content` | 预设中定义的伪工具名称，支持逗号分隔多个函数。 |
| **目标文本参数名** | `content` | 承载正文的参数名，通常为 `content`。 |
| **消费工具调用** | `true` | **强烈推荐开启**。将此工具调用转换为普通消息，不向大模型发起多余的后续请求。 |

---

## 🧪 配合 Reborn 2.2 预设使用

1. 导入您的 `Reborn2.2-preview (2).json` 预设。
2. 确保预设中的 `game_content` 工具（防截断 2.0）已按需启用。
3. 开启本插件后，像往常一样在聊天框输入消息并发送。
4. 模型调用 `game_content` 时，您将看到**流畅、实时的逐字打字机效果**，同时思考链（Thinking）也会正常折叠展示，完全恢复原生流式体验！
