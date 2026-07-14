// ==UserScript==
// @name         PopDict 词窗 - 划词翻译
// @namespace    https://github.com/vlan20/popdict
// @version      0.1.4
// @description  一款简洁轻量的网页划词翻译脚本，双击即译，支持有道词典、剑桥词典和谷歌翻译，适配Tampermonkey脚本管理器。
// @author       vlan20
// @license      MIT
// @match        *://*/*
// @exclude      *://translate.google.com/*
// @exclude      *://dict.youdao.com/*
// @exclude      *://dictionary.cambridge.org/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @connect      translate.googleapis.com
// @connect      dict.youdao.com
// @connect      dictionary.cambridge.org
// @run-at       document-end
// @downloadURL  https://github.com/vlan20/popdict/raw/main/popdict.user.js
// @updateURL    https://github.com/vlan20/popdict/raw/main/popdict.user.js
// @supportURL   https://github.com/vlan20/popdict/issues
// ==/UserScript==

/*
 * Copyright (c) 2025-2026 vlan20
 * SPDX-License-Identifier: MIT
 */

(() => {
    'use strict';

    // 配置项
    const CONFIG = {
        fontSize: 16, // 基础字体大小
        sourceFontSize: 14, // 原文字体大小
        translationFontSize: 13, // 翻译结果字体大小
        triggerDelay: 150, // 减少触发延迟
        doubleClickDelay: 250, // 双击判定间隔
        darkModeClass: 'translator-panel-dark',
        panelSpacing: 12, // 减小面板间距
        panelWidth: 300,
        maxPanelHeightRatio: 0.75, // 长内容最多占用视口高度的 75%
        titleBarHeight: 40, // 添加标题栏高度配置
        animationDuration: 200, // 面板淡出时间
        loadingDelay: 120, // 超过该时间才显示加载条
        hoverHideDelay: 80, // 高亮悬浮窗关闭延迟
        cacheExpiration: 24 * 60 * 60 * 1000, // 缓存过期时间（24小时）
        maxCacheSize: 100, // 最大缓存条目数
    };

    let isTranslating = false;

    // 翻译缓存系统
    const translationCache = {
        cache: new Map(),
        generateKey: (text, translator) => `${translator}:${text}`,
        get(text, translator) {
            const key = this.generateKey(text, translator);
            const item = this.cache.get(key);
            if (!item || Date.now() - item.timestamp > CONFIG.cacheExpiration) {
                item && this.cache.delete(key);
                return null;
            }
            return item.translation;
        },
        set(text, translator, translation) {
            const key = this.generateKey(text, translator);
            if (this.cache.size >= CONFIG.maxCacheSize) {
                const oldestKey = Array.from(this.cache.entries())
                    .sort((a, b) => a[1].timestamp - b[1].timestamp)[0][0];
                this.cache.delete(oldestKey);
            }
            this.cache.set(key, { translation, timestamp: Date.now() });
        },
        cleanup() {
            const now = Date.now();
            for (const [key, item] of this.cache.entries()) {
                if (now - item.timestamp > CONFIG.cacheExpiration) {
                    this.cache.delete(key);
                }
            }
        }
    };

    // 定期清理过期缓存
    setInterval(() => translationCache.cleanup(), CONFIG.cacheExpiration);

    // 新建窗口前移除未固定的旧窗口，固定窗口保留。
    function cleanupPanels() {
        hideHoverPanel();
        document.querySelectorAll('.translator-panel:not(.pinned)').forEach(panel => panel.remove());
    }

    // 使用 GM 请求音频数据并交给 Web Audio 播放，避免网页 CSP 拦截外部媒体。
    const audio = {
        context: null,
        source: null,
        async getContext() {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) throw new Error('当前浏览器不支持 Web Audio');
            if (!this.context) this.context = new AudioContextClass();
            if (this.context.state !== 'running') await this.context.resume();
            return this.context;
        },
        fetch(url) {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    anonymous: true,
                    responseType: 'arraybuffer',
                    onload: response => {
                        if (response.status < 200 || response.status >= 300) {
                            reject(new Error(`音频请求失败（HTTP ${response.status}）`));
                            return;
                        }
                        const data = response.response;
                        if (!(data instanceof ArrayBuffer)) {
                            reject(new Error('音频响应格式不正确'));
                            return;
                        }
                        resolve(data);
                    },
                    onerror: () => reject(new Error('音频请求失败'))
                });
            });
        },
        async play(url) {
            try {
                const context = await this.getContext();
                const data = await this.fetch(url);
                const buffer = await context.decodeAudioData(data.slice(0));

                if (this.source) {
                    try { this.source.stop(); } catch (_) {}
                }

                const source = context.createBufferSource();
                source.buffer = buffer;
                source.connect(context.destination);
                source.onended = () => {
                    if (this.source === source) this.source = null;
                };
                this.source = source;
                source.start();
            } catch (error) {
                console.error('播放音频失败:', error);
            }
        }
    };

    // 统一 GET 请求；不伪造 User-Agent，剑桥单独使用匿名请求避开异常 Cookie 状态。
    const gmGet = (url, options = {}) => new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: 'GET',
            url,
            ...options,
            onload: resolve,
            onerror: reject
        });
    });

    // 翻译器工厂函数
    const createTranslator = (name, translateFn) => ({
        name,
        translate: async (text) => {
            const cachedResult = translationCache.get(text, name);
            if (cachedResult) return cachedResult;

            const result = await translateFn(text);
            if (!result?.html) throw new Error(`${name}翻译失败: 翻译结果为空`);

            translationCache.set(text, name, result);
            return result;
        }
    });

    // 翻译器配置
    const TRANSLATORS = {
        google: createTranslator('谷歌翻译', async (text) => {
            try {
                const response = await gmGet(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`);
                const result = JSON.parse(response.responseText);
                if (!result?.[0]?.length) throw new Error('谷歌翻译返回的数据格式不正确');
                return { html: result[0].map(x => x[0]).join(''), highlightable: false };
            } catch (error) {
                console.error('谷歌翻译错误:', error);
                throw new Error('谷歌翻译失败: ' + error.message);
            }
        }),

        youdao: createTranslator('有道词典', async (text) => {
            try {
                const response = await gmGet(
                    `https://dict.youdao.com/jsonapi?xmlVersion=5.1&jsonversion=2&q=${encodeURIComponent(text)}`,
                    { headers: { 'Referer': 'https://dict.youdao.com' } }
                );

                const result = JSON.parse(response.responseText);
                let translation = '';
                const createPronHtml = (type, pron, url) => `<span class="phonetic-item">${type} /${pron}/ <button class="audio-button" data-url="${url}">🔊</button></span>`;
                const wordInfo = result.ec?.word?.[0];
                const audioUrls = {
                    uk: wordInfo?.ukspeech ? `https://dict.youdao.com/dictvoice?audio=${wordInfo.ukspeech}` : '',
                    us: wordInfo?.usspeech ? `https://dict.youdao.com/dictvoice?audio=${wordInfo.usspeech}` : ''
                };

                // 添加音标和发音按钮
                if (wordInfo?.ukphone || wordInfo?.usphone) {
                    translation += '<div class="phonetic-buttons">';
                    if (wordInfo.ukphone && audioUrls.uk) translation += createPronHtml('英', wordInfo.ukphone, audioUrls.uk);
                    if (wordInfo.usphone && audioUrls.us) translation += createPronHtml('美', wordInfo.usphone, audioUrls.us);
                    translation += '</div>\n\n';
                }

                // 获取翻译结果
                if (wordInfo?.trs) {
                    translation += wordInfo.trs.map(tr => tr.tr[0].l.i.join('; ')).join('\n');
                } else if (result.fanyi) {
                    translation = result.fanyi.tran;
                } else if (result.translation) {
                    translation = result.translation.join('\n');
                } else if (result.web_trans?.web_translation) {
                    translation = result.web_trans.web_translation
                        .map(item => item.trans.map(t => t.value).join('; '))
                        .join('\n');
                }

                if (!translation) throw new Error('未找到翻译结果');
                return { html: translation, highlightable: Boolean(wordInfo?.trs) };
            } catch (error) {
                console.error('有道词典错误:', error);
                throw new Error('有道词典失败: ' + error.message);
            }
        }),

        cambridge: createTranslator('剑桥词典', async (text) => {
            try {
                const response = await gmGet(
                    `https://dictionary.cambridge.org/search/english-chinese-simplified/direct/?q=${encodeURIComponent(text)}`,
                    {
                        anonymous: true,
                        headers: {
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                            'Accept-Language': 'en-US,en;q=0.5'
                        }
                    }
                );

                const parser = new DOMParser();
                const doc = parser.parseFromString(response.responseText, 'text/html');
                let translation = '';

                // 辅助函数
                const createPosTagsHtml = posStr => !posStr ? '' : posStr.split(/[,，、\n]/).map(p => p.trim()).filter(p => p).map(tag => `<div class="pos-tag">${tag}</div>`).join('');
                const getFullUrl = url => !url ? '' : url.startsWith('http') ? url : url.startsWith('//') ? 'https:' + url : `https://dictionary.cambridge.org${url}`;
                const getPronunciations = container => {
                    if (!container) return { prons: [], audioUrls: [] };
                    const prons = Array.from(container.querySelectorAll('.pron')).map(el => el.textContent.trim());
                    const audioUrls = Array.from(container.querySelectorAll('source[type="audio/mpeg"]')).map(el => getFullUrl(el.getAttribute('src')));
                    return { prons, audioUrls };
                };
                const createPronHtml = (type, pron, audioUrl) => `<span class="phonetic-item">${type} ${pron} <button class="audio-button" data-url="${audioUrl}">🔊</button></span>`;

                // 获取主要发音并添加
                const mainUk = getPronunciations(doc.querySelector('.uk.dpron-i'));
                const mainUs = getPronunciations(doc.querySelector('.us.dpron-i'));
                if (mainUk.prons.length > 0 || mainUs.prons.length > 0) {
                    translation += '<div class="phonetic-buttons">';
                    mainUk.prons.forEach((pron, i) => translation += createPronHtml('英', pron, mainUk.audioUrls[i]));
                    mainUs.prons.forEach((pron, i) => translation += createPronHtml('美', pron, mainUs.audioUrls[i]));
                    translation += '</div>\n\n';
                }

                // 处理释义
                function processSenses(senses, pos) {
                    if (senses.length === 0 && pos)
                        return `<div class="sense-block pos-only"><div class="pos-tags">${createPosTagsHtml(pos)}</div></div>`;

                    return senses.map(sense => {
                        const def = sense.querySelector('.ddef_h .def')?.textContent.trim() || '';
                        const trans = sense.querySelector('.def-body .trans')?.textContent.trim() || '';
                        const levelTag = sense.querySelector('.dxref')?.textContent.trim() || '';
                        let senseProns = '';
                        const sensePronContainers = sense.querySelectorAll('.dpron-i');

                        if (sensePronContainers.length > 0) {
                            const ukContainer = Array.from(sensePronContainers).find(c => c.classList.contains('uk'));
                            const usContainer = Array.from(sensePronContainers).find(c => c.classList.contains('us'));
                            const sharedPron = sense.querySelector('.pron')?.textContent.trim();
                            senseProns = '<div class="sense-phonetic">';

                            if (sharedPron) {
                                const ukUrl = ukContainer ? getFullUrl(ukContainer.querySelector('source[type="audio/mpeg"]')?.getAttribute('src')) : '';
                                const usUrl = usContainer ? getFullUrl(usContainer.querySelector('source[type="audio/mpeg"]')?.getAttribute('src')) : '';
                                if (ukUrl) senseProns += createPronHtml('英', sharedPron, ukUrl);
                                if (usUrl) senseProns += createPronHtml('美', sharedPron, usUrl);
                            } else {
                                const ukProns = getPronunciations(ukContainer), usProns = getPronunciations(usContainer);
                                ukProns.prons.forEach((pron, i) => senseProns += createPronHtml('英', pron, ukProns.audioUrls[i]));
                                usProns.prons.forEach((pron, i) => senseProns += createPronHtml('美', pron, usProns.audioUrls[i]));
                            }
                            senseProns += '</div>';
                        }

                        return pos ?
                            `<div class="sense-block">
                                <div class="pos-tags">${createPosTagsHtml(pos)}${levelTag ? `<div class="level-tag">${levelTag}</div>` : ''}</div>
                                <div class="def-content">${senseProns}<div class="def-text">${def}</div>${trans ? `<div class="trans-line">${trans}</div>` : ''}</div>
                            </div>` :
                            `<div class="sense-block no-pos">
                                <div class="def-content">${senseProns}<div class="def-text">${def}</div>${trans ? `<div class="trans-line">${trans}</div>` : ''}</div>
                            </div>`;
                    }).join('\n');
                }

                // 获取释义
                const entries = doc.querySelectorAll('.pr.entry-body__el');
                if (entries.length > 0) {
                    translation += Array.from(entries).map(entry => {
                        const posElements = entry.querySelectorAll('.pos-header .pos');
                        const pos = posElements.length > 0 ?
                            Array.from(posElements).map(el => el.textContent.trim()).filter((v, i, s) => s.indexOf(v) === i).join('\n') :
                            entry.querySelector('.pos')?.textContent.trim() || '';

                        const senseGroups = Array.from(entry.querySelectorAll('.pr.dsense-block')).filter(g => !g.querySelector('.phrase-title, .idiom-title'));
                        if (senseGroups.length === 0) {
                            const senses = Array.from(entry.querySelectorAll('.ddef_block')).filter(s => !s.closest('.phrase-block, .idiom-block'));
                            return processSenses(senses, pos);
                        }

                        return senseGroups.map(group => {
                            const groupPos = group.querySelector('.dsense-header .pos')?.textContent.trim() || pos;
                            const levelTag = group.querySelector('.dsense-header .dxref')?.textContent.trim() || '';
                            const senses = Array.from(group.querySelectorAll('.ddef_block')).filter(s => !s.closest('.phrase-block, .idiom-block'));
                            const posHtml = groupPos ? `<div class="sense-block"><div class="pos-tags">${createPosTagsHtml(groupPos)}${levelTag ? `<div class="level-tag">${levelTag}</div>` : ''}</div></div>` : '';
                            return `${posHtml}${processSenses(senses, groupPos)}`;
                        }).join('\n');
                    }).join('\n');

                    // 获取短语
                    const phrases = doc.querySelectorAll('.phrase-block, .idiom-block');
                    if (phrases.length > 0) {
                        translation += '\n\n' + Array.from(phrases).map(phraseBlock => {
                            const phraseTitle = phraseBlock.querySelector('.phrase-title, .idiom-title')?.textContent.trim() || '';
                            const phraseDef = phraseBlock.querySelector('.ddef_block .def')?.textContent.trim() || '';
                            return `<div class="sense-block">
                                <div class="pos-tags">${createPosTagsHtml('phrase')}</div>
                                <div class="def-content"><div class="def-text">${phraseTitle}</div><div class="trans-line">${phraseDef}</div></div>
                            </div>`;
                        }).join('\n');
                    }
                } else {
                    throw new Error('未找到释义');
                }

                return { html: translation, highlightable: true };
            } catch (error) {
                console.error('剑桥词典错误:', error);
                throw new Error('剑桥词典失败: ' + error.message);
            }
        })
    };

    const EXTERNAL_URLS = {
        google: 'https://translate.google.com/?sl=auto&tl=zh-CN&text=',
        youdao: 'https://dict.youdao.com/w/',
        cambridge: 'https://dictionary.cambridge.org/dictionary/english-chinese-simplified/'
    };

    // 添加样式
    GM_addStyle(`
        /* 主题变量与面板基础 */
        .translator-panel {
            --panel-bg: #fff;
            --panel-text: #2c3e50;
            --panel-border: #e2e8f0;
            --panel-shadow: rgba(0, 0, 0, 0.1);
            --title-bg: #f8fafc;
            --title-text: #334155;
            --title-border: #e2e8f0;
            --text-secondary: #475569;
            --text-tertiary: #64748b;
            --hover-bg: #f1f5f9;
            --title-hover-bg: #e2e8f0;
            --highlight-bg: rgba(245, 158, 11, 0.22);
            --highlight-hover-bg: rgba(245, 158, 11, 0.38);
            --highlight-line: rgba(217, 119, 6, 0.7);
            --active-link: #3b82f6;
            --error: #ef4444;
            --spacing-xs: 2px;
            --spacing-sm: 4px;
            --spacing-md: 6px;
            --spacing-lg: 8px;
            --spacing-xl: 12px;
            --font-xs: 10px;
            --font-sm: 12px;
            --font-lg: 14px;
            --font-xl: 16px;
            --theme-transition: background-color 0.15s ease-out,
                                color 0.15s ease-out,
                                border-color 0.15s ease-out;

            position: absolute !important;
            z-index: 2147483647 !important;
            display: none;
            flex-direction: column !important;
            box-sizing: border-box !important;
            max-width: ${CONFIG.panelWidth}px !important;
            max-height: calc(100vh - ${CONFIG.panelSpacing * 2}px) !important;
            overflow: hidden !important;
            padding: var(--spacing-md) !important;
            border: 1px solid var(--panel-border) !important;
            border-radius: 6px !important;
            background: var(--panel-bg) !important;
            box-shadow: 0 4px 12px var(--panel-shadow) !important;
            color: var(--panel-text) !important;
            font-size: ${CONFIG.fontSize}px !important;
            line-height: 1.5 !important;
            opacity: 0;
            transform: translateY(-10px);
            transition: var(--theme-transition), opacity 0.3s, transform 0.3s !important;
        }

        .translator-panel.translator-panel-dark {
            --panel-bg: #1a1a1a;
            --panel-text: #e0e0e0;
            --panel-border: #333;
            --panel-shadow: rgba(0, 0, 0, 0.3);
            --title-bg: #2c2c2c;
            --title-text: #e0e0e0;
            --title-border: #333;
            --text-secondary: #999;
            --text-tertiary: #888;
            --hover-bg: rgba(255, 255, 255, 0.1);
            --title-hover-bg: rgba(255, 255, 255, 0.16);
            --active-link: #4a9eff;
            --error: #ff7875;
        }

        /* 隔离宿主网页样式；必须放在组件规则之前 */
        .translator-panel * {
            all: revert;
            box-sizing: border-box !important;
            margin: 0 !important;
            padding: 0 !important;
            color: inherit !important;
            font-family: inherit !important;
            line-height: inherit !important;
            pointer-events: auto !important;
        }

        .translator-panel.show {
            opacity: 1 !important;
            transform: translateY(0) !important;
        }

        .translator-panel.dropdown-open {
            overflow: visible !important;
        }

        .translator-panel.dragging {
            cursor: move !important;
            opacity: 0.95 !important;
            pointer-events: none !important;
            transition: none !important;
        }

        /* 标题栏与翻译器切换 */
        .translator-panel .title-bar {
            position: relative !important;
            display: flex !important;
            align-items: center !important;
            justify-content: flex-start !important;
            gap: var(--spacing-md) !important;
            min-width: 0 !important;
            margin: calc(-1 * var(--spacing-md)) calc(-1 * var(--spacing-md)) var(--spacing-md) !important;
            padding: var(--spacing-xs) var(--spacing-md) !important;
            border-bottom: 1px solid var(--title-border) !important;
            border-radius: 6px 6px 0 0 !important;
            background: var(--title-bg) !important;
            flex: 0 0 auto !important;
            cursor: move !important;
            user-select: none !important;
            transition: var(--theme-transition) !important;
        }


        .translator-panel .title-wrapper {
            position: relative !important;
            display: inline-flex !important;
            align-items: center !important;
            flex: 0 0 auto !important;
            width: max-content !important;
            gap: var(--spacing-sm) !important;
            margin-right: auto !important;
            padding: var(--spacing-xs) var(--spacing-lg) !important;
            border: 0 !important;
            border-radius: var(--spacing-sm) !important;
            background: transparent !important;
            cursor: pointer !important;
            transition: background-color 0.2s !important;
        }

        .translator-panel .title-wrapper:hover,
        .translator-panel .title-wrapper.open {
            background: var(--title-hover-bg) !important;
        }

        .translator-panel .title,
        .translator-panel .switch-text {
            overflow: hidden !important;
            text-overflow: ellipsis !important;
            white-space: nowrap !important;
            font-size: var(--font-sm) !important;
        }

        .translator-panel .title {
            color: var(--title-text) !important;
            font-weight: 500 !important;
        }

        .translator-panel .switch-text {
            color: var(--text-tertiary) !important;
            opacity: 0.8 !important;
        }

        .translator-panel .switch-icon {
            flex: 0 0 auto !important;
            width: 8px !important;
            height: 5px !important;
            margin-left: 2px !important;
            background: var(--text-tertiary) !important;
            clip-path: polygon(0 0, 100% 0, 50% 100%) !important;
            transform: rotate(0deg) !important;
            transform-origin: center !important;
            transition: transform 0.2s ease !important;
        }

        .translator-panel .switch-icon.open {
            transform: rotate(180deg) !important;
        }

        /* 标题栏图标按钮 */
        .translator-panel .theme-button,
        .translator-panel .pin-button,
        .translator-panel .clear-button,
        .translator-panel .external-button,
        .translator-panel .unhighlight-button {
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            flex: 0 0 var(--font-xl) !important;
            width: var(--font-xl) !important;
            height: var(--font-xl) !important;
            border: 0 !important;
            background: transparent !important;
            color: var(--title-text) !important;
            cursor: pointer !important;
            opacity: 0.62 !important;
            transition: opacity 0.2s !important;
        }

        .translator-panel .theme-button:hover,
        .translator-panel .pin-button:hover,
        .translator-panel .clear-button:hover,
        .translator-panel .external-button:hover,
        .translator-panel .unhighlight-button:hover {
            opacity: 1 !important;
        }

        .translator-panel .unhighlight-button[hidden] {
            display: none !important;
        }

        .translator-panel .theme-button,
        .translator-panel .pin-button,
        .translator-panel .clear-button,
        .translator-panel .external-button,
        .translator-panel .unhighlight-button {
            position: relative !important;
        }

        .translator-panel .theme-button::before,
        .translator-panel .theme-button::after,
        .translator-panel .pin-button::before,
        .translator-panel .pin-button::after,
        .translator-panel .clear-button::before,
        .translator-panel .clear-button::after,
        .translator-panel .external-button::before,
        .translator-panel .external-button::after,
        .translator-panel .unhighlight-button::before,
        .translator-panel .unhighlight-button::after {
            content: "" !important;
            position: absolute !important;
            display: block !important;
            box-sizing: border-box !important;
            pointer-events: none !important;
        }

        /* 固定：圆形图钉，固定后填充 */
        .translator-panel .pin-button::before {
            top: 1px !important;
            left: 4px !important;
            width: 8px !important;
            height: 8px !important;
            border: 1.5px solid currentColor !important;
            border-radius: 50% !important;
        }

        .translator-panel .pin-button::after {
            top: 8px !important;
            left: 7px !important;
            width: 2px !important;
            height: 8px !important;
            border-radius: 1px !important;
            background: currentColor !important;
        }

        .translator-panel .pin-button.pinned::before {
            background: currentColor !important;
        }

        /* 主题：亮色状态显示月亮，暗色状态显示太阳 */
        .translator-panel .theme-button.light::before {
            top: 1px !important;
            left: 1px !important;
            width: 14px !important;
            height: 14px !important;
            border: 1.5px solid currentColor !important;
            border-radius: 50% !important;
        }

        .translator-panel .theme-button.light::after {
            top: -1px !important;
            left: 6px !important;
            width: 11px !important;
            height: 11px !important;
            border-radius: 50% !important;
            background: var(--title-bg) !important;
        }

        .translator-panel .theme-button.dark::before {
            top: 4px !important;
            left: 4px !important;
            width: 8px !important;
            height: 8px !important;
            border: 1.5px solid currentColor !important;
            border-radius: 50% !important;
        }

        .translator-panel .theme-button.dark::after {
            top: 0 !important;
            left: 7px !important;
            width: 2px !important;
            height: 2px !important;
            border-radius: 1px !important;
            background: currentColor !important;
            box-shadow:
                0 14px 0 currentColor,
                -7px 7px 0 currentColor,
                7px 7px 0 currentColor,
                -5px 2px 0 currentColor,
                5px 2px 0 currentColor,
                -5px 12px 0 currentColor,
                5px 12px 0 currentColor !important;
        }

        /* 关闭：两条交叉线 */
        .translator-panel .clear-button::before,
        .translator-panel .clear-button::after {
            top: 7px !important;
            left: 1px !important;
            width: 14px !important;
            height: 2px !important;
            border-radius: 1px !important;
            background: currentColor !important;
        }

        .translator-panel .clear-button::before {
            transform: rotate(45deg) !important;
        }

        .translator-panel .clear-button::after {
            transform: rotate(-45deg) !important;
        }

        /* 外部打开：方框与右上箭头 */
        .translator-panel .external-button::before {
            left: 1px !important;
            bottom: 1px !important;
            width: 11px !important;
            height: 11px !important;
            border: 1.5px solid currentColor !important;
            border-radius: 2px !important;
        }

        .translator-panel .external-button::after {
            top: 0 !important;
            right: 0 !important;
            width: 9px !important;
            height: 9px !important;
            border-top: 1.5px solid currentColor !important;
            border-right: 1.5px solid currentColor !important;
            background: linear-gradient(135deg,
                transparent 43%, currentColor 44%, currentColor 56%, transparent 57%) !important;
        }

        /* 取消高亮：倾斜橡皮擦 */
        .translator-panel .unhighlight-button::before {
            top: 3px !important;
            left: 2px !important;
            width: 12px !important;
            height: 8px !important;
            border: 1.5px solid currentColor !important;
            border-radius: 2px !important;
            transform: rotate(-45deg) !important;
        }

        .translator-panel .unhighlight-button::after {
            top: 12px !important;
            left: 2px !important;
            width: 12px !important;
            height: 1.5px !important;
            border-radius: 1px !important;
            background: currentColor !important;
        }

        /* 翻译器下拉菜单 */
        .translator-panel .dropdown-menu {
            position: absolute !important;
            top: calc(100% + 4px) !important;
            left: 0 !important;
            z-index: 2147483647 !important;
            min-width: 150px !important;
            max-height: 300px !important;
            overflow-y: auto !important;
            border: 1px solid var(--panel-border) !important;
            border-radius: 6px !important;
            background: var(--panel-bg) !important;
            box-shadow: 0 2px 8px var(--panel-shadow) !important;
            opacity: 0 !important;
            visibility: hidden !important;
            transform: scale(0.95) !important;
            transform-origin: top left !important;
            transition: opacity 0.15s ease-out, transform 0.15s ease-out, visibility 0.15s !important;
        }

        .translator-panel .dropdown-menu.open-upward {
            top: auto !important;
            bottom: calc(100% + 4px) !important;
            transform-origin: bottom left !important;
        }

        .translator-panel .dropdown-menu.align-right {
            right: 0 !important;
            left: auto !important;
        }

        .translator-panel .dropdown-menu.show {
            visibility: visible !important;
            opacity: 1 !important;
            transform: scale(1) !important;
        }

        .translator-panel .dropdown-menu::before,
        .translator-panel .dropdown-menu::after,
        .translator-panel .title-wrapper::before,
        .translator-panel .title-wrapper::after,
        .translator-panel .title-bar::before,
        .translator-panel .title-bar::after {
            content: none !important;
            display: none !important;
        }

        .translator-panel .dropdown-item {
            position: relative !important;
            display: flex !important;
            align-items: center !important;
            justify-content: space-between !important;
            padding: var(--spacing-md) var(--spacing-xl) !important;
            color: var(--panel-text) !important;
            font-size: var(--font-sm) !important;
            white-space: nowrap !important;
            cursor: pointer !important;
        }

        .translator-panel .dropdown-item:hover {
            background: var(--hover-bg) !important;
        }

        .translator-panel .translator-name {
            display: flex !important;
            align-items: center !important;
            gap: var(--spacing-sm) !important;
        }

        .translator-panel .dropdown-item.active .translator-name {
            font-weight: 600 !important;
        }

        .translator-panel .dropdown-item.is-default .translator-name::after {
            content: '默认' !important;
            margin-left: var(--spacing-sm) !important;
            padding: 2px 4px !important;
            border-radius: 3px !important;
            background: var(--text-tertiary) !important;
            color: var(--panel-bg) !important;
            font-size: var(--font-xs) !important;
            font-weight: 400 !important;
            opacity: 0.8 !important;
        }

        .translator-panel .set-default {
            padding: var(--spacing-xs) var(--spacing-sm) !important;
            border-radius: var(--spacing-xs) !important;
            color: var(--text-tertiary) !important;
            font-size: var(--font-xs) !important;
            opacity: 0 !important;
            transition: color 0.2s, background-color 0.2s, opacity 0.2s !important;
        }

        .translator-panel .dropdown-item:hover .set-default {
            opacity: 1 !important;
        }

        .translator-panel .set-default:hover {
            background: var(--hover-bg) !important;
            color: var(--active-link) !important;
        }

        .translator-panel .dropdown-item.is-default .set-default {
            display: none !important;
        }

        /* 加载状态与网页高亮 */
        .translator-panel .loading-bar {
            position: absolute !important;
            top: 27px !important;
            left: 0 !important;
            right: 0 !important;
            height: 2px !important;
            overflow: hidden !important;
            opacity: 0 !important;
            pointer-events: none !important;
        }

        .translator-panel.loading .loading-bar {
            opacity: 1 !important;
        }

        .translator-panel .loading-bar::after {
            content: '' !important;
            display: block !important;
            width: 38% !important;
            height: 100% !important;
            background: var(--active-link) !important;
            animation: popdict-loading 0.9s ease-in-out infinite !important;
        }

        @keyframes popdict-loading {
            from { transform: translateX(-110%); }
            to { transform: translateX(290%); }
        }

        .popdict-highlight {
            background: var(--highlight-bg, rgba(245, 158, 11, 0.22)) !important;
            box-shadow: inset 0 -2px var(--highlight-line, rgba(217, 119, 6, 0.7)) !important;
            border-radius: 2px !important;
            cursor: help !important;
        }

        .popdict-highlight:hover {
            background: var(--highlight-hover-bg, rgba(245, 158, 11, 0.38)) !important;
        }

        /* 翻译内容 */
        .translator-panel .content {
            position: relative !important;
            display: flex !important;
            flex: 1 1 auto !important;
            flex-direction: column !important;
            min-height: 0 !important;
            height: auto !important;
            max-height: none !important;
            overflow: hidden !important;
        }

        .translator-panel .source-text-container {
            flex: 0 0 auto !important;
            overflow: visible !important;
            margin: calc(-1 * var(--spacing-md)) calc(-1 * var(--spacing-md)) 0 !important;
            padding: var(--spacing-md) var(--spacing-lg) var(--spacing-md) calc(var(--spacing-lg) + var(--spacing-sm)) !important;
            border-bottom: 1px solid var(--panel-border) !important;
            background: var(--panel-bg) !important;
            transition: var(--theme-transition) !important;
        }

        .translator-panel .source-text,
        .translator-panel .translation,
        .translator-panel .def-content {
            overflow-wrap: anywhere !important;
        }

        .translator-panel .source-text {
            color: var(--text-secondary) !important;
            font-size: ${CONFIG.sourceFontSize}px !important;
            white-space: pre-wrap !important;
            user-select: text !important;
        }

        .translator-panel .source-text strong {
            color: var(--panel-text) !important;
            font-weight: 600 !important;
        }

        .translator-panel .translation-container {
            display: block !important;
            flex: 1 1 auto !important;
            min-height: 0 !important;
            max-height: none !important;
            overflow-y: auto !important;
            padding: var(--spacing-md) !important;
        }

        .translator-panel .translation {
            max-width: 100% !important;
            overflow: visible !important;
            color: var(--panel-text) !important;
            font-size: ${CONFIG.translationFontSize}px !important;
            white-space: normal !important;
            user-select: text !important;
        }

        .translator-panel .error {
            padding: var(--spacing-xl) 0 !important;
            color: var(--error) !important;
            font-size: var(--font-sm) !important;
            text-align: center !important;
        }

        /* 词典释义组件 */
        .translator-panel .phonetic-buttons,
        .translator-panel .sense-phonetic {
            display: flex !important;
            flex-wrap: wrap !important;
        }

        .translator-panel .phonetic-buttons {
            gap: var(--spacing-xl) !important;
            margin-bottom: var(--spacing-sm) !important;
        }

        .translator-panel .phonetic-item {
            display: flex !important;
            align-items: center !important;
            gap: var(--spacing-xs) !important;
            padding: var(--spacing-xs) var(--spacing-sm) !important;
            color: var(--text-secondary) !important;
            white-space: nowrap !important;
            user-select: text !important;
        }

        .translator-panel .audio-button {
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            padding: var(--spacing-xs) var(--spacing-sm) !important;
            border: 0 !important;
            border-radius: var(--spacing-xs) !important;
            background: transparent !important;
            color: var(--active-link) !important;
            font-size: var(--font-xl) !important;
            cursor: pointer !important;
            transition: background-color 0.2s, transform 0.2s !important;
        }

        .translator-panel .audio-button:hover {
            background: var(--hover-bg) !important;
        }

        .translator-panel .audio-button:active {
            transform: scale(0.95) !important;
        }

        .translator-panel .sense-block {
            display: flex !important;
            align-items: flex-start !important;
            gap: var(--spacing-md) !important;
            margin: var(--spacing-xs) 0 !important;
            padding: var(--spacing-xs) 0 !important;
            border-bottom: 1px solid var(--panel-border) !important;
            transition: var(--theme-transition) !important;
        }

        .translator-panel .sense-block:first-child {
            margin-top: 0 !important;
        }

        .translator-panel .sense-block:last-child {
            margin-bottom: 0 !important;
            border-bottom: 0 !important;
        }

        .translator-panel .pos-tags {
            display: flex !important;
            flex-direction: column !important;
            flex-shrink: 0 !important;
            align-items: center !important;
            min-width: 35px !important;
            gap: var(--spacing-xs) !important;
        }

        .translator-panel .pos-tag {
            width: 100% !important;
            padding: var(--spacing-xs) var(--spacing-sm) !important;
            border-radius: var(--spacing-xs) !important;
            background: var(--pos-color, #6b7280) !important;
            color: #fff !important;
            font-size: var(--font-sm) !important;
            font-weight: 500 !important;
            text-align: center !important;
            user-select: text !important;
        }

        .translator-panel .level-tag {
            min-width: 24px !important;
            margin-top: var(--spacing-xs) !important;
            padding: var(--spacing-xs) var(--spacing-sm) !important;
            border-radius: 3px !important;
            font-size: var(--font-xs) !important;
            font-weight: 500 !important;
            letter-spacing: 0.5px !important;
            text-align: center !important;
        }

        .translator-panel .def-content {
            flex: 1 !important;
            min-width: 0 !important;
            overflow: visible !important;
        }

        .translator-panel .sense-phonetic {
            gap: var(--spacing-md) !important;
            margin-bottom: var(--spacing-xs) !important;
            opacity: 0.8 !important;
        }

        .translator-panel .sense-phonetic .phonetic-item {
            flex: 0 1 auto !important;
            color: var(--text-secondary) !important;
            font-size: var(--font-sm) !important;
        }

        .translator-panel .sense-phonetic .audio-button {
            padding: var(--spacing-xs) !important;
            font-size: var(--font-lg) !important;
        }

        /* 滚动条 */
        .translator-panel .dropdown-menu::-webkit-scrollbar {
            width: 3px !important;
            height: 3px !important;
        }

        .translator-panel .translation-container::-webkit-scrollbar {
            width: 5px !important;
            height: 5px !important;
        }

        .translator-panel .dropdown-menu::-webkit-scrollbar-thumb,
        .translator-panel .translation-container::-webkit-scrollbar-thumb {
            border-radius: 4px !important;
            background: var(--text-tertiary) !important;
        }

        .translator-panel .dropdown-menu::-webkit-scrollbar-thumb:hover,
        .translator-panel .translation-container::-webkit-scrollbar-thumb:hover {
            background: var(--text-secondary) !important;
        }

        .translator-panel .dropdown-menu::-webkit-scrollbar-track {
            background: transparent !important;
        }

        .translator-panel .translation-container::-webkit-scrollbar-track {
            border-radius: 4px !important;
            background: var(--hover-bg) !important;
        }
    `);

    // 仅保留跨窗口共享且确实需要的状态。
    const state = {
        isDragging: false,
        lastClickTime: 0,
        clickCount: 0,
        ignoreNextSelection: false,
        isSelectingInPanel: false,
        isRightClickPending: false
    };

    let dragState = null;
    let hoverPanel = null;
    let hoverHideTimer = null;
    const highlightStore = new WeakMap();

    const utils = {
        escapeMap: {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'},
        escapeHtml: text => text.replace(/[&<>"']/g, c => utils.escapeMap[c]),
        isDarkMode: () => GM_getValue('darkMode', false),
        toggleDarkMode() {
            const isDark = !this.isDarkMode();
            GM_setValue('darkMode', isDark);
            document.querySelectorAll('.translator-panel').forEach(panel => {
                panel.classList.toggle(CONFIG.darkModeClass, isDark);
                const button = panel.querySelector('.theme-button');
                if (button) {
                    button.className = `theme-button ${isDark ? 'dark' : 'light'}`;
                    button.title = isDark ? '切换亮色模式' : '切换深色模式';
                }
            });
        },
        debounce(fn, delay) {
            let timer;
            return (...args) => {
                clearTimeout(timer);
                timer = setTimeout(() => fn(...args), delay);
            };
        },
        setError(message, targetPanel) {
            const content = targetPanel?.querySelector('.content');
            if (!content) return;
            content.innerHTML = `<div class="error">${utils.escapeHtml(message)}</div>`;
            requestAnimationFrame(() => utils.fitPanelToViewport(targetPanel));
        },
        fitPanelToViewport(targetPanel) {
            if (!targetPanel?.isConnected || targetPanel.style.display === 'none') return;

            const {innerWidth: vw, innerHeight: vh, scrollX: sx, scrollY: sy} = window;
            const spacing = CONFIG.panelSpacing;
            const viewportMaxHeight = Math.max(
                CONFIG.titleBarHeight,
                Math.min(Math.floor(vh * CONFIG.maxPanelHeightRatio), vh - spacing * 2)
            );
            const minHeight = Math.min(CONFIG.titleBarHeight + 48, viewportMaxHeight);

            targetPanel.style.display = 'flex';
            targetPanel.style.setProperty('max-height', `${viewportMaxHeight}px`, 'important');

            // 拖动后的窗口只约束在视口内，不再跳回最初选中文字的位置。
            if (targetPanel.manualPosition) {
                const rect = targetPanel.getBoundingClientRect();
                const panelWidth = Math.min(targetPanel.offsetWidth || CONFIG.panelWidth, vw - spacing * 2);
                const panelHeight = Math.min(targetPanel.offsetHeight || minHeight, viewportMaxHeight);
                const left = Math.min(Math.max(rect.left, spacing), Math.max(spacing, vw - panelWidth - spacing));
                const top = Math.min(Math.max(rect.top, spacing), Math.max(spacing, vh - panelHeight - spacing));
                targetPanel.style.left = `${left + sx}px`;
                targetPanel.style.top = `${top + sy}px`;
                return;
            }

            const anchor = targetPanel.anchorPoint;
            if (!anchor) return;

            const anchorX = anchor.x - sx;
            const anchorY = anchor.y - sy;
            const measuredHeight = Math.min(
                Math.max(targetPanel.offsetHeight || minHeight, minHeight),
                viewportMaxHeight
            );
            const spaceBelow = Math.max(0, vh - anchorY - spacing);
            const spaceAbove = Math.max(0, anchorY - spacing);
            const placeBelow = spaceBelow >= measuredHeight || spaceBelow >= spaceAbove;
            const availableHeight = placeBelow ? spaceBelow : spaceAbove;
            const maxHeight = Math.max(minHeight, Math.min(viewportMaxHeight, availableHeight));

            targetPanel.style.setProperty('max-height', `${maxHeight}px`, 'important');

            const panelWidth = Math.min(targetPanel.offsetWidth || CONFIG.panelWidth, vw - spacing * 2);
            const panelHeight = Math.min(targetPanel.offsetHeight || minHeight, maxHeight);
            const left = Math.min(Math.max(anchorX, spacing), Math.max(spacing, vw - panelWidth - spacing));
            const rawTop = placeBelow
                ? anchorY + spacing
                : anchorY - panelHeight - spacing;
            const top = Math.min(Math.max(rawTop, spacing), Math.max(spacing, vh - panelHeight - spacing));

            targetPanel.style.left = `${left + sx}px`;
            targetPanel.style.top = `${top + sy}px`;
        },
        showPanel(x, y, targetPanel) {
            targetPanel.anchorPoint = {x, y};
            targetPanel.manualPosition = false;
            Object.assign(targetPanel.style, {
                left: '-9999px',
                top: '-9999px',
                display: 'flex'
            });

            this.fitPanelToViewport(targetPanel);
            targetPanel.classList.toggle(CONFIG.darkModeClass, this.isDarkMode());
            requestAnimationFrame(() => targetPanel.classList.add('show'));
        },
        hidePanel(targetPanel) {
            if (!targetPanel || targetPanel.classList.contains('pinned')) return;
            targetPanel.classList.remove('show');
            setTimeout(() => {
                if (targetPanel.classList.contains('show')) return;
                if (targetPanel === hoverPanel) hoverPanel = null;
                targetPanel.remove();
            }, CONFIG.animationDuration);
        },
        isTranslatable(text) {
            const compact = text.trim().replace(/\s+/g, '');
            if (!compact) return false;
            if (/[a-zA-Z]/.test(compact)) return true;
            const hasChinese = /[\u4e00-\u9fff]/.test(compact);
            const hasOtherLanguage = /[^\u4e00-\u9fff\d\s\p{P}\p{S}]/u.test(compact);
            if (hasChinese && !hasOtherLanguage) return false;
            return !/^[\d\s\p{P}\p{S}]+$/u.test(compact);
        },
        isEditableTarget: target => target instanceof Element && Boolean(
            target.closest('input, textarea, select, option, [contenteditable]:not([contenteditable="false"])')
        ),
        isClickInPanel: e => e.target instanceof Element && Boolean(e.target.closest('.translator-panel')),
        preventSelectionTrigger() {
            state.ignoreNextSelection = true;
            setTimeout(() => { state.ignoreNextSelection = false; }, 100);
        }
    };

    const buildContentHTML = (text, html) => `
        <div class="source-text-container">
            <div class="source-text"><strong>${utils.escapeHtml(text).replace(/\n/g, '<br>')}</strong></div>
        </div>
        <div class="translation-container"><div class="translation">${html}</div></div>`;

    function getTextOffset(container, node, offset) {
        const range = document.createRange();
        range.selectNodeContents(container);
        range.setEnd(node, offset);
        return range.toString().length;
    }

    function captureSelectionBookmark(range) {
        let container = range.commonAncestorContainer;
        if (container.nodeType === Node.TEXT_NODE) container = container.parentElement;
        while (container?.classList?.contains('popdict-highlight')) container = container.parentElement;
        if (!container || container.closest?.('.translator-panel')) return null;

        try {
            const start = getTextOffset(container, range.startContainer, range.startOffset);
            return { container, start, end: start + range.toString().length, text: range.toString() };
        } catch {
            return null;
        }
    }

    // 词典只接收单词或短语；谷歌保留完整选区。所有判断均在请求前完成。
    function prepareSelection(text, translatorKey) {
        const leading = text.length - text.trimStart().length;
        const trimmed = text.trim();
        if (!trimmed) return null;

        if (translatorKey === 'google') {
            return { text: trimmed, start: leading, end: leading + trimmed.length };
        }

        const token = String.raw`[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*`;
        const phrasePattern = new RegExp(`${token}(?:\\s+${token})*`, 'g');
        const matches = Array.from(trimmed.matchAll(phrasePattern))
            .filter(match => /[A-Za-z]/.test(match[0]));

        // 中英文混选时仅接受唯一的英文片段；多个片段直接静默忽略。
        const hasNonPhraseText = /[^A-Za-z0-9'’\s-]/.test(trimmed);
        let candidate = trimmed;
        let relativeStart = 0;
        if (hasNonPhraseText) {
            if (matches.length !== 1) return null;
            candidate = matches[0][0];
            relativeStart = matches[0].index;
        }

        const words = candidate.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || [];
        const isDictionaryPhrase = words.length >= 1
            && words.length <= 6
            && candidate.length <= 60
            && new RegExp(`^${token}(?:\\s+${token})*$`).test(candidate);

        if (!isDictionaryPhrase) return null;

        const start = leading + relativeStart;
        return { text: candidate, start, end: start + candidate.length };
    }

    function rangeFromBookmark({container, start, end}) {
        if (!container?.isConnected || end <= start) return null;
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        let node, offset = 0, started = false;

        while ((node = walker.nextNode())) {
            const next = offset + node.data.length;
            if (!started && start <= next) {
                range.setStart(node, Math.max(0, start - offset));
                started = true;
            }
            if (started && end <= next) {
                range.setEnd(node, Math.max(0, end - offset));
                return range;
            }
            offset = next;
        }
        return null;
    }

    function setHighlightButton(panel, visible) {
        const button = panel?.querySelector('.unhighlight-button');
        if (button) button.hidden = !visible;
    }

    function removeHighlight(span) {
        if (!span?.isConnected) return;
        const data = highlightStore.get(span);
        if (data?.ownerPanel?.highlightElement === span) {
            data.ownerPanel.highlightElement = null;
            setHighlightButton(data.ownerPanel, false);
        }
        if (hoverPanel?.highlightElement === span) hideHoverPanel();

        const parent = span.parentNode;
        span.replaceWith(...span.childNodes);
        parent?.normalize();
    }

    function applyHighlight(bookmark, result, targetPanel) {
        const {container, start, end, text} = bookmark || {};
        if (!container?.isConnected || !text || end <= start) return null;

        // 只有新查询成功后才移除重叠高亮，因此失败不会破坏旧标记。
        container.querySelectorAll('.popdict-highlight').forEach(span => {
            const spanStart = getTextOffset(container, span, 0);
            const spanEnd = spanStart + span.textContent.length;
            if (spanStart < end && spanEnd > start) removeHighlight(span);
        });

        const range = rangeFromBookmark(bookmark);
        if (!range || range.collapsed) return null;

        const span = document.createElement('span');
        span.className = 'popdict-highlight';
        span.appendChild(range.extractContents());
        range.insertNode(span);

        highlightStore.set(span, {
            text,
            html: result.html,
            translatorKey: targetPanel.translatorKey,
            ownerPanel: targetPanel
        });
        targetPanel.highlightElement = span;
        setHighlightButton(targetPanel, true);
        return span;
    }

    function hideHoverPanel(force = false) {
        clearTimeout(hoverHideTimer);
        hoverHideTimer = null;
        if (!hoverPanel) return;
        if (!force && hoverPanel.classList.contains('pinned')) return;
        hoverPanel.remove();
        hoverPanel = null;
    }

    function scheduleHideHover() {
        clearTimeout(hoverHideTimer);
        hoverHideTimer = setTimeout(hideHoverPanel, CONFIG.hoverHideDelay);
    }

    function showHoverPanel(span) {
        const data = highlightStore.get(span);
        // 当前查询窗口仍存在时，同一处高亮不再额外弹出悬浮窗。
        if (!data || data.ownerPanel?.isConnected) return;
        if (hoverPanel && !hoverPanel.isConnected) hoverPanel = null;
        if (hoverPanel?.highlightElement === span) return;

        hideHoverPanel();
        const panel = createTranslatorPanel({
            translatorKey: data.translatorKey,
            translationText: data.text,
            highlightElement: span,
            resultHtml: data.html
        });
        document.body.appendChild(panel);
        highlightStore.set(span, {...data, ownerPanel: panel});

        panel.addEventListener('mouseenter', () => clearTimeout(hoverHideTimer));
        panel.addEventListener('mouseleave', e => {
            if (!panel.classList.contains('pinned') && e.relatedTarget !== span) scheduleHideHover();
        });
        hoverPanel = panel;

        const rect = span.getBoundingClientRect();
        utils.showPanel(rect.left + window.scrollX, rect.bottom + window.scrollY, panel);
    }

    function resetPanelSelection() {
        state.isSelectingInPanel = false;
        document.body.style.userSelect = '';
        utils.preventSelectionTrigger();
    }

    async function translate(text, targetPanel) {
        if (!text || !targetPanel) throw new Error('翻译参数无效');

        const textToTranslate = text.replace(/\n\s*\n/g, '\n\n').replace(/\s*\n\s*/g, '\n').trim();
        if (!textToTranslate) throw new Error('翻译文本为空');

        const translator = TRANSLATORS[targetPanel.translatorKey];
        if (!translator) throw new Error('未找到指定的翻译器');

        targetPanel.translationText = textToTranslate;
        const requestId = ++targetPanel.requestId;
        const loadingTimer = setTimeout(() => {
            if (requestId === targetPanel.requestId) targetPanel.classList.add('loading');
        }, CONFIG.loadingDelay);

        try {
            const result = await translator.translate(textToTranslate);
            if (requestId !== targetPanel.requestId) return null;

            const content = targetPanel.querySelector('.content');
            if (!content) throw new Error('未找到内容容器元素');
            content.innerHTML = buildContentHTML(textToTranslate, result.html);
            requestAnimationFrame(() => utils.fitPanelToViewport(targetPanel));

            if (targetPanel.highlightElement && !targetPanel.highlightElement.isConnected) {
                targetPanel.highlightElement = null;
                setHighlightButton(targetPanel, false);
            }

            if (result.highlightable) {
                if (targetPanel.highlightElement?.isConnected) {
                    highlightStore.set(targetPanel.highlightElement, {
                        text: textToTranslate,
                        html: result.html,
                        translatorKey: targetPanel.translatorKey,
                        ownerPanel: targetPanel
                    });
                    setHighlightButton(targetPanel, true);
                } else if (targetPanel.selectionBookmark) {
                    applyHighlight(targetPanel.selectionBookmark, result, targetPanel);
                }
            }

            return result;
        } finally {
            clearTimeout(loadingTimer);
            if (requestId === targetPanel.requestId) targetPanel.classList.remove('loading');
        }
    }

    function buildPanelHTML(translatorKey) {
        return `<div class="title-bar">
                <div class="title-wrapper">
                    <span class="title">${TRANSLATORS[translatorKey].name}</span>
                    <span class="switch-text">（点击切换）</span>
                    <span class="switch-icon" aria-hidden="true"></span>
                    <div class="dropdown-menu"></div>
                </div>
                <div class="external-button" title="在新窗口打开翻译"></div>
                <button type="button" class="unhighlight-button" title="取消当前单词高亮" hidden></button>
                <div class="pin-button unpinned" title="固定窗口"></div>
                <div class="theme-button light" title="切换深色模式"></div>
                <div class="clear-button" title="关闭所有窗口"></div>
            </div>
            <div class="loading-bar"></div>
            <div class="content"></div>`;
    }

    function createTranslatorPanel({
        translatorKey = GM_getValue('defaultTranslator', 'youdao'),
        translationText = '',
        highlightElement = null,
        resultHtml = ''
    } = {}) {
        const targetPanel = document.createElement('div');
        targetPanel.className = 'translator-panel';
        targetPanel.translatorKey = translatorKey;
        targetPanel.translationText = translationText;
        targetPanel.requestId = 0;
        targetPanel.anchorPoint = null;
        targetPanel.manualPosition = false;
        targetPanel.selectionBookmark = null;
        targetPanel.highlightElement = highlightElement;
        targetPanel.innerHTML = buildPanelHTML(translatorKey);
        if (translationText && resultHtml) {
            targetPanel.querySelector('.content').innerHTML = buildContentHTML(translationText, resultHtml);
        }
        setHighlightButton(targetPanel, Boolean(highlightElement));
        setupPanelEvents(targetPanel);
        return targetPanel;
    }

    const handleSelection = utils.debounce(async e => {
        if (isTranslating || state.ignoreNextSelection || utils.isEditableTarget(e.target)) return;

        const selection = window.getSelection();
        if (!selection?.rangeCount || utils.isClickInPanel(e)) return;

        const rawText = selection.toString();
        if (!rawText || !utils.isTranslatable(rawText)) return;

        const translatorKey = GM_getValue('defaultTranslator', 'youdao');
        const prepared = prepareSelection(rawText, translatorKey);
        if (!prepared) return;

        const selectedRange = selection.getRangeAt(0).cloneRange();
        const originalBookmark = captureSelectionBookmark(selectedRange);
        if (!originalBookmark) return;

        const bookmark = {
            container: originalBookmark.container,
            start: originalBookmark.start + prepared.start,
            end: originalBookmark.start + prepared.end,
            text: prepared.text
        };
        const range = rangeFromBookmark(bookmark);
        if (!range) return;
        const rect = range.getBoundingClientRect();

        isTranslating = true;
        cleanupPanels();
        let targetPanel = null;

        try {
            targetPanel = createTranslatorPanel({translatorKey});
            targetPanel.selectionBookmark = bookmark;
            document.body.appendChild(targetPanel);

            utils.showPanel(rect.left + window.scrollX, rect.bottom + window.scrollY, targetPanel);
            await translate(prepared.text, targetPanel);
        } catch (error) {
            console.error('处理选中文本时出错:', error);
            if (targetPanel) utils.setError(error.message || '翻译失败，请稍后重试', targetPanel);
        } finally {
            isTranslating = false;
        }
    }, CONFIG.triggerDelay);

    const eventHandlers = {
        handleMouseDown(e) {
            if (state.isSelectingInPanel) {
                e.stopPropagation();
                e.preventDefault();
                return;
            }
            if (e.button === 2) {
                state.isRightClickPending = true;
                return;
            }
            const now = Date.now();
            if (now - state.lastClickTime > CONFIG.doubleClickDelay) state.clickCount = 0;
            state.clickCount++;
            state.lastClickTime = now;
            if (state.clickCount >= 3) utils.preventSelectionTrigger();
        },
        handleMouseUp(e) {
            if (dragState) {
                dragState.panel.classList.remove('dragging');
                dragState = null;
                state.isDragging = false;
                utils.preventSelectionTrigger();
                e.stopPropagation();
                e.preventDefault();
                return;
            }
            if (state.isSelectingInPanel) {
                resetPanelSelection();
                e.stopPropagation();
                e.preventDefault();
                return;
            }
            if (state.isRightClickPending && e.button === 0) {
                document.querySelectorAll('.translator-panel:not(.pinned)').forEach(utils.hidePanel);
                state.isRightClickPending = false;
                utils.preventSelectionTrigger();
                return;
            }
            if (e.button === 2) {
                state.isRightClickPending = false;
                return;
            }
            if (utils.isClickInPanel(e) || state.isDragging) {
                utils.preventSelectionTrigger();
                return;
            }
            handleSelection(e);
        },
        handleOutsideClick(e) {
            if (state.isSelectingInPanel) {
                e.stopPropagation();
                e.preventDefault();
                return;
            }
            if (state.isRightClickPending || state.isDragging || utils.isClickInPanel(e)) return;
            document.querySelectorAll('.translator-panel:not(.pinned)').forEach(utils.hidePanel);
        }
    };

    document.addEventListener('mousedown', eventHandlers.handleMouseDown, {capture: true, passive: false});
    document.addEventListener('mouseup', eventHandlers.handleMouseUp, {capture: true, passive: false});
    document.addEventListener('click', eventHandlers.handleOutsideClick, {capture: true, passive: false});
    document.addEventListener('contextmenu', e => {
        if (!(e.target instanceof Element) || !e.target.closest('.translator-panel')) {
            state.isRightClickPending = true;
        }
    }, {passive: false});

    document.addEventListener('mouseover', e => {
        if (!(e.target instanceof Element)) return;
        const span = e.target.closest('.popdict-highlight');
        if (!span || span.contains(e.relatedTarget)) return;
        clearTimeout(hoverHideTimer);
        showHoverPanel(span);
    });

    document.addEventListener('mouseout', e => {
        if (!(e.target instanceof Element)) return;
        const span = e.target.closest('.popdict-highlight');
        if (!span || span.contains(e.relatedTarget) || hoverPanel?.contains(e.relatedTarget)) return;
        scheduleHideHover();
    });

    function refreshOpenDropdowns() {
        document.querySelectorAll('.translator-panel').forEach(panel => panel.refreshDropdown?.());
    }

    function setupTranslatorSwitch(targetPanel) {
        const titleWrapper = targetPanel.querySelector('.title-wrapper');
        const title = targetPanel.querySelector('.title');
        const switchIcon = targetPanel.querySelector('.switch-icon');
        const dropdownMenu = targetPanel.querySelector('.dropdown-menu');
        targetPanel.isDropdownOpen = false;

        const updateDropdownMenu = () => {
            const defaultTranslator = GM_getValue('defaultTranslator', 'youdao');
            dropdownMenu.innerHTML = Object.entries(TRANSLATORS).map(([key, translator]) => {
                const active = key === targetPanel.translatorKey ? ' active' : '';
                const isDefault = key === defaultTranslator ? ' is-default' : '';
                const check = active ? '✓ ' : '';
                return `<div class="dropdown-item${active}${isDefault}" data-translator="${key}">
                    <span class="translator-name">${check}${translator.name}</span>
                    <span class="set-default" title="设为默认翻译器">设为默认</span>
                </div>`;
            }).join('');
        };
        targetPanel.refreshDropdown = updateDropdownMenu;

        const toggleDropdown = show => {
            if (show === targetPanel.isDropdownOpen) return;
            targetPanel.isDropdownOpen = show;
            switchIcon.classList.toggle('open', show);
            titleWrapper.classList.toggle('open', show);

            if (show) {
                updateDropdownMenu();
                targetPanel.classList.add('dropdown-open');
                dropdownMenu.classList.remove('open-upward', 'align-right');
                dropdownMenu.classList.add('show');

                const titleRect = titleWrapper.getBoundingClientRect();
                const openUpward = titleRect.bottom + dropdownMenu.offsetHeight + 8 > window.innerHeight
                    && titleRect.top >= dropdownMenu.offsetHeight + 8;
                const alignRight = titleRect.left + dropdownMenu.offsetWidth + 8 > window.innerWidth;
                dropdownMenu.classList.toggle('open-upward', openUpward);
                dropdownMenu.classList.toggle('align-right', alignRight);
            } else {
                dropdownMenu.classList.remove('show');
                setTimeout(() => {
                    if (!targetPanel.isDropdownOpen) {
                        dropdownMenu.innerHTML = '';
                        dropdownMenu.classList.remove('open-upward', 'align-right');
                        targetPanel.classList.remove('dropdown-open');
                    }
                }, 150);
            }
        };

        targetPanel.addEventListener('click', e => {
            if (!e.target.closest('.title-wrapper') && targetPanel.isDropdownOpen) toggleDropdown(false);
        });

        titleWrapper.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            toggleDropdown(!targetPanel.isDropdownOpen);
        });

        dropdownMenu.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            const item = e.target.closest('.dropdown-item');
            if (!item) return;

            const translatorKey = item.dataset.translator;
            if (e.target.closest('.set-default')) {
                GM_setValue('defaultTranslator', translatorKey);
                refreshOpenDropdowns();
                return;
            }

            if (translatorKey !== targetPanel.translatorKey) {
                targetPanel.translatorKey = translatorKey;
                title.textContent = TRANSLATORS[translatorKey].name;
                if (targetPanel.translationText) {
                    translate(targetPanel.translationText, targetPanel).catch(error => {
                        console.error('切换翻译器失败:', error);
                        utils.setError(error.message || '翻译失败，请稍后重试', targetPanel);
                    });
                }
            }
            updateDropdownMenu();
        });

        targetPanel.addEventListener('mouseenter', () => clearTimeout(targetPanel.dropdownCloseTimer));
        targetPanel.addEventListener('mouseleave', () => {
            targetPanel.dropdownCloseTimer = setTimeout(() => toggleDropdown(false), 100);
        });
    }

    function beginPanelDrag(e, targetPanel) {
        if (e.button !== 0 || !e.target.closest('.title-bar')) return;
        if (e.target.closest('.title-wrapper, .pin-button, .theme-button, .clear-button, .external-button, .unhighlight-button, .dropdown-menu')) return;

        const rect = targetPanel.getBoundingClientRect();
        dragState = {
            panel: targetPanel,
            startX: e.clientX,
            startY: e.clientY,
            startLeft: rect.left + window.scrollX,
            startTop: rect.top + window.scrollY,
            scrollX: window.scrollX,
            scrollY: window.scrollY
        };
        state.isDragging = true;
        targetPanel.manualPosition = true;
        targetPanel.classList.add('dragging');
        e.preventDefault();
        e.stopPropagation();
    }

    // 所有窗口共用一组文档级拖动监听器，避免新窗口覆盖旧窗口的监听器。
    document.addEventListener('mousemove', e => {
        if (!dragState) return;
        const {panel, startX, startY, startLeft, startTop, scrollX, scrollY} = dragState;
        if (!panel.isConnected) {
            dragState = null;
            state.isDragging = false;
            return;
        }

        const desiredLeft = startLeft + e.clientX - startX + window.scrollX - scrollX;
        const desiredTop = startTop + e.clientY - startY + window.scrollY - scrollY;
        const minVisible = CONFIG.titleBarHeight;
        const viewportLeft = window.scrollX;
        const viewportTop = window.scrollY;

        panel.style.left = `${Math.max(
            viewportLeft - panel.offsetWidth + minVisible,
            Math.min(viewportLeft + window.innerWidth - minVisible, desiredLeft)
        )}px`;
        panel.style.top = `${Math.max(
            viewportTop,
            Math.min(viewportTop + window.innerHeight - minVisible, desiredTop)
        )}px`;
    });

    function setupPanelActions(targetPanel) {
        targetPanel.addEventListener('click', async e => {
            const audioButton = e.target.closest('.audio-button');
            if (audioButton) {
                e.preventDefault();
                e.stopPropagation();
                utils.preventSelectionTrigger();
                state.isSelectingInPanel = false;
                if (audioButton.dataset.url) await audio.play(audioButton.dataset.url);
                return;
            }

            if (e.target.closest('.unhighlight-button')) {
                e.preventDefault();
                e.stopPropagation();
                removeHighlight(targetPanel.highlightElement);
                return;
            }

            if (e.target.closest('.external-button')) {
                e.preventDefault();
                e.stopPropagation();
                utils.preventSelectionTrigger();
                const url = EXTERNAL_URLS[targetPanel.translatorKey];
                if (url && targetPanel.translationText) {
                    window.open(url + encodeURIComponent(targetPanel.translationText), '_blank');
                }
            }
        });
    }

    function setupPanelEvents(targetPanel) {
        setupTranslatorSwitch(targetPanel);
        setupPanelActions(targetPanel);

        const pinButton = targetPanel.querySelector('.pin-button');
        const themeButton = targetPanel.querySelector('.theme-button');
        const clearButton = targetPanel.querySelector('.clear-button');
        const isDark = utils.isDarkMode();

        themeButton.className = `theme-button ${isDark ? 'dark' : 'light'}`;
        themeButton.title = isDark ? '切换亮色模式' : '切换深色模式';

        pinButton.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            const pinned = targetPanel.classList.toggle('pinned');
            pinButton.className = `pin-button ${pinned ? 'pinned' : 'unpinned'}`;
            pinButton.title = pinned ? '取消固定' : '固定窗口';

            // 悬浮窗一旦固定，就转为普通窗口，不再受鼠标离开自动关闭控制。
            if (pinned && targetPanel === hoverPanel) {
                clearTimeout(hoverHideTimer);
                hoverHideTimer = null;
                hoverPanel = null;
            }
        });

        themeButton.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            utils.toggleDarkMode();
        });

        targetPanel.addEventListener('mousedown', e => {
            const inContent = e.target.closest('.content');
            if (inContent && !e.target.closest('.audio-button')) {
                const now = Date.now();
                state.clickCount = now - state.lastClickTime < CONFIG.doubleClickDelay ? state.clickCount + 1 : 1;
                state.lastClickTime = now;
                if (state.clickCount < 3) {
                    state.isSelectingInPanel = true;
                    document.body.style.userSelect = 'none';
                    e.stopPropagation();
                }
                return;
            }
            beginPanelDrag(e, targetPanel);
        });

        targetPanel.addEventListener('mousemove', e => {
            if (state.isSelectingInPanel) e.stopPropagation();
        });

        targetPanel.addEventListener('contextmenu', e => {
            const selection = window.getSelection();
            if (selection?.isCollapsed || !e.target.closest('.content')) {
                e.preventDefault();
                e.stopPropagation();
                document.querySelectorAll('.translator-panel:not(.pinned)').forEach(utils.hidePanel);
            }
        });

        clearButton.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            hideHoverPanel(true);
            document.querySelectorAll('.translator-panel').forEach(panel => panel.remove());
            if (dragState) dragState.panel.classList.remove('dragging');
            dragState = null;
            document.body.style.userSelect = '';
            Object.assign(state, {
                isDragging: false,
                lastClickTime: 0,
                clickCount: 0,
                ignoreNextSelection: false,
                isSelectingInPanel: false,
                isRightClickPending: false
            });
        });
    }

    // 浏览器窗口尺寸变化时，重新限制所有翻译窗口的高度和位置。
    window.addEventListener('resize', utils.debounce(() => {
        document.querySelectorAll('.translator-panel:not(.dragging)').forEach(panel => {
            utils.fitPanelToViewport(panel);
        });
    }, 100));

    // 页面滚动后，仅在窗口完全离开视口时将其拉回可见区域。
    let scrollTimer = null;
    window.addEventListener('scroll', () => {
        if (scrollTimer) return;
        scrollTimer = setTimeout(() => {
            scrollTimer = null;
            document.querySelectorAll('.translator-panel:not(.dragging)').forEach(panel => {
                if (!panel.isConnected || panel.style.display === 'none') return;
                const rect = panel.getBoundingClientRect();
                const outside = rect.right < CONFIG.panelSpacing
                    || rect.left > window.innerWidth - CONFIG.panelSpacing
                    || rect.bottom < CONFIG.panelSpacing
                    || rect.top > window.innerHeight - CONFIG.panelSpacing;
                if (!outside) return;

                panel.style.left = `${Math.max(
                    CONFIG.panelSpacing + window.scrollX,
                    Math.min(
                        window.scrollX + window.innerWidth - panel.offsetWidth - CONFIG.panelSpacing,
                        rect.left + window.scrollX
                    )
                )}px`;
                panel.style.top = `${Math.max(
                    CONFIG.panelSpacing + window.scrollY,
                    Math.min(
                        window.scrollY + window.innerHeight - panel.offsetHeight - CONFIG.panelSpacing,
                        rect.top + window.scrollY
                    )
                )}px`;
            });
        }, 100);
    }, {passive: true});
})();
