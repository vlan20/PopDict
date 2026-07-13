// ==UserScript==
// @name         PopDict 词窗 - 划词翻译
// @namespace    https://github.com/vlan20/popdict
// @version      0.1.3
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
        maxPanelHeight: 400,
        titleBarHeight: 40, // 添加标题栏高度配置
        animationDuration: 200, // 添加动画持续时间配置
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
        document.querySelectorAll('.translator-panel:not(.pinned)').forEach(panel => panel.remove());
    }

    // 添加音频播放功能
    const audio = {
        element: null,
        getElement() {
            if (!this.element) {
                this.element = document.createElement('audio');
                this.element.style.display = 'none';
                document.body.appendChild(this.element);
            }
            return this.element;
        },
        async play(url) {
            try {
                const audioElement = this.getElement();
                audioElement.src = url;
                await audioElement.play();
            } catch (error) {
                console.error('播放音频失败:', error);
            }
        }
    };

    // 封装 GM_xmlhttpRequest 为 Promise，并统一处理超时与 HTTP 错误。
    // 不再伪装固定的旧版 Chrome UA，让脚本管理器使用浏览器当前的真实 UA。
    const gmGet = (url, headers = {}, options = {}) => new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: 'GET',
            url,
            headers,
            timeout: 15000,
            anonymous: false,
            ...options,
            onload(response) {
                const status = Number(response.status) || 0;
                if ((status >= 200 && status < 300) || (status === 0 && response.responseText)) {
                    resolve(response);
                    return;
                }

                const error = new Error(`HTTP ${status || '未知状态'}`);
                error.status = status;
                error.finalUrl = response.finalUrl || url;
                error.responseText = response.responseText || '';
                reject(error);
            },
            onerror(response) {
                const error = new Error('网络请求失败');
                error.status = Number(response?.status) || 0;
                error.finalUrl = response?.finalUrl || url;
                reject(error);
            },
            ontimeout() {
                reject(new Error('请求超时'));
            }
        });
    });

    // 翻译器工厂函数
    const createTranslator = (name, translateFn) => ({
        name,
        translate: async (text) => {
            const cachedResult = translationCache.get(text, name);
            if (cachedResult) return cachedResult;

            const result = await translateFn(text);
            if (!result) throw new Error(`${name}翻译失败: 翻译结果为空`);

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
                return result[0].map(x => x[0]).join('');
            } catch (error) {
                console.error('谷歌翻译错误:', error);
                throw new Error('谷歌翻译失败: ' + error.message);
            }
        }),

        youdao: createTranslator('有道词典', async (text) => {
            try {
                const response = await gmGet(
                    `https://dict.youdao.com/jsonapi?xmlVersion=5.1&jsonversion=2&q=${encodeURIComponent(text)}`,
                    { 'Referer': 'https://dict.youdao.com' }
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
                return translation;
            } catch (error) {
                console.error('有道词典错误:', error);
                throw new Error('有道词典失败: ' + error.message);
            }
        }),

        cambridge: createTranslator('剑桥词典', async (text) => {
            try {
                const response = await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: `https://dictionary.cambridge.org/search/english-chinese-simplified/direct/?q=${encodeURIComponent(text)}`,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                            'Accept-Language': 'en-US,en;q=0.5',
                        },
                        onload: resolve,
                        onerror: reject,
                    });
                });

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

                return translation;
            } catch (error) {
                console.error('剑桥词典错误:', error);
                throw new Error('剑桥词典失败: ' + error.message);
            }
        })
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
            --switch-hover-bg: #e2e8f0;
            --text-secondary: #475569;
            --text-tertiary: #64748b;
            --hover-bg: #f1f5f9;
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
            max-width: ${CONFIG.panelWidth}px !important;
            max-height: 80vh !important;
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
            --switch-hover-bg: rgba(255, 255, 255, 0.16);
            --text-secondary: #999;
            --text-tertiary: #888;
            --hover-bg: rgba(255, 255, 255, 0.1);
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
            cursor: move !important;
            user-select: none !important;
            transition: var(--theme-transition) !important;
        }

        .translator-panel .title-wrapper,
        .translator-panel .theme-button,
        .translator-panel .pin-button,
        .translator-panel .clear-button,
        .translator-panel .external-button {
            display: flex !important;
            align-items: center !important;
            cursor: pointer !important;
            transition: background-color 0.2s, opacity 0.2s !important;
        }

        .translator-panel .title-wrapper {
            position: relative !important;
            display: inline-flex !important;
            flex: 0 0 auto !important;
            width: max-content !important;
            gap: var(--spacing-sm) !important;
            margin-right: auto !important;
            padding: var(--spacing-xs) var(--spacing-lg) !important;
            border: 0 !important;
            border-radius: var(--spacing-sm) !important;
            background: transparent !important;
        }

        .translator-panel .title-wrapper:hover,
        .translator-panel.dropdown-open .title-wrapper {
            background: var(--switch-hover-bg) !important;
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
            width: 12px !important;
            height: 12px !important;
            margin-left: var(--spacing-sm) !important;
            transform: rotate(0deg) !important;
            transition: transform 0.2s !important;
        }

        .translator-panel .switch-icon.open {
            transform: rotate(180deg) !important;
        }

        /* 标题栏图标按钮 */
        .translator-panel .theme-button,
        .translator-panel .pin-button,
        .translator-panel .clear-button,
        .translator-panel .external-button {
            flex: 0 0 var(--font-xl) !important;
            justify-content: center !important;
            width: var(--font-xl) !important;
            height: var(--font-xl) !important;
            color: var(--title-text) !important;
            font-size: var(--font-lg) !important;
            opacity: 0.62 !important;
        }

        .translator-panel .theme-button:hover,
        .translator-panel .pin-button:hover,
        .translator-panel .clear-button:hover,
        .translator-panel .external-button:hover {
            opacity: 1 !important;
        }

        .translator-panel .theme-button::after,
        .translator-panel .pin-button::after,
        .translator-panel .clear-button::after,
        .translator-panel .external-button::after {
            content: "" !important;
            display: block !important;
            width: 16px !important;
            height: 16px !important;
            background: currentColor !important;
            -webkit-mask: var(--icon) center / contain no-repeat !important;
            mask: var(--icon) center / contain no-repeat !important;
        }

        .translator-panel .pin-button.unpinned {
            --icon: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="4"/><path d="M12 12v9"/></svg>');
        }

        .translator-panel .pin-button.pinned {
            --icon: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="4" fill="black"/><path d="M12 12v9"/></svg>');
        }

        .translator-panel .theme-button.light {
            --icon: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>');
        }

        .translator-panel .theme-button.dark {
            --icon: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>');
        }

        .translator-panel .clear-button {
            --icon: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round"><path d="M3 3l18 18M3 21L21 3"/></svg>');
        }

        .translator-panel .external-button {
            --icon: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14L21 3"/></svg>');
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

        /* 翻译内容 */
        .translator-panel .content {
            position: relative !important;
            display: flex !important;
            flex-direction: column !important;
            height: auto !important;
            max-height: calc(80vh - ${CONFIG.titleBarHeight}px) !important;
            overflow: visible !important;
        }

        .translator-panel .source-text-container {
            position: sticky !important;
            top: 0 !important;
            z-index: 1 !important;
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
            flex: 1 !important;
            max-height: calc(80vh - ${CONFIG.titleBarHeight}px - 100px) !important;
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

        .translator-panel .def-text {
            color: var(--panel-text) !important;
        }

        .translator-panel .trans-line {
            margin-top: var(--spacing-xs) !important;
            color: var(--panel-text) !important;
            font-weight: 500 !important;
        }

        .translator-panel .phrase-def {
            margin-top: var(--spacing-xs) !important;
            color: var(--text-secondary) !important;
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
            if (content) content.innerHTML = `<div class="error">${utils.escapeHtml(message)}</div>`;
        },
        showPanel(x, y, targetPanel) {
            const {innerWidth: vw, innerHeight: vh, scrollX: sx, scrollY: sy} = window;
            const spacing = CONFIG.panelSpacing;
            const maxHeight = Math.max(
                CONFIG.titleBarHeight + spacing,
                Math.min(CONFIG.maxPanelHeight, vh - spacing * 2)
            );

            Object.assign(targetPanel.style, {
                position: 'absolute',
                left: '-9999px',
                top: '-9999px',
                display: 'block',
                maxHeight: `${maxHeight}px`
            });

            // 内容尚未返回时至少按一个小窗口估算位置；结果返回后高度可自然增长。
            const estimatedHeight = Math.min(Math.max(targetPanel.offsetHeight, 120), maxHeight);
            const panelX = Math.max(spacing + sx, Math.min(sx + vw - CONFIG.panelWidth - spacing, x));
            const spaceBelow = vh - (y - sy);
            const spaceAbove = y - sy;
            const panelY = spaceBelow >= estimatedHeight || spaceBelow >= spaceAbove
                ? y + spacing
                : y - estimatedHeight - spacing;

            Object.assign(targetPanel.style, {
                left: `${panelX}px`,
                top: `${Math.max(sy + spacing, panelY)}px`
            });

            const content = targetPanel.querySelector('.content');
            if (content) content.style.maxHeight = `${maxHeight - CONFIG.titleBarHeight - spacing}px`;

            targetPanel.classList.toggle(CONFIG.darkModeClass, this.isDarkMode());
            requestAnimationFrame(() => targetPanel.classList.add('show'));
        },
        hidePanel(targetPanel) {
            if (!targetPanel || targetPanel.classList.contains('pinned')) return;
            targetPanel.classList.remove('show');
            setTimeout(() => {
                if (!targetPanel.classList.contains('show')) targetPanel.remove();
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
        isClickInPanel: e => e.target instanceof Element && Boolean(e.target.closest('.translator-panel')),
        preventSelectionTrigger() {
            state.ignoreNextSelection = true;
            setTimeout(() => { state.ignoreNextSelection = false; }, 100);
        }
    };

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
        const formattedTranslation = await translator.translate(textToTranslate);
        if (!formattedTranslation) throw new Error('翻译结果为空');

        const content = targetPanel.querySelector('.content');
        if (!content) throw new Error('未找到内容容器元素');

        content.innerHTML = `
            <div class="source-text-container">
                <div class="source-text"><strong>${utils.escapeHtml(textToTranslate).replace(/\n/g, '<br>')}</strong></div>
            </div>
            <div class="translation-container">
                <div class="translation">${formattedTranslation}</div>
            </div>`;

        targetPanel.querySelectorAll('.audio-button').forEach(button => {
            button.addEventListener('click', async e => {
                e.preventDefault();
                e.stopPropagation();
                utils.preventSelectionTrigger();
                state.isSelectingInPanel = false;
                const url = button.dataset.url;
                if (url) await audio.play(url);
            });
        });

        targetPanel.classList.add('show');
    }

    function buildPanelHTML(translatorKey) {
        return `<div class="title-bar">
                <div class="title-wrapper">
                    <span class="title">${TRANSLATORS[translatorKey].name}</span>
                    <span class="switch-text">（点击切换）</span>
                    <svg class="switch-icon" viewBox="0 0 1024 1024"><path fill="currentColor" d="M884 256h-75c-5.1 0-9.9 2.5-12.9 6.6L512 654.2 227.9 262.6c-3-4.1-7.8-6.6-12.9-6.6h-75c-6.5 0-10.3 7.4-6.5 12.7l352.6 486.1c12.8 17.6 39 17.6 51.7 0l352.6-486.1c3.9-5.3.1-12.7-6.4-12.7z"/></svg>
                    <div class="dropdown-menu"></div>
                </div>
                <div class="external-button" title="在新窗口打开翻译"></div>
                <div class="pin-button unpinned" title="固定窗口"></div>
                <div class="theme-button light" title="切换深色模式"></div>
                <div class="clear-button" title="关闭所有窗口"></div>
            </div>
            <div class="content"></div>`;
    }

    function createTranslatorPanel() {
        const targetPanel = document.createElement('div');
        targetPanel.className = 'translator-panel';
        targetPanel.translatorKey = GM_getValue('defaultTranslator', 'youdao');
        targetPanel.translationText = '';
        targetPanel.innerHTML = buildPanelHTML(targetPanel.translatorKey);
        setupPanelEvents(targetPanel);
        return targetPanel;
    }

    const handleSelection = utils.debounce(async e => {
        if (isTranslating || state.ignoreNextSelection) return;

        const selection = window.getSelection();
        const text = selection?.toString().trim();
        if (!text || !utils.isTranslatable(text) || utils.isClickInPanel(e)) return;
        if (!selection.rangeCount) return;

        isTranslating = true;
        cleanupPanels();
        let targetPanel = null;

        try {
            targetPanel = createTranslatorPanel();
            document.body.appendChild(targetPanel);

            const rect = selection.getRangeAt(0).getBoundingClientRect();
            utils.showPanel(rect.left + window.scrollX, rect.bottom + window.scrollY, targetPanel);
            await translate(text, targetPanel);
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
        if (e.target.closest('.title-wrapper, .pin-button, .theme-button, .clear-button, .external-button, .dropdown-menu')) return;

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

    function setupPanelEvents(targetPanel) {
        setupTranslatorSwitch(targetPanel);

        const pinButton = targetPanel.querySelector('.pin-button');
        const themeButton = targetPanel.querySelector('.theme-button');
        const externalButton = targetPanel.querySelector('.external-button');
        const clearButton = targetPanel.querySelector('.clear-button');
        const isDark = utils.isDarkMode();

        themeButton.className = `theme-button ${isDark ? 'dark' : 'light'}`;
        themeButton.title = isDark ? '切换亮色模式' : '切换深色模式';
        targetPanel.classList.toggle(CONFIG.darkModeClass, isDark);

        pinButton.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            const pinned = targetPanel.classList.toggle('pinned');
            pinButton.className = `pin-button ${pinned ? 'pinned' : 'unpinned'}`;
            pinButton.title = pinned ? '取消固定' : '固定窗口';
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

        externalButton.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            utils.preventSelectionTrigger();
            const urls = {
                google: 'https://translate.google.com/?sl=auto&tl=zh-CN&text=',
                youdao: 'https://dict.youdao.com/w/',
                cambridge: 'https://dictionary.cambridge.org/dictionary/english-chinese-simplified/'
            };
            const url = urls[targetPanel.translatorKey];
            if (url && targetPanel.translationText) {
                window.open(url + encodeURIComponent(targetPanel.translationText), '_blank');
            }
        });

        clearButton.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
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
