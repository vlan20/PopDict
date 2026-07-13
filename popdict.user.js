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

    // 封装 GM_xmlhttpRequest 为 Promise，供各翻译器共用（避免重复的样板代码）
    const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const gmGet = (url, headers = {}) => new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: 'GET',
            url,
            headers: { 'User-Agent': DEFAULT_UA, ...headers },
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
                const response = await gmGet(
                    `https://dictionary.cambridge.org/search/english-chinese-simplified/direct/?q=${encodeURIComponent(text)}`,
                    {
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.5'
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

                return translation;
            } catch (error) {
                console.error('剑桥词典错误:', error);
                throw new Error('剑桥词典失败: ' + error.message);
            }
        })
    };

    // 添加样式
    GM_addStyle(`
        /* ================ */
        /* 1. CSS 变量定义 */
        /* ================ */
        .translator-panel {
            /* 基础颜色 */
            --panel-bg: #ffffff;
            --panel-text: #2c3e50;
            --panel-border: #e2e8f0;
            --panel-shadow: rgba(0,0,0,0.1);

            /* 标题栏颜色 */
            --title-bg: #f8fafc;
            --title-text: #334155;
            --title-border: #e2e8f0;

            /* 次要文本颜色 */
            --text-secondary: #475569;
            --text-tertiary: #64748b;

            /* 交互颜色 */
            --hover-bg: #f1f5f9;
            --active-link: #3b82f6;
            --success: #22c55e;
            --error: #ef4444;

            /* 布局尺寸 */
            --spacing-xs: 2px;
            --spacing-sm: 4px;
            --spacing-md: 6px;
            --spacing-lg: 8px;
            --spacing-xl: 12px;

            /* 字体大小 */
            --font-xs: 10px;
            --font-sm: 12px;
            --font-md: 13px;
            --font-lg: 14px;
            --font-xl: 16px;

            /* 过渡效果 */
            --theme-transition: background-color 0.15s ease-out,
                                background-image 0.15s ease-out,
                                color 0.15s ease-out,
                                border-color 0.15s ease-out,
                                border-bottom-color 0.15s ease-out;
        }

        /* 深色模式变量 */
        .translator-panel.translator-panel-dark {
            --panel-bg: #1a1a1a;
            --panel-text: #e0e0e0;
            --panel-border: #333;
            --panel-shadow: rgba(0,0,0,0.3);

            --title-bg: #2c2c2c;
            --title-text: #e0e0e0;
            --title-border: #333;

            --text-secondary: #999;
            --text-tertiary: #888;

            --hover-bg: rgba(255, 255, 255, 0.1);
            --active-link: #4a9eff;
            --success: #73d13d;
            --error: #ff7875;
        }

        /* ================ */
        /* 2. 基础面板样式 */
        /* ================ */
        .translator-panel {
            font-size: ${CONFIG.fontSize}px !important;
            line-height: 1.5 !important;
            color: var(--panel-text) !important;
            background: var(--panel-bg) !important;
            border: 1px solid var(--panel-border) !important;
            border-radius: 6px !important;
            padding: var(--spacing-md) !important;
            box-shadow: 0 4px 12px var(--panel-shadow) !important;
            max-width: ${CONFIG.panelWidth}px !important;
            position: absolute !important; /* 使用absolute定位，相对于文档定位 */
            z-index: 2147483647 !important;
            display: none;
            opacity: 0;
            transform: translateY(-10px);
            transition: var(--theme-transition),
                        opacity 0.3s,
                        transform 0.3s !important;
            max-height: 80vh !important;
            overflow: hidden !important;
        }

        /* 下拉菜单展开时允许其超出较矮的翻译面板，避免错误状态下被裁剪 */
        .translator-panel.dropdown-open {
            overflow: visible !important;
        }

        /* 拖动时的样式 */
        .translator-panel.dragging {
            transition: none !important;
            opacity: 0.95 !important;
            cursor: move !important;
            pointer-events: none !important; /* 防止拖动时影响其他元素 */
        }

        /* 调整内容区域的内边距和滚动条 */
        .translator-panel .content {
            position: relative !important;
            overflow: visible !important; /* 修改为visible，让子元素的滚动条可见 */
            display: flex !important;
            flex-direction: column !important;
            height: auto !important; /* 修改为auto，根据内容自动调整高度 */
            max-height: calc(80vh - ${CONFIG.titleBarHeight}px) !important; /* 限制最大高度，减去标题栏高度 */
        }

        /* 源文本容器样式 */
        .translator-panel .source-text-container {
            position: sticky !important;
            top: 0 !important;
            z-index: 1 !important;
            background: var(--panel-bg) !important;
            border-bottom: 1px solid var(--panel-border) !important;
            margin: calc(-1 * var(--spacing-md)) calc(-1 * var(--spacing-md)) 0 !important;
            padding: var(--spacing-md) var(--spacing-lg) var(--spacing-md) calc(var(--spacing-lg) + var(--spacing-sm)) !important;
            transition: var(--theme-transition) !important;
        }

        /* 源文本样式 */
        .translator-panel .source-text {
            color: var(--text-secondary) !important;
            font-size: ${CONFIG.sourceFontSize}px !important;
            line-height: 1.5 !important;
            user-select: text !important;
            word-wrap: break-word !important; /* 确保长单词换行 */
            overflow-wrap: break-word !important; /* 现代浏览器的单词换行 */
            white-space: pre-wrap !important; /* 保留换行但允许自动换行 */
        }

        .translator-panel .source-text strong {
            color: var(--panel-text) !important;
            font-weight: 600 !important;
        }

        /* 翻译内容容器样式 */
        .translator-panel .translation-container {
            flex: 1 !important;
            overflow-y: auto !important;
            padding: var(--spacing-md) var(--spacing-md) !important;
            max-height: calc(80vh - ${CONFIG.titleBarHeight}px - 100px) !important;
            word-wrap: break-word !important;
            overflow-wrap: break-word !important;
            white-space: normal !important;
            display: block !important;
        }

        /* 下拉菜单滚动条样式 - WebKit 浏览器 */
        .translator-panel .dropdown-menu::-webkit-scrollbar {
            width: 3px !important;
            height: 3px !important;
        }

        .translator-panel .dropdown-menu::-webkit-scrollbar-thumb {
            background: var(--text-tertiary) !important;
            border-radius: 3px !important;
            transition: background-color 0.2s !important;
        }

        .translator-panel .dropdown-menu::-webkit-scrollbar-thumb:hover {
            background: var(--text-secondary) !important;
        }

        .translator-panel .dropdown-menu::-webkit-scrollbar-track {
            background: transparent !important; /* 透明轨道，更简约 */
            border-radius: 3px !important;
        }

        /* 翻译结果样式 */
        .translator-panel .translation {
            color: var(--panel-text) !important;
            font-size: ${CONFIG.translationFontSize}px !important;
            line-height: 1.5 !important;
            user-select: text !important;
            word-wrap: break-word !important; /* 确保长单词换行 */
            overflow-wrap: break-word !important; /* 现代浏览器的单词换行 */
            white-space: normal !important; /* 允许正常换行 */
            max-width: 100% !important; /* 确保不超出容器宽度 */
            overflow: visible !important; /* 确保内容不被截断 */
        }

        /* 深色模式下的源文本样式调整 */
        .translator-panel.translator-panel-dark .source-text strong {
            color: #fff !important;
        }

        /* 翻译内容区域滚动条样式 */
        .translator-panel .translation-container::-webkit-scrollbar {
            width: 5px !important; /* 增加滚动条宽度，提高可见性 */
            height: 5px !important;
        }

        .translator-panel .translation-container::-webkit-scrollbar-thumb {
            background: var(--text-tertiary) !important;
            border-radius: 4px !important;
            transition: background-color 0.2s !important;
        }

        .translator-panel .translation-container::-webkit-scrollbar-thumb:hover {
            background: var(--text-secondary) !important;
        }

        .translator-panel .translation-container::-webkit-scrollbar-track {
            background: var(--hover-bg) !important; /* 轻微可见的轨道 */
            border-radius: 4px !important;
        }

        /* 确保词性标签和音标也可以选择 */
        .translator-panel .pos-tag,
        .translator-panel .phonetic-item {
            user-select: text !important;
            margin-bottom: var(--spacing-xs) !important; /* 减少音标项的下边距 */
        }

        /* 调整释义块样式 */
        .translator-panel .sense-block {
            margin: var(--spacing-xs) 0 !important; /* 减少上下间距 */
            padding: var(--spacing-xs) 0 !important; /* 减少上下内边距 */
            display: flex !important;
            gap: var(--spacing-md) !important; /* 减少词性标签和释义内容之间的间距 */
            align-items: flex-start !important;
            border-bottom: 1px solid var(--panel-border) !important;
            transition: var(--theme-transition) !important;
        }

        .sense-block:first-child {
            margin-top: 0 !important;
        }

        .sense-block:last-child {
            margin-bottom: 0 !important;
            border-bottom: none !important;
        }

        /* 调整音标项样式 */
        .phonetic-item {
            display: flex !important;
            align-items: center !important;
            gap: var(--spacing-xs) !important; /* 减少间距 */
            color: var(--text-secondary) !important;
            padding: var(--spacing-xs) var(--spacing-sm) !important;
            white-space: nowrap !important;
        }

        /* 基础重置样式 */
        .translator-panel * {
            all: revert;
            box-sizing: border-box !important;
            margin: 0 !important;
            padding: 0 !important;
            font-family: inherit !important;
            line-height: inherit !important;
            color: inherit !important;
            pointer-events: auto !important;
        }

        /* ================ */
        /* 3. 布局组件样式 */
        /* ================ */

        /* 标题栏 */
        .translator-panel .title-bar {
            position: relative !important;
            display: flex !important;
            align-items: center !important;
            justify-content: space-between !important;
            border-bottom: 1px solid var(--title-border) !important;
            padding: var(--spacing-xs) var(--spacing-md) !important;
            margin: calc(-1 * var(--spacing-md)) calc(-1 * var(--spacing-md)) var(--spacing-md) calc(-1 * var(--spacing-md)) !important;
            background-color: var(--title-bg) !important;
            border-top-left-radius: 6px !important;
            border-top-right-radius: 6px !important;
            gap: var(--spacing-md) !important;
            cursor: move !important;
            user-select: none !important;
            transition: var(--theme-transition) !important;
        }

        /* 标题包装器和按钮基础样式 */
        .translator-panel .title-wrapper,
        .translator-panel .theme-button,
        .translator-panel .pin-button,
        .translator-panel .clear-button,
        .translator-panel .external-button {
            display: flex !important;
            align-items: center !important;
            cursor: pointer !important;
            transition: all 0.2s !important;
        }

        /* 标题包装器特有样式 */
        .translator-panel .title-wrapper {
            gap: var(--spacing-sm) !important;
            padding: var(--spacing-xs) var(--spacing-lg) !important;
            border-radius: var(--spacing-sm) !important;
            width: fit-content !important; /* 使用fit-content替代固定宽度 */
            margin-right: auto !important;
            position: relative !important; /* 添加相对定位，作为下拉菜单的参考点 */
        }

        .translator-panel .title-wrapper:hover {
            background-color: var(--hover-bg) !important;
        }

        /* 按钮共享样式 */
        .translator-panel .theme-button,
        .translator-panel .pin-button,
        .translator-panel .clear-button,
        .translator-panel .external-button {
            width: var(--font-xl) !important;
            height: var(--font-xl) !important;
            justify-content: center !important;
            font-size: var(--font-lg) !important;
            opacity: 0.6 !important;
            display: flex !important;
            align-items: center !important;
        }

        .translator-panel .theme-button:hover,
        .translator-panel .pin-button:hover,
        .translator-panel .clear-button:hover,
        .translator-panel .external-button:hover {
            opacity: 1 !important;
        }

        /* 按钮图标 */
        .translator-panel .pin-button::after {
            content: "" !important;
            display: inline-block !important;
            width: 16px !important;
            height: 16px !important;
            background-size: contain !important;
            background-repeat: no-repeat !important;
            background-position: center !important;
        }
        .translator-panel .pin-button.unpinned::after {
            background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="4"/><path d="M12 12v9"/></svg>') !important;
        }
        .translator-panel .pin-button.pinned::after {
            background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="4" fill="currentColor"/><path d="M12 12v9"/></svg>') !important;
        }
        .translator-panel.translator-panel-dark .pin-button.unpinned::after {
            background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="%23ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="4"/><path d="M12 12v9"/></svg>') !important;
        }
        .translator-panel.translator-panel-dark .pin-button.pinned::after {
            background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="%23ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="4" fill="%23ffffff"/><path d="M12 12v9"/></svg>') !important;
        }
        .translator-panel .theme-button::after {
            content: "" !important;
            display: inline-block !important;
            width: 16px !important;
            height: 16px !important;
            background-size: contain !important;
            background-repeat: no-repeat !important;
            background-position: center !important;
        }
        .translator-panel .theme-button.light::after {
            background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>') !important;
        }
        .translator-panel .theme-button.dark::after {
            background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="%23ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>') !important;
        }
        .translator-panel .clear-button::after {
            content: "" !important;
            display: inline-block !important;
            width: 16px !important;
            height: 16px !important;
            background-size: contain !important;
            background-repeat: no-repeat !important;
            background-position: center !important;
            background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M3 21l18-18M12 12v.01"/></svg>') !important;
        }
        .translator-panel.translator-panel-dark .clear-button::after {
            background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="%23ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M3 21l18-18M12 12v.01"/></svg>') !important;
        }
        .translator-panel .external-button::after {
            content: "" !important;
            display: inline-block !important;
            width: 16px !important;
            height: 16px !important;
            background-size: contain !important;
            background-repeat: no-repeat !important;
            background-position: center !important;
            background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>') !important;
        }
        .translator-panel.translator-panel-dark .external-button::after {
            background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="%23ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>') !important;
        }

        /* 下拉菜单基础样式 */
        .translator-panel .dropdown-menu {
            position: absolute !important;
            top: calc(100% + 4px) !important;
            left: 0 !important;
            min-width: 150px !important;
            max-height: 300px !important;
            overflow-y: auto !important;
            background: var(--panel-bg) !important;
            border: 1px solid var(--panel-border) !important;
            border-radius: 6px !important;
            box-shadow: 0 2px 8px var(--panel-shadow) !important;
            opacity: 0 !important;
            visibility: hidden !important;
            transform: scale(0.95) !important;
            transform-origin: top left !important;
            transition: opacity 0.15s ease-out, transform 0.15s ease-out, visibility 0.15s !important;
            z-index: 2147483647 !important;
            margin: 0 !important;
        }

        /* 靠近视口底部时向上展开；靠近右侧时向左对齐 */
        .translator-panel .dropdown-menu.open-upward {
            top: auto !important;
            bottom: calc(100% + 4px) !important;
            transform-origin: bottom left !important;
        }

        .translator-panel .dropdown-menu.align-right {
            left: auto !important;
            right: 0 !important;
        }

        /* 移除所有三角形装饰 */
        .translator-panel .dropdown-menu::before,
        .translator-panel .dropdown-menu::after,
        .translator-panel .title-wrapper::before,
        .translator-panel .title-wrapper::after,
        .translator-panel .title-bar::before,
        .translator-panel .title-bar::after {
            display: none !important;
            content: none !important;
            border: none !important;
            clip-path: none !important;
            background: none !important;
        }

        /* 下拉菜单显示状态 */
        .translator-panel .dropdown-menu.show {
            display: block !important;
            visibility: visible !important;
            opacity: 1 !important;
            transform: scale(1) !important;
        }

        /* 下拉菜单项样式 */
        .translator-panel .dropdown-item {
            padding: var(--spacing-md) var(--spacing-xl) !important;
            cursor: pointer !important;
            font-size: var(--font-sm) !important;
            color: var(--panel-text) !important;
            display: flex !important;
            align-items: center !important;
            justify-content: space-between !important;
            white-space: nowrap !important;
            position: relative !important;
        }

        .translator-panel .dropdown-item:hover {
            background-color: var(--hover-bg) !important;
        }

        .translator-panel .dropdown-item .translator-name {
            display: flex !important;
            align-items: center !important;
            gap: var(--spacing-sm) !important;
        }

        .translator-panel .dropdown-item.active .translator-name {
            font-weight: 600 !important;
        }

        .translator-panel .dropdown-item.is-default .translator-name::after {
            content: '默认' !important;
            font-size: var(--font-xs) !important;
            font-weight: normal !important;
            padding: 2px 4px !important;
            border-radius: 3px !important;
            background: var(--text-tertiary) !important;
            color: var(--panel-bg) !important;
            margin-left: var(--spacing-sm) !important;
            opacity: 0.8 !important;
        }

        .translator-panel .dropdown-item .set-default {
            opacity: 0 !important;
            transition: all 0.2s !important;
            color: var(--text-tertiary) !important;
            padding: var(--spacing-xs) var(--spacing-sm) !important;
            border-radius: var(--spacing-xs) !important;
            font-size: var(--font-xs) !important;
        }

        .translator-panel .dropdown-item:hover .set-default {
            opacity: 1 !important;
        }

        .translator-panel .dropdown-item .set-default:hover {
            color: var(--active-link) !important;
            background-color: var(--hover-bg) !important;
        }

        .translator-panel .dropdown-item.is-default .set-default {
            display: none !important;
        }

        /* 文本样式 */
        .translator-panel .title {
            font-size: var(--font-sm) !important;
            font-weight: 500 !important;
            color: var(--title-text) !important;
            white-space: nowrap !important;
        }

        .translator-panel .switch-text {
            font-size: var(--font-sm) !important;
            color: var(--text-tertiary) !important;
            opacity: 0.8 !important;
            white-space: nowrap !important;
        }

        /* 错误状态 */
        .translator-panel .error {
            padding: var(--spacing-xl) 0 !important;
            text-align: center !important;
            font-size: var(--font-sm) !important;
            color: var(--error) !important;
        }

        /* 发音按钮样式 */
        .phonetic-buttons {
            margin: 0 0 var(--spacing-sm) 0 !important;
            display: flex !important;
            gap: var(--spacing-xl) !important;
            flex-wrap: wrap !important;
            padding: 0 !important;
        }

        .audio-button {
            border: none;
            background: none;
            cursor: pointer;
            padding: var(--spacing-xs) var(--spacing-sm);
            font-size: var(--font-xl);
            color: var(--active-link);
            transition: all 0.3s;
            border-radius: var(--spacing-xs);
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }

        .audio-button:hover {
            background-color: var(--hover-bg);
        }

        .audio-button:active {
            transform: scale(0.95);
        }

        /* 词性标签容器样式 */
        .translator-panel .pos-tags {
            display: flex !important;
            flex-direction: column !important;
            gap: var(--spacing-xs) !important; /* 减少词性标签之间的间距 */
            min-width: 35px !important;
            flex-shrink: 0 !important;
            align-items: center !important;
        }

        /* 词性标签样式 */
        .translator-panel .pos-tag {
            font-weight: 500 !important;
            color: #fff !important;
            padding: var(--spacing-xs) var(--spacing-sm) !important;
            border-radius: var(--spacing-xs) !important;
            font-size: var(--font-sm) !important;
            text-align: center !important;
            width: 100% !important;
            margin-bottom: 0 !important;
            background: var(--pos-color, #6b7280) !important;
        }

        /* 词汇等级标识样式 */
        .translator-panel .level-tag {
            font-size: var(--font-xs) !important;
            padding: var(--spacing-xs) var(--spacing-sm) !important;
            border-radius: 3px !important;
            text-align: center !important;
            min-width: 24px !important;
            margin-top: 2px !important;
            font-weight: 500 !important;
            letter-spacing: 0.5px !important;
        }

        /* 调整词性标签和释义内容的布局 */
        .translator-panel .def-content {
            flex: 1 !important;
            min-width: 0 !important; /* 确保flex子项可以收缩 */
            word-wrap: break-word !important; /* 确保长单词换行 */
            overflow-wrap: break-word !important; /* 现代浏览器的单词换行 */
            overflow: visible !important; /* 确保内容不被截断 */
        }

        /* 动画效果 */
        .translator-panel.show {
            opacity: 1 !important;
            transform: translateY(0) !important;
        }

        .translator-panel.active {
            display: block !important;
            opacity: 1 !important;
            transform: translateY(0) !important;
        }

        /* 添加释义发音样式 */
        .translator-panel .sense-phonetic {
            margin-bottom: var(--spacing-xs) !important; /* 减少下边距 */
            opacity: 0.8 !important;
            display: flex !important;
            flex-wrap: wrap !important;
            gap: var(--spacing-md) !important; /* 减少间距 */
        }

        .translator-panel .sense-phonetic .phonetic-item {
            font-size: var(--font-sm) !important;
            color: var(--text-secondary) !important;
            flex: 0 1 auto !important;
        }

        .translator-panel .sense-phonetic .audio-button {
            font-size: var(--font-lg) !important;
            padding: var(--spacing-xs) !important;
        }

        /* 添加切换图标样式 */
        .translator-panel .switch-icon {
            width: 12px !important;
            height: 12px !important;
            margin-left: 4px !important;
            transition: transform 0.2s !important;
            display: inline-block !important;
            vertical-align: middle !important;
            transform: rotate(0deg) !important;
        }

        .translator-panel .switch-icon.open {
            transform: rotate(180deg) !important;
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
