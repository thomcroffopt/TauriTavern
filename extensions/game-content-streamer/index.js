/**
 * @file index.js
 * GameContent 实时流式传输助手 - 扩展主入口
 */

import { GameContentInterceptor, DEFAULT_CONFIG } from './fetch-interceptor.js';

const EXTENSION_KEY = 'game-content-streamer';
const STORAGE_NAMESPACE = 'game_content_streamer';

/** @type {GameContentInterceptor} */
let interceptor = null;

let currentSettings = { ...DEFAULT_CONFIG };

/**
 * 加载持久化设置
 */
async function loadSettings() {
    try {
        // 优先使用 TauriTavern 专属的 extension store
        if (window.__TAURITAVERN__?.api?.extension?.store) {
            const store = window.__TAURITAVERN__.api.extension.store;
            const res = await store.tryGetJson({
                namespace: STORAGE_NAMESPACE,
                key: 'settings',
            });
            if (res.found && res.value) {
                currentSettings = { ...DEFAULT_CONFIG, ...res.value };
                return;
            }
        }

        // 兼容 SillyTavern / 网页标准 localStorage
        const stored = localStorage.getItem(`tauritavern_${STORAGE_NAMESPACE}_settings`);
        if (stored) {
            currentSettings = { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
        }
    } catch (e) {
        console.warn('[GameContentStreamer] 读取配置失败，采用默认值:', e);
    }
}

/**
 * 保存持久化设置
 */
async function saveSettings() {
    try {
        if (window.__TAURITAVERN__?.api?.extension?.store) {
            const store = window.__TAURITAVERN__.api.extension.store;
            await store.setJson({
                namespace: STORAGE_NAMESPACE,
                key: 'settings',
                value: currentSettings,
            });
        }
        localStorage.setItem(`tauritavern_${STORAGE_NAMESPACE}_settings`, JSON.stringify(currentSettings));
    } catch (e) {
        console.warn('[GameContentStreamer] 保存配置失败:', e);
    }
}

/**
 * 挂载设置面板 UI 到酒馆扩展设置抽屉中
 */
function mountSettingsUI() {
    const container = document.getElementById('extensions_settings');
    if (!container || document.getElementById('gcs-settings-drawer')) {
        return;
    }

    const drawerHtml = `
    <div id="gcs-settings-drawer" class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>⚡ GameContent 流式传输助手</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" style="display: none;">
            <div class="gcs-settings-container">
                <div class="gcs-header">
                    <h4>
                        <span class="fa-solid fa-bolt"></span>
                        拦截与渲染控制
                    </h4>
                    <span id="gcs-status-indicator" class="gcs-status-badge ${currentSettings.enabled ? '' : 'disabled'}">
                        <span class="gcs-status-dot"></span>
                        <span class="gcs-status-text">${currentSettings.enabled ? '已激活' : '未启用'}</span>
                    </span>
                </div>

                <div class="gcs-form-group">
                    <label class="gcs-checkbox-label">
                        <input type="checkbox" id="gcs-enabled-checkbox" ${currentSettings.enabled ? 'checked' : ''}>
                        <span>启用 GameContent 实时流式拦截</span>
                    </label>
                    <div class="description">开启后在流式接收时实时将函数参数内容解析为打字机正文</div>
                </div>

                <div class="gcs-form-group">
                    <label for="gcs-target-functions">目标函数名（多个用逗号隔开）</label>
                    <div class="description">预设中调用的伪工具函数名，通常为 game_content</div>
                    <input type="text" id="gcs-target-functions" class="gcs-input-text" value="${currentSettings.targetFunctions.join(', ')}">
                </div>

                <div class="gcs-form-group">
                    <label for="gcs-target-param">目标文本参数名</label>
                    <div class="description">函数中承载输出正文的参数，通常为 content</div>
                    <input type="text" id="gcs-target-param" class="gcs-input-text" value="${currentSettings.targetParam}">
                </div>

                <div class="gcs-form-group">
                    <label class="gcs-checkbox-label">
                        <input type="checkbox" id="gcs-consume-checkbox" ${currentSettings.consumeToolCalls ? 'checked' : ''}>
                        <span>消费工具调用（推荐）</span>
                    </label>
                    <div class="description">自动将该 tool_call 转换为正常聊天消息，避免触发多余的第二轮工具交互</div>
                </div>
            </div>
        </div>
    </div>
    `;

    container.insertAdjacentHTML('beforeend', drawerHtml);

    // 绑定抽屉折叠展开交互
    const drawerElement = document.getElementById('gcs-settings-drawer');
    const toggle = drawerElement.querySelector('.inline-drawer-toggle');
    const content = drawerElement.querySelector('.inline-drawer-content');
    const icon = drawerElement.querySelector('.inline-drawer-icon');

    toggle.addEventListener('click', () => {
        const isHidden = content.style.display === 'none';
        content.style.display = isHidden ? 'block' : 'none';
        if (isHidden) {
            icon.classList.remove('down');
            icon.classList.add('up');
        } else {
            icon.classList.remove('up');
            icon.classList.add('down');
        }
    });

    // 绑定表单控件
    const enabledCheckbox = document.getElementById('gcs-enabled-checkbox');
    const functionsInput = document.getElementById('gcs-target-functions');
    const paramInput = document.getElementById('gcs-target-param');
    const consumeCheckbox = document.getElementById('gcs-consume-checkbox');
    const statusIndicator = document.getElementById('gcs-status-indicator');
    const statusText = statusIndicator.querySelector('.gcs-status-text');

    const updateState = async () => {
        currentSettings.enabled = enabledCheckbox.checked;
        currentSettings.targetFunctions = functionsInput.value
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
        currentSettings.targetParam = paramInput.value.trim() || 'content';
        currentSettings.consumeToolCalls = consumeCheckbox.checked;

        if (currentSettings.enabled) {
            statusIndicator.classList.remove('disabled');
            statusText.textContent = '已激活';
        } else {
            statusIndicator.classList.add('disabled');
            statusText.textContent = '未启用';
        }

        interceptor.updateConfig(currentSettings);
        await saveSettings();
    };

    enabledCheckbox.addEventListener('change', updateState);
    functionsInput.addEventListener('change', updateState);
    paramInput.addEventListener('change', updateState);
    consumeCheckbox.addEventListener('change', updateState);
}

/**
 * 扩展初始化入口函数
 */
export async function init() {
    await loadSettings();

    interceptor = new GameContentInterceptor(currentSettings);
    interceptor.install();

    // 在 DOM 加载完毕或面板就绪时挂载设置 UI
    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', mountSettingsUI);
    } else {
        mountSettingsUI();
    }

    console.log('[GameContentStreamer] 插件初始化完成');
}

// 自动初始化（适配各种扩展加载机制）
if (typeof window !== 'undefined') {
    init().catch(err => console.error('[GameContentStreamer] 初始化异常:', err));
}
