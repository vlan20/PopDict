// ==UserScript==
// @name         PopDict 词窗 - 划词翻译
// @namespace    https://github.com/vlan20/popdict
// @version      0.1.6
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
        fontSize: 17, // 基础字体大小（beta 整体增加 1px）
        sourceFontSize: 15, // 原文字体大小
        translationFontSize: 14, // 翻译结果字体大小
        selectionMinHoldMs: 120, // 拖选至少按住 120ms；0 关闭，双击不受影响
        selectionMinDistance: 4, // 排除轻微鼠标抖动（CSS px）
        triggerDelay: 150, // 减少触发延迟
        darkModeClass: 'translator-panel-dark',
        panelSpacing: 12, // 视口边距
        wordGap: 12, // 单词上方/下方使用相同留白
        panelWidth: 300,
        maxPanelHeightRatio: 0.75, // 长内容最多占用视口高度的 75%
        titleBarHeight: 40, // 添加标题栏高度配置
        animationDuration: 160, // 整窗淡入/淡出；CSS与销毁共用
        loadingDelay: 120, // 超过该时间才显示加载条
        hoverHideDelay: 150, // 离开高亮/悬浮窗后的关闭缓冲
        hoverSwitchDelay: 100, // 掠过相邻高亮时延迟切换，避免误顶掉当前窗口
        cacheExpiration: 24 * 60 * 60 * 1000, // 缓存过期时间（24小时）
        negativeCacheExpiration: 5 * 60 * 1000, // 明确无词条只记忆5分钟，按翻译器区分
        requestTimeout: 10000, // 超时属于请求错误，不能记入无词条缓存
        maxCacheSize: 100, // 最大缓存条目数
    };

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
            this.cache.delete(key);
            this.cache.set(key, { translation, timestamp: Date.now() });
            if (this.cache.size > CONFIG.maxCacheSize) this.cache.delete(this.cache.keys().next().value);
        }
    };

    class NoEntryError extends Error {
        constructor() { super('词典确认无有效词条'); this.name = 'NoEntryError'; }
    }

    // 只接收解析器的明确无词条信号；不持久化，不记录网络/HTTP/解析异常。
    const negativeCache = {
        cache: new Map(),
        has(text, translator) {
            const key = translationCache.generateKey(text, translator);
            const expires = this.cache.get(key);
            if (expires > Date.now()) return true;
            this.cache.delete(key);
            return false;
        },
        set(text, translator) {
            const key = translationCache.generateKey(text, translator);
            this.cache.delete(key);
            this.cache.set(key, Date.now() + CONFIG.negativeCacheExpiration);
            if (this.cache.size > CONFIG.maxCacheSize) this.cache.delete(this.cache.keys().next().value);
        }
    };
    const dictionaryKey = text => text.trim().toLowerCase().replace(/’/g, "'").replace(/\s+/g, ' ');

    // 新建窗口前移除未固定的旧窗口，固定窗口保留。
    function cleanupPanels() {
        hideHoverPanel(true);
        document.querySelectorAll('.translator-panel:not(.pinned)').forEach(utils.removePanel);
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
        async fetch(url) {
            const response = await gmGet(url, {anonymous: true, responseType: 'arraybuffer'})
                .catch(error => { throw new Error(`音频请求失败: ${error.message}`); });
            if (!(response.response instanceof ArrayBuffer)) throw new Error('音频响应格式不正确');
            return response.response;
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

    // 统一 GET 请求；剑桥单独使用匿名请求避开异常 Cookie 状态。
    const gmGet = (url, options = {}) => new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: 'GET',
            url,
            ...options,
            timeout: CONFIG.requestTimeout,
            onload: response => response.status >= 200 && response.status < 300
                ? resolve(response) : reject(new Error(`HTTP ${response.status}`)),
            onerror: () => reject(new Error('网络请求失败')),
            ontimeout: () => reject(new Error('请求超时')),
            onabort: () => reject(new Error('请求已取消'))
        });
    });

    // 翻译器工厂函数
    const createTranslator = (name, translateFn, dictionary = false) => ({
        name,
        isMissing: text => dictionary && negativeCache.has(dictionaryKey(text), name),
        translate: async text => {
            if (dictionary && negativeCache.has(dictionaryKey(text), name)) throw new NoEntryError();
            const cached = translationCache.get(text, name);
            if (cached) return cached;
            try {
                const result = await translateFn(text);
                if (!result?.html) throw new Error('翻译结果为空');
                translationCache.set(text, name, result);
                return result;
            } catch (error) {
                if (dictionary && error instanceof NoEntryError) {
                    negativeCache.set(dictionaryKey(text), name);
                    throw error;
                }
                throw new Error(`${name}失败: ${error?.message || '请求失败'}`);
            }
        }
    });

    const createPronHtml = (type, pron, url) => `<span class="phonetic-item">${utils.escapeHtml(type)} ${utils.escapeHtml(pron)}${url ? ` <button class="audio-button" data-url="${utils.escapeHtml(url)}">${ICONS.audio}</button>` : ''}</span>`;

    // Cambridge Parser：只产出语义数据；空行与排版由 renderer 统一处理。
    function parseCambridge(doc) {
        const text = (node, selector) => node?.querySelector(selector)?.textContent.trim() || '';
        const level = node => Array.from(node?.querySelectorAll('.dxref, .epp-xref') || [])
            .map(el => el.textContent.trim().toUpperCase()).find(value => /^(A1|A2|B1|B2|C1|C2)$/.test(value)) || '';
        const header = (node, selector) => Array.from(node?.children || []).find(el => el.matches(selector));
        const pronunciations = node => Array.from(node?.querySelectorAll('.uk.dpron-i, .us.dpron-i') || []).flatMap(block => {
            const pron = text(block, '.pron') || text(node, '.pron');
            if (!pron) return [];
            const src = block.querySelector('source[type="audio/mpeg"]')?.getAttribute('src');
            let url = '';
            try {
                const parsed = new URL(src || '', 'https://dictionary.cambridge.org');
                if (src && parsed.protocol === 'https:') url = parsed.href;
            } catch (_) {}
            return [{type: block.classList.contains('uk') ? '英' : '美', pron, url}];
        });
        const entries = Array.from(doc.querySelectorAll('.entry-body__el')).map(entry => {
            const entryHeader = entry.querySelector('.pos-header');
            const pos = Array.from(entryHeader?.querySelectorAll('.pos') || []).map(el => el.textContent.trim()).filter(Boolean);
            const senses = Array.from(entry.querySelectorAll('.ddef_block')).map(sense => {
                const group = sense.closest('.dsense-block, .dsense');
                const phrase = sense.closest('.phrase-block, .idiom-block');
                const groupHeader = header(group, '.dsense-header, .dsense_h');
                const phraseHeader = header(phrase, '.phrase-head, .phrase-header, .idiom-head, .idiom-header');
                const definition = text(sense, '.ddef_h .def, .def');
                const translation = text(sense, '.def-body .trans, .trans');
                return {
                    pos: text(sense, '.ddef_h .pos') || (phrase ? text(phraseHeader, '.pos') || 'phrase'
                        : text(groupHeader, '.pos') || [...new Set(pos)].join('\n')),
                    level: level(sense) || (phrase ? level(phraseHeader) : level(groupHeader) || level(entryHeader)),
                    definition, translation,
                    pronunciation: pronunciations(sense),
                    phrase: phrase ? text(phrase, '.phrase-title, .idiom-title') : ''
                };
            });
            return {headword: text(entryHeader || entry, '.hw'), pronunciation: pronunciations(entryHeader), senses};
        });
        // 页面缺失/结构变化不代表无词条；只接受明确的无结果区域文案。
        const missing = doc.querySelector('.search-noresults, .search-no-results, .no-results, [data-no-results]');
        const noEntryConfirmed = !entries.length && Boolean(missing
            && /no (?:results|entries|definitions)(?: were)? (?:found|for)|未找到(?:结果|词条|释义)/i.test(missing.textContent));
        return {entries, noEntryConfirmed};
    }

    // 共享词典组件：等级随有内容的义项渲染，不生成独立的 POS/CEFR 空行。
    function renderCambridge(parsed) {
        const esc = utils.escapeHtml;
        const renderProns = (items, className) => items.length
            ? `<div class="${className}">${items.map(item => createPronHtml(item.type, item.pron, item.url)).join('')}</div>` : '';
        return parsed.entries.map(entry => {
            const rows = entry.senses.filter(sense => sense.definition || sense.translation);
            if (!rows.length) return '';
            return renderProns(entry.pronunciation, 'phonetic-buttons') + rows.map(sense => `
                <div class="sense-block">
                    ${sense.pos || sense.level ? `<div class="pos-tags">${sense.pos.split(/[,，、\n]/).filter(Boolean).map(pos => `<div class="pos-tag">${esc(pos.trim())}</div>`).join('')}${sense.level ? `<div class="level-tag">${esc(sense.level)}</div>` : ''}</div>` : ''}
                    <div class="def-content">${renderProns(sense.pronunciation, 'sense-phonetic')}
                        ${sense.phrase ? `<div class="phrase-text">${esc(sense.phrase)}</div>` : ''}
                        ${sense.definition ? `<div class="def-text">${esc(sense.definition)}</div>` : ''}
                        ${sense.translation ? `<div class="trans-line">${esc(sense.translation)}</div>` : ''}
                    </div>
                </div>`).join('');
        }).join('');
    }

    // 翻译器配置
    const TRANSLATORS = {
        google: createTranslator('谷歌翻译', async (text) => {
            const response = await gmGet(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`);
            const result = JSON.parse(response.responseText);
            if (!result?.[0]?.length) throw new Error('谷歌翻译返回的数据格式不正确');
            return { html: result[0].map(x => x[0]).join(''), highlightable: false };
        }),

        youdao: createTranslator('有道词典', async (text) => {
            const response = await gmGet(
                `https://dict.youdao.com/jsonapi?xmlVersion=5.1&jsonversion=2&q=${encodeURIComponent(text)}`,
                { headers: { 'Referer': 'https://dict.youdao.com' } }
            );

            const result = JSON.parse(response.responseText);
            let translation = '';
            if (result.error || (result.errorCode && String(result.errorCode) !== '0')) throw new Error('词典接口返回错误');
            if (result.query && dictionaryKey(result.query) !== dictionaryKey(text)) throw new Error('词典返回的查询词不匹配');
            const wordInfo = result.ec?.word?.[0];
            const definitions = (wordInfo?.trs || []).flatMap(item => item.tr || [])
                .flatMap(item => item.l?.i || []).filter(value => typeof value === 'string' && value.trim());
            const headword = wordInfo?.['return-phrase']?.l?.i;
            const exactEntry = !headword || (Array.isArray(headword) ? headword : [headword])
                .some(value => dictionaryKey(value) === dictionaryKey(text));
            if (Array.isArray(result.ec?.word) && !result.ec.word.length) throw new NoEntryError();
            const audioUrls = {
                uk: wordInfo?.ukspeech ? `https://dict.youdao.com/dictvoice?audio=${wordInfo.ukspeech}` : '',
                us: wordInfo?.usspeech ? `https://dict.youdao.com/dictvoice?audio=${wordInfo.usspeech}` : ''
            };

            // 添加音标和发音按钮
            if (wordInfo?.ukphone || wordInfo?.usphone) {
                translation += '<div class="phonetic-buttons">';
                if (wordInfo.ukphone && audioUrls.uk) translation += createPronHtml('英', `/${wordInfo.ukphone}/`, audioUrls.uk);
                if (wordInfo.usphone && audioUrls.us) translation += createPronHtml('美', `/${wordInfo.usphone}/`, audioUrls.us);
                translation += '</div>\n\n';
            }

            // 获取翻译结果
            if (definitions.length) {
                translation += definitions.map(utils.escapeHtml).join('; ');
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
            return {html: translation, highlightable: definitions.length > 0, dictionaryEntry: definitions.length > 0 && exactEntry};
        }, true),

        cambridge: createTranslator('剑桥词典', async (text) => {
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

            const parsed = parseCambridge(new DOMParser().parseFromString(response.responseText, 'text/html'));
            const html = renderCambridge(parsed);
            if (!html) {
                if (parsed.noEntryConfirmed) throw new NoEntryError();
                throw new Error('未取得有效释义，页面结构可能变化');
            }
            const dictionaryEntry = parsed.entries.some(entry => dictionaryKey(entry.headword) === dictionaryKey(text)
                && entry.senses.some(sense => sense.definition || sense.translation));
            return {html, highlightable: true, dictionaryEntry};
        }, true)
    };

    const EXTERNAL_URLS = {
        google: 'https://translate.google.com/?sl=auto&tl=zh-CN&text=',
        youdao: 'https://dict.youdao.com/w/',
        cambridge: 'https://dictionary.cambridge.org/dictionary/english-chinese-simplified/'
    };

    const ICONS = {external: '🔎', eraser: '🧹', lock: '🔒', unlock: '🔓', moon: '🌙', sun: '🔆', close: '❌', trash: '📤', audio: '🔊'};

    // 添加样式
    GM_addStyle(`
        /* 主题变量与面板基础 */
        .translator-panel {
            --panel-bg: #fff;
            --panel-text: #000;
            --panel-border: #e2e8f0;
            --panel-shadow: rgba(0, 0, 0, 0.1);
            --title-bg: #f8fafc;
            --text-secondary: #111;
            --text-tertiary: #333;
            --hover-bg: #f1f5f9;
            --title-hover-bg: #e2e8f0;
            --active-link: #3b82f6;
            --error: #ef4444;
            --spacing-xs: 2px;
            --spacing-sm: 4px;
            --spacing-md: 6px;
            --spacing-lg: 8px;
            --spacing-xl: 12px;
            --font-xs: 11px;
            --font-sm: 13px;
            --font-lg: 15px;
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
            opacity: 0 !important;
            transform: none !important;
            transition: var(--theme-transition), opacity ${CONFIG.animationDuration}ms ease-out !important;
        }

        .translator-panel.translator-panel-dark {
            --panel-bg: #1a1a1a;
            --panel-text: #e0e0e0;
            --panel-border: #333;
            --panel-shadow: rgba(0, 0, 0, 0.3);
            --title-bg: #2c2c2c;
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
            font-size: inherit !important;
            line-height: inherit !important;
            pointer-events: auto !important;
        }

        .translator-panel.show {
            opacity: 1 !important;
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
            border-bottom: 1px solid var(--panel-border) !important;
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
            color: var(--panel-text) !important;
            font-weight: 500 !important;
        }

        .translator-panel .switch-text {
            color: var(--text-tertiary) !important;
            opacity: 0.8 !important;
        }

        /* 标题栏图标按钮 */
        .translator-panel .icon-button {
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            flex: 0 0 18px !important;
            width: 18px !important;
            height: 18px !important;
            padding: 0 !important;
            border: 0 !important;
            border-radius: 3px !important;
            background: transparent !important;
            color: var(--panel-text) !important;
            cursor: pointer !important;
            opacity: 0.82 !important;
            font: 15px/1 "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif !important;
            transition: background-color 0.15s, opacity 0.15s !important;
        }

        .translator-panel .icon-button:hover {
            background: var(--title-hover-bg) !important;
            opacity: 1 !important;
        }

        .translator-panel .pin-button.pinned {
            opacity: 1 !important;
        }

        .translator-panel .unhighlight-button[hidden] {
            display: none !important;
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

        ::highlight(popdict-words) {
            background-color: rgba(245, 158, 11, 0.22);
            text-decoration: underline rgba(217, 119, 6, 0.7);
        }

        ::highlight(popdict-hover) {
            background-color: rgba(245, 158, 11, 0.38);
        }

        ::highlight(popdict-jump) {
            background-color: rgba(59, 130, 246, 0.3);
        }

        /* 页面高亮词汇 */
        .popdict-wordbook-button {
            position: fixed !important;
            right: 18px !important;
            bottom: 18px !important;
            z-index: 2147483646 !important;
            min-width: 52px !important;
            height: 34px !important;
            padding: 0 12px !important;
            border: 1px solid #d1d5db !important;
            border-radius: 17px !important;
            background: #fff !important;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12) !important;
            color: #111 !important;
            font: 500 14px/1 sans-serif !important;
            cursor: pointer !important;
        }

        .popdict-wordbook-button:hover { background: #f1f5f9 !important; }
        .popdict-wordbook-button.dark {
            border-color: #333 !important;
            background: #1a1a1a !important;
            color: #e0e0e0 !important;
        }
        .popdict-wordbook-button.dark:hover { background: #2c2c2c !important; }

        .translator-panel.popdict-wordbook-panel {
            position: fixed !important;
            right: 18px !important;
            bottom: 62px !important;
            left: auto !important;
            top: auto !important;
            display: flex !important;
            width: max-content !important;
            min-width: 210px !important;
            max-width: min(340px, calc(100vw - 24px)) !important;
            max-height: min(60vh, 420px) !important;
            opacity: 1 !important;
            transform: none !important;
        }

        .popdict-wordbook-panel .title-bar {
            margin-bottom: 0 !important;
            cursor: default !important;
        }

        .popdict-wordbook-panel .wordbook-title { margin-right: auto !important; }
        .popdict-wordbook-panel .wordbook-export {
            border: 0 !important;
            background: transparent !important;
            color: var(--panel-text) !important;
            font-size: var(--font-sm) !important;
            cursor: pointer !important;
            opacity: 0.68 !important;
        }
        .popdict-wordbook-panel .wordbook-export:hover { opacity: 1 !important; }
        .popdict-wordbook-panel .wordbook-list { padding: 3px !important; }
        .popdict-wordbook-panel .wordbook-item {
            gap: var(--spacing-sm) !important;
            padding: 3px 6px !important;
            border-radius: var(--spacing-sm) !important;
            font-size: 15px !important;
            line-height: 1.25 !important;
        }
        .popdict-wordbook-panel .wordbook-word {
            flex: 1 1 auto !important;
            min-width: 0 !important;
            overflow: hidden !important;
            text-overflow: ellipsis !important;
            white-space: nowrap !important;
        }
        .popdict-wordbook-panel .wordbook-count {
            flex: 0 0 auto !important;
            color: var(--text-tertiary) !important;
            font-size: var(--font-sm) !important;
        }
        .popdict-wordbook-panel .wordbook-remove {
            color: var(--panel-text) !important;
            opacity: 0 !important;
            visibility: hidden !important;
        }
        .popdict-wordbook-panel .wordbook-item:hover .wordbook-remove,
        .popdict-wordbook-panel .wordbook-remove:focus-visible {
            opacity: 1 !important;
            visibility: visible !important;
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

        .translator-panel .source-text {
            flex: 0 0 auto !important;
            overflow: visible !important;
            margin: calc(-1 * var(--spacing-md)) calc(-1 * var(--spacing-md)) 0 !important;
            padding: var(--spacing-md) var(--spacing-lg) var(--spacing-md) calc(var(--spacing-lg) + var(--spacing-sm)) !important;
            border-bottom: 1px solid var(--panel-border) !important;
            background: var(--panel-bg) !important;
            transition: var(--theme-transition) !important;
            color: var(--panel-text) !important;
            font-size: ${CONFIG.sourceFontSize}px !important;
            font-weight: 600 !important;
            white-space: pre-wrap !important;
            user-select: text !important;
        }

        .translator-panel .source-text,
        .translator-panel .translation,
        .translator-panel .def-content {
            overflow-wrap: anywhere !important;
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
            font: var(--font-lg)/1 "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif !important;
            cursor: pointer !important;
            opacity: 0.82 !important;
            transition: background-color 0.15s, opacity 0.15s, transform 0.2s !important;
        }

        .translator-panel .audio-button:hover {
            background: var(--hover-bg) !important;
            opacity: 1 !important;
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
            font-weight: 500 !important;
            text-align: center !important;
            user-select: text !important;
        }

        .translator-panel .level-tag {
            min-width: 24px !important;
            margin-top: var(--spacing-xs) !important;
            padding: var(--spacing-xs) var(--spacing-sm) !important;
            border-radius: 3px !important;
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

        .translator-panel .sense-phonetic .audio-button {
            padding: var(--spacing-xs) !important;
        }

        /* 词典正文密度：共用组件，不为每个翻译器复制面板样式。 */
        .translator-panel .def-text,
        .translator-panel .phrase-text {
            font-size: 13px !important;
            line-height: 1.45 !important;
        }
        .translator-panel .trans-line {
            font-size: 14px !important;
            line-height: 1.45 !important;
        }
        .translator-panel .phrase-text { font-weight: 600 !important; }
        .translator-panel .phonetic-item,
        .translator-panel .sense-phonetic,
        .translator-panel .sense-phonetic .phonetic-item,
        .translator-panel .pos-tag {
            font-size: 12px !important;
            line-height: 1.3 !important;
        }
        .translator-panel .level-tag {
            font-size: 11px !important;
            line-height: 1.2 !important;
            background: var(--hover-bg) !important;
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
        .translator-panel.closing,
        .translator-panel.popdict-wordbook-panel.closing {
            opacity: 0 !important;
            pointer-events: none !important;
        }
        .translator-panel.closing * { pointer-events: none !important; }
    `);

    // 仅保留跨窗口共享且确实需要的状态。
    const state = {
        isSelectingInPanel: false,
        isRightClickPending: false,
        selectionGesture: null
    };

    let dragState = null;
    let hoverPanel = null;
    let hoverHideTimer = null;
    let hoverShowTimer = null;
    let pendingHoverRange = null;
    let selectionEpoch = 0;
    let pendingRefine = null;
    let wordbookButton = null;
    let wordbookPanel = null;
    const wordbookCursor = new Map();
    // 保存 Range，不包裹、不拆分、不移动宿主页面节点。
    const highlightStore = new Map();
    const supportsHighlights = typeof Highlight === 'function' && Boolean(globalThis.CSS?.highlights);
    const wordHighlights = supportsHighlights ? new Highlight() : null;
    const hoverHighlights = supportsHighlights ? new Highlight() : null;
    const jumpHighlights = supportsHighlights ? new Highlight() : null;
    if (supportsHighlights) {
        CSS.highlights.set('popdict-words', wordHighlights);
        CSS.highlights.set('popdict-hover', hoverHighlights);
        CSS.highlights.set('popdict-jump', jumpHighlights);
        hoverHighlights.priority = 1;
        jumpHighlights.priority = 2;
    }

    function updateThemeButton(button, isDark) {
        if (!button) return;
        button.title = isDark ? '切换亮色模式' : '切换深色模式';
        button.textContent = isDark ? ICONS.sun : ICONS.moon;
    }

    function updatePinButton(button, pinned) {
        if (!button) return;
        button.classList.toggle('pinned', pinned);
        button.title = pinned ? '取消固定' : '固定窗口';
        button.textContent = pinned ? ICONS.unlock : ICONS.lock;
    }

    const utils = {
        escapeMap: {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'},
        escapeHtml: text => text.replace(/[&<>"']/g, c => utils.escapeMap[c]),
        isDarkMode: () => GM_getValue('darkMode', false),
        toggleDarkMode() {
            const isDark = !this.isDarkMode();
            GM_setValue('darkMode', isDark);
            document.querySelectorAll('.translator-panel:not(.closing)').forEach(panel => {
                panel.classList.toggle(CONFIG.darkModeClass, isDark);
                updateThemeButton(panel.querySelector('.theme-button'), isDark);
            });
            document.querySelector('.popdict-wordbook-button')?.classList.toggle('dark', isDark);
        },
        debounce(fn, delay) {
            let timer;
            const debounced = (...args) => {
                clearTimeout(timer);
                timer = setTimeout(() => fn(...args), delay);
            };
            debounced.cancel = () => clearTimeout(timer);
            return debounced;
        },
        containsPoint: (rect, x, y) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
        positionPanel(panel, x, y) {
            const {innerWidth: vw, innerHeight: vh, scrollX, scrollY} = window;
            const margin = CONFIG.panelSpacing;
            panel.style.left = `${Math.max(margin, Math.min(x, vw - panel.offsetWidth - margin)) + scrollX}px`;
            panel.style.top = `${Math.max(margin, Math.min(y, vh - panel.offsetHeight - margin)) + scrollY}px`;
        },
        fitPanelToViewport(panel) {
            if (!panel?.isConnected || panel.style.display === 'none' || panel.classList.contains('closing')) return;
            const {innerHeight: vh, scrollX, scrollY} = window;
            const margin = CONFIG.panelSpacing, gap = CONFIG.wordGap;
            const viewportHeight = Math.max(CONFIG.titleBarHeight,
                Math.min(Math.floor(vh * CONFIG.maxPanelHeightRatio), vh - margin * 2));
            panel.style.setProperty('max-height', `${viewportHeight}px`, 'important');
            if (panel.manualPosition) {
                const rect = panel.getBoundingClientRect();
                utils.positionPanel(panel, rect.left, rect.top);
                return;
            }
            const anchor = panel.anchorRect;
            if (!anchor) return;
            const top = anchor.top - scrollY, bottom = anchor.bottom - scrollY;
            const below = Math.max(0, vh - margin - bottom - gap);
            const above = Math.max(0, top - margin - gap);
            const height = Math.min(panel.offsetHeight || CONFIG.titleBarHeight + 48, viewportHeight);
            const placeBelow = below >= height || below >= above;
            const available = placeBelow ? below : above;
            panel.style.setProperty('max-height', `${Math.min(viewportHeight, Math.max(CONFIG.titleBarHeight, available))}px`, 'important');
            utils.positionPanel(panel, anchor.left - scrollX,
                placeBelow ? bottom + gap : top - panel.offsetHeight - gap);
        },
        showPanel(rect, panel) {
            panel.anchorRect = {left: rect.left + window.scrollX,
                top: rect.top + window.scrollY, bottom: rect.bottom + window.scrollY};
            panel.manualPosition = false;
            Object.assign(panel.style, {left: '-9999px', top: '-9999px', display: 'flex'});
            panel.classList.toggle(CONFIG.darkModeClass, utils.isDarkMode());
            utils.fitPanelToViewport(panel);
            requestAnimationFrame(() => {
                if (panel.isConnected && !panel.classList.contains('closing')) panel.classList.add('show');
            });
        },
        revivePanel(panel) {
            if (!panel) return;
            if (panel.closeState) {
                clearTimeout(panel.closeState.timer);
                panel.removeEventListener('transitionend', panel.closeState.finish);
                panel.closeState = null;
            }
            panel.classList.remove('closing');
            panel.classList.add('show');
        },
        removePanel(panel) {
            if (!panel) return;
            utils.revivePanel(panel); // 释放关闭回调；不清空任何子组件。
            if (panel === hoverPanel) hoverPanel = null;
            if (panel === wordbookPanel) wordbookPanel = null;
            panel.remove();
        },
        hidePanel(panel, force = false) {
            if (!panel?.isConnected || (panel.classList.contains('pinned') && force !== true) || panel.closeState) return;
            const finish = event => {
                if (event && (event.target !== panel || event.propertyName !== 'opacity')) return;
                utils.removePanel(panel);
            };
            panel.closeState = {finish, timer: setTimeout(finish, CONFIG.animationDuration + 50)};
            panel.requestId = (panel.requestId || 0) + 1; // 关闭中的面板不再接收异步内容替换。
            panel.addEventListener('transitionend', finish);
            panel.classList.add('closing');
        },
        isEditableTarget: target => target instanceof Element && Boolean(
            target.closest('input, textarea, select, option, [contenteditable]:not([contenteditable="false"])')
        ),
        isClickInPanel: e => e.target instanceof Element && Boolean(
            e.target.closest('.translator-panel, .popdict-wordbook-button')
        ),
        stopEvent(e) {
            e.preventDefault();
            e.stopPropagation();
        }
    };

    const buildContentHTML = (text, html) => `
        <div class="source-text">${utils.escapeHtml(text)}</div>
        <div class="translation-container"><div class="translation">${html}</div></div>`;

    // 在原选区内截取英文部分，仅生成 Range，不改写原文节点。
    function sliceSelectionRange(selected, start, end) {
        let container = selected.commonAncestorContainer;
        if (container.nodeType === Node.TEXT_NODE) container = container.parentElement;
        if (!container || container.closest?.('.translator-panel')) return null;
        const range = document.createRange();
        range.selectNodeContents(container);
        range.setEnd(selected.startContainer, selected.startOffset);
        const prefixLength = range.toString().length;
        start += prefixLength;
        end += prefixLength;
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        let node, offset = 0, started = false;
        while ((node = walker.nextNode())) {
            const next = offset + node.data.length;
            if (!started && start < next) {
                range.setStart(node, start - offset);
                started = true;
            }
            if (started && end <= next) {
                range.setEnd(node, end - offset);
                return range;
            }
            offset = next;
        }
        return null;
    }

    function isCurrentRange(range, text) {
        return Boolean(range?.startContainer.isConnected && range.endContainer.isConnected
            && !range.collapsed && range.toString() === text);
    }

    // 统一文本入口：先排除单字母编号、清理标识符，再应用翻译器规则。
    // start/end 始终指向原选区，提取 size_8 时只高亮 size。
    function prepareSelection(text, translatorKey) {
        const leading = text.length - text.trimStart().length;
        const trimmed = text.trim();
        if (!/[^\u4e00-\u9fff\d\s\p{P}\p{S}]/u.test(trimmed)) return null;
        const letters = trimmed.match(/[A-Za-z]/g) || [];
        if (letters.length === 1 && !/[^A-Za-z\d\s\p{P}\p{S}]/u.test(trimmed)) return null;

        const token = String.raw`[A-Za-z]+(?:['’-][A-Za-z]+)*`;
        const matches = Array.from(trimmed.matchAll(new RegExp(`${token}(?:\\s+${token})*`, 'g')));
        const isIdentifier = /^[A-Za-z0-9_'’-]+$/.test(trimmed) && /[\d_]/.test(trimmed);
        if (translatorKey === 'google' && !isIdentifier) {
            return {text: trimmed, start: leading, end: leading + trimmed.length};
        }

        // 多段英文不擅自拼接；数字、下划线和中文不进入词典查询。
        if (matches.length !== 1) return null;
        const candidate = matches[0][0];
        const words = candidate.match(new RegExp(token, 'g')) || [];
        if (!words.some(word => (word.match(/[A-Za-z]/g) || []).length >= 2)
            || words.length > 6 || candidate.length > 60) return null;
        const start = leading + matches[0].index;
        return {text: candidate, start, end: start + candidate.length};
    }

    function setHighlightButton(panel, visible) {
        const button = panel?.querySelector('.unhighlight-button');
        if (button) button.hidden = !visible;
    }

    function getWordbookGroups() {
        const groups = new Map();
        for (const range of highlightStore.keys()) {
            if (!isHighlightValid(range)) removeHighlight(range, false);
        }
        highlightStore.forEach((data, range) => {
            const text = data.text.trim();
            if (!text) return;
            if (!groups.has(text)) groups.set(text, {text, ranges: []});
            groups.get(text).ranges.push(range);
        });
        return Array.from(groups.values());
    }

    function renderWordbook(groups) {
        wordbookPanel.items = groups;
        wordbookPanel.querySelector('.wordbook-title').textContent = `页面高亮词汇（${groups.length}）`;
        wordbookPanel.querySelector('.wordbook-list').innerHTML = groups.map((group, index) => `
            <div class="dropdown-item wordbook-item" data-index="${index}">
                <span class="wordbook-word">${utils.escapeHtml(group.text)}</span>
                ${group.ranges.length > 1 ? `<span class="wordbook-count">×${group.ranges.length}</span>` : ''}
                <button type="button" class="icon-button wordbook-remove" title="取消一处高亮" aria-label="取消一处高亮">${ICONS.trash}</button>
            </div>`).join('');
    }

    function plainTranslation(html = '') {
        const container = document.createElement('div');
        container.innerHTML = html;
        container.querySelectorAll('.audio-button, .phonetic-buttons, .sense-phonetic').forEach(element => element.remove());
        container.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
        container.querySelectorAll('.sense-block').forEach(block => block.append('\n'));
        return container.textContent
            .replace(/[ \t]+/g, ' ')
            .replace(/ *\n */g, '\n')
            .replace(/\n{2,}/g, '\n')
            .trim();
    }

    function exportWordbook() {
        const groups = getWordbookGroups();
        if (!groups.length) return;
        const csvCell = value => `"${String(value).replace(/"/g, '""')}"`;
        const rows = [['Word', 'Translation', 'Count'], ...groups.map(group => [
            group.text, plainTranslation(highlightStore.get(group.ranges[0])?.html), group.ranges.length
        ])];
        const csv = '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
        const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8'}));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'popdict-vocabulary.csv';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    function focusWordbookHighlight(range) {
        if (!isHighlightValid(range)) return;
        const node = range.startContainer;
        const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        element?.scrollIntoView({behavior: 'smooth', block: 'center', inline: 'nearest'});
        jumpHighlights?.add(range);
        setTimeout(() => jumpHighlights?.delete(range), 900);

        const ownerPanel = highlightStore.get(range)?.ownerPanel;
        if (ownerPanel?.isConnected && !ownerPanel.classList.contains('pinned')) utils.removePanel(ownerPanel);
        showHoverPanel(range);
    }

    function closeWordbook() {
        utils.hidePanel(wordbookPanel, true);
        wordbookPanel = null;
    }

    function toggleWordbook() {
        if (wordbookPanel && !wordbookPanel.isConnected) wordbookPanel = null;
        if (wordbookPanel) {
            closeWordbook();
            return;
        }

        const groups = getWordbookGroups();
        if (!groups.length) return;
        wordbookPanel = document.createElement('div');
        wordbookPanel.className = 'translator-panel pinned popdict-wordbook-panel';
        wordbookPanel.classList.toggle(CONFIG.darkModeClass, utils.isDarkMode());
        wordbookPanel.innerHTML = `<div class="title-bar">
                <span class="title wordbook-title"></span>
                <button type="button" class="wordbook-export" title="导出词表（CSV，可用 Excel、WPS 或记事本打开）">导出词表</button>
                <button type="button" class="icon-button wordbook-close" title="关闭" aria-label="关闭">${ICONS.close}</button>
            </div>
            <div class="translation-container wordbook-list"></div>`;
        document.body.appendChild(wordbookPanel);
        renderWordbook(groups);

        wordbookPanel.addEventListener('click', e => {
            utils.stopEvent(e);
            if (e.target.closest('.wordbook-close')) {
                closeWordbook();
                return;
            }
            if (e.target.closest('.wordbook-export')) {
                exportWordbook();
                return;
            }

            const item = e.target.closest('.wordbook-item');
            if (!item) return;
            const group = wordbookPanel.items?.[Number(item.dataset.index)];
            if (!group?.ranges.length) {
                updateWordbookUI();
                return;
            }

            let index = wordbookCursor.get(group.text) ?? -1;
            if (e.target.closest('.wordbook-remove')) {
                index = index >= 0 && index < group.ranges.length ? index : 0;
                wordbookCursor.set(group.text, index - 1);
                removeHighlight(group.ranges[index]);
                return;
            }

            index = (index + 1) % group.ranges.length;
            wordbookCursor.set(group.text, index);
            focusWordbookHighlight(group.ranges[index]);
        });
    }

    function updateWordbookUI() {
        const groups = getWordbookGroups();
        if (!groups.length) {
            wordbookButton?.remove();
            wordbookButton = null;
            closeWordbook();
            wordbookCursor.clear();
            return;
        }

        if (!wordbookButton?.isConnected) {
            wordbookButton = document.createElement('button');
            wordbookButton.type = 'button';
            wordbookButton.className = 'popdict-wordbook-button';
            wordbookButton.addEventListener('click', e => {
                utils.stopEvent(e);
                toggleWordbook();
            });
            document.body.appendChild(wordbookButton);
        }
        wordbookButton.textContent = `词 ${groups.length}`;
        wordbookButton.title = `页面高亮词汇（${groups.length}）`;
        wordbookButton.classList.toggle('dark', utils.isDarkMode());

        if (wordbookPanel && !wordbookPanel.isConnected) wordbookPanel = null;
        if (wordbookPanel) renderWordbook(groups);
    }

    function isHighlightValid(range) {
        const data = highlightStore.get(range);
        return Boolean(data && isCurrentRange(range, data.text));
    }

    function removeHighlight(range, refreshWordbook = true) {
        const data = highlightStore.get(range);
        if (!data) return;
        if (data.ownerPanel?.highlightRange === range) {
            data.ownerPanel.highlightRange = null;
            setHighlightButton(data.ownerPanel, false);
        }
        if (hoverPanel?.highlightRange === range) hideHoverPanel();
        wordHighlights?.delete(range);
        hoverHighlights?.delete(range);
        jumpHighlights?.delete(range);
        highlightStore.delete(range);
        if (refreshWordbook) updateWordbookUI();
    }

    function rememberHighlight(range, result, panel) {
        highlightStore.set(range, {
            text: range.toString(), html: result.html,
            translatorKey: panel.translatorKey, ownerPanel: panel
        });
        panel.highlightRange = range;
        setHighlightButton(panel, true);
    }

    function applyHighlight(bookmark, result, targetPanel) {
        // 不支持 CSS 高亮时仍可翻译；不退回会修改原文结构的包裹方案。
        if (!supportsHighlights || !bookmark) return null;
        if (!isCurrentRange(bookmark.range, bookmark.text)) return null;
        const range = bookmark.range.cloneRange();
        for (const oldRange of highlightStore.keys()) {
            if (!isHighlightValid(oldRange)
                || (range.compareBoundaryPoints(Range.END_TO_START, oldRange) < 0
                    && range.compareBoundaryPoints(Range.START_TO_END, oldRange) > 0)) {
                removeHighlight(oldRange, false);
            }
        }
        rememberHighlight(range, result, targetPanel);
        wordHighlights.add(range);
        updateWordbookUI();
        return range;
    }

    function cancelHoverTimers() {
        clearTimeout(hoverHideTimer);
        clearTimeout(hoverShowTimer);
        hoverHideTimer = hoverShowTimer = null;
        pendingHoverRange = null;
    }

    function refineLocked() {
        return isHighlightValid(pendingRefine?.sourceHighlight || state.selectionGesture?.sourceHighlight);
    }

    function hideHoverPanel(immediate = false) {
        cancelHoverTimers();
        if (immediate) utils.removePanel(hoverPanel);
        else utils.hidePanel(hoverPanel);
    }

    function scheduleHideHover() {
        clearTimeout(hoverShowTimer);
        hoverShowTimer = null;
        pendingHoverRange = null;
        if (refineLocked() || hoverHideTimer !== null) return;
        hoverHideTimer = setTimeout(hideHoverPanel, CONFIG.hoverHideDelay);
    }

    function requestHoverPanel(range) {
        clearTimeout(hoverHideTimer);
        hoverHideTimer = null;
        if (refineLocked()) return;
        if (hoverPanel?.highlightRange === range) {
            utils.revivePanel(hoverPanel);
            cancelHoverTimers();
            return;
        }
        // 同一目标内移动不重置停留时间；快速掠过 B/C 只保留最后目标。
        if (pendingHoverRange === range) return;
        clearTimeout(hoverShowTimer);
        pendingHoverRange = range;
        if (!hoverPanel?.isConnected) return showHoverPanel(range);
        hoverShowTimer = setTimeout(() => {
            if (pendingHoverRange === range && isHighlightValid(range)) showHoverPanel(range);
        }, CONFIG.hoverSwitchDelay);
    }

    function showHoverPanel(range) {
        if (!isHighlightValid(range)) return;
        const data = highlightStore.get(range);
        if (data.ownerPanel?.isConnected) {
            if (data.ownerPanel !== hoverPanel) hideHoverPanel(true);
            else cancelHoverTimers();
            utils.revivePanel(data.ownerPanel);
            return;
        }
        // 新面板内容就绪后在同一任务内交换，不先清空 A 或播放 B 的入场淡入。
        const panel = createTranslatorPanel({
            translatorKey: data.translatorKey, translationText: data.text,
            highlightRange: range, resultHtml: data.html
        });
        panel.classList.add('show');
        const previous = hoverPanel;
        cancelHoverTimers();
        document.body.appendChild(panel);
        data.ownerPanel = panel;
        hoverPanel = panel;
        const rect = range.getBoundingClientRect();
        utils.showPanel(rect, panel);
        utils.removePanel(previous);
        panel.addEventListener('mouseenter', () => {
            cancelHoverTimers();
            utils.revivePanel(panel);
        });
        panel.addEventListener('mouseleave', e => {
            if (!panel.classList.contains('pinned')) updateHoverTarget(e.clientX, e.clientY, e.relatedTarget);
        });
    }

    function highlightAtPoint(x, y, target) {
        if (!(target instanceof Element) || target.closest('.translator-panel, .popdict-wordbook-button')) return null;
        for (const range of highlightStore.keys()) {
            if (!isHighlightValid(range)) continue;
            const ancestor = range.commonAncestorContainer;
            const element = ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentElement : ancestor;
            if (element?.contains(target) && Array.from(range.getClientRects()).some(rect => utils.containsPoint(rect, x, y))) return range;
        }
        return null;
    }

    function updateHoverTarget(x, y, target) {
        if (hoverPanel?.contains(target) || (hoverPanel?.closeState
            && utils.containsPoint(hoverPanel.getBoundingClientRect(), x, y))) {
            utils.revivePanel(hoverPanel);
            cancelHoverTimers();
            return;
        }
        const hit = highlightAtPoint(x, y, target);
        hoverHighlights?.clear();
        if (hit) {
            hoverHighlights?.add(hit);
            requestHoverPanel(hit);
        } else scheduleHideHover();
    }

    function cancelSelection() {
        handleSelection.cancel();
        selectionEpoch++;
        pendingRefine = null;
    }

    function resetPanelSelection() {
        state.isSelectingInPanel = false;
        document.body.style.userSelect = '';
        cancelSelection();
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
            if (requestId !== targetPanel.requestId || !targetPanel.isConnected) return null;

            const content = targetPanel.querySelector('.content');
            if (!content) throw new Error('未找到内容容器元素');
            content.innerHTML = buildContentHTML(textToTranslate, result.html);
            requestAnimationFrame(() => utils.fitPanelToViewport(targetPanel));

            if (targetPanel.highlightRange && !isHighlightValid(targetPanel.highlightRange)) {
                targetPanel.highlightRange = null;
                setHighlightButton(targetPanel, false);
            }

            if (result.highlightable) {
                if (isHighlightValid(targetPanel.highlightRange)) {
                    rememberHighlight(targetPanel.highlightRange, result, targetPanel);
                } else if (targetPanel.selectionBookmark) {
                    applyHighlight(targetPanel.selectionBookmark, result, targetPanel);
                }
            }

            return result;
        } catch (error) {
            console.error('翻译失败:', error);
            const content = targetPanel.querySelector('.content');
            if (requestId === targetPanel.requestId && targetPanel.isConnected && content) {
                content.innerHTML = `<div class="error">${utils.escapeHtml(error?.message || '翻译失败，请稍后重试')}</div>`;
                requestAnimationFrame(() => utils.fitPanelToViewport(targetPanel));
            }
            return null;
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
                    <div class="dropdown-menu"></div>
                </div>
                <button type="button" class="icon-button external-button" title="前往翻译网站查看" aria-label="前往翻译网站查看">${ICONS.external}</button>
                <button type="button" class="icon-button unhighlight-button" title="取消高亮" aria-label="取消高亮" hidden>${ICONS.eraser}</button>
                <button type="button" class="icon-button pin-button" title="固定窗口" aria-label="固定窗口">${ICONS.lock}</button>
                <button type="button" class="icon-button theme-button" title="切换深色模式" aria-label="切换主题"></button>
                <button type="button" class="icon-button clear-button" title="关闭所有窗口" aria-label="关闭所有窗口">${ICONS.close}</button>
            </div>
            <div class="loading-bar"></div>
            <div class="content"></div>`;
    }

    function createTranslatorPanel({
        translatorKey,
        translationText = '',
        highlightRange = null,
        resultHtml = ''
    }) {
        const targetPanel = document.createElement('div');
        targetPanel.className = 'translator-panel';
        targetPanel.translatorKey = translatorKey;
        targetPanel.translationText = translationText;
        targetPanel.requestId = 0;
        targetPanel.selectionBookmark = null;
        targetPanel.highlightRange = highlightRange;
        targetPanel.innerHTML = buildPanelHTML(translatorKey);
        if (translationText && resultHtml) {
            targetPanel.querySelector('.content').innerHTML = buildContentHTML(translationText, resultHtml);
        }
        setHighlightButton(targetPanel, Boolean(highlightRange));
        setupPanelEvents(targetPanel);
        return targetPanel;
    }

    function containingHighlight(range) {
        return Array.from(highlightStore.keys()).find(source => isHighlightValid(source)
            && source.compareBoundaryPoints(Range.START_TO_START, range) <= 0
            && source.compareBoundaryPoints(Range.END_TO_END, range) >= 0) || null;
    }

    function selectionIsCurrent(snapshot) {
        const selection = window.getSelection();
        if (snapshot.epoch !== selectionEpoch || selection?.rangeCount !== 1) return false;
        const current = selection.getRangeAt(0);
        return current.toString() === snapshot.rawText
            && current.compareBoundaryPoints(Range.START_TO_START, snapshot.selectedRange) === 0
            && current.compareBoundaryPoints(Range.END_TO_END, snapshot.selectedRange) === 0
            && isCurrentRange(snapshot.bookmark.range, snapshot.bookmark.text);
    }

    async function refineSelection(snapshot) {
        const {sourceHighlight, sourceData, bookmark, translatorKey} = snapshot;
        try {
            const result = await TRANSLATORS[translatorKey].translate(bookmark.text);
            if (!result.highlightable || result.dictionaryEntry === false || !selectionIsCurrent(snapshot)
                || !isHighlightValid(sourceHighlight) || highlightStore.get(sourceHighlight) !== sourceData) return;
            const panel = createTranslatorPanel({translatorKey, translationText: bookmark.text, resultHtml: result.html});
            if (!applyHighlight(bookmark, result, panel)) return;
            cleanupPanels();
            panel.selectionBookmark = bookmark;
            panel.classList.add('show');
            document.body.appendChild(panel);
            const rect = bookmark.range.getBoundingClientRect();
            utils.showPanel(rect, panel);
        } catch (error) {
            // refine 失败保持原窗口/高亮，只有明确无词条会由翻译器写入 negative cache。
            if (!(error instanceof NoEntryError)) console.warn('细化查询未切换，保留原结果:', error);
        } finally {
            if (pendingRefine === snapshot) pendingRefine = null;
        }
    }

    // 手势判定 → 选区快照 → 英文提取 → 请求/高亮，共用同一条处理链。
    function captureTranslationSelection() {
        const selection = window.getSelection();
        if (!selection?.rangeCount || selection.isCollapsed || selection.rangeCount !== 1) return null;
        const selectedRange = selection.getRangeAt(0).cloneRange();
        const editableNode = node => utils.isEditableTarget(
            node.nodeType === Node.TEXT_NODE ? node.parentElement : node
        );
        if (editableNode(selectedRange.startContainer) || editableNode(selectedRange.endContainer)) return null;
        const rawText = selectedRange.toString();
        const translatorKey = GM_getValue('defaultTranslator', 'youdao');
        const prepared = prepareSelection(rawText, translatorKey);
        if (!prepared) return null;
        const range = sliceSelectionRange(selectedRange, prepared.start, prepared.end);
        if (!isCurrentRange(range, prepared.text)) return null;
        const sourceHighlight = translatorKey === 'google' ? null : containingHighlight(range);
        return {translatorKey, bookmark: {range, text: prepared.text}, selectedRange, rawText,
            epoch: selectionEpoch, sourceHighlight, sourceData: highlightStore.get(sourceHighlight)};
    }

    const handleSelection = utils.debounce(async snapshot => {
        if (!snapshot || !selectionIsCurrent(snapshot)) {
            if (pendingRefine === snapshot) pendingRefine = null;
            return;
        }
        const {translatorKey, bookmark, sourceHighlight} = snapshot;
        if (TRANSLATORS[translatorKey].isMissing(bookmark.text)) {
            if (pendingRefine === snapshot) pendingRefine = null;
            return;
        }
        if (sourceHighlight) return refineSelection(snapshot);
        const rect = bookmark.range.getBoundingClientRect();

        cleanupPanels();
        const targetPanel = createTranslatorPanel({translatorKey});
        targetPanel.selectionBookmark = bookmark;
        document.body.appendChild(targetPanel);
        utils.showPanel(rect, targetPanel);
        await translate(bookmark.text, targetPanel);
    }, CONFIG.triggerDelay);

    const eventHandlers = {
        handleMouseDown(e) {
            cancelSelection();
            state.selectionGesture = e.button === 0 ? {
                startedAt: e.timeStamp, x: e.clientX, y: e.clientY, clickCount: e.detail,
                startedInPanel: utils.isClickInPanel(e), startedInEditable: utils.isEditableTarget(e.target),
                sourceHighlight: highlightAtPoint(e.clientX, e.clientY, e.target)
            } : null;
            if (state.selectionGesture?.sourceHighlight) {
                cancelHoverTimers();
                utils.revivePanel(highlightStore.get(state.selectionGesture.sourceHighlight)?.ownerPanel);
            }
            if (state.isSelectingInPanel) {
                utils.stopEvent(e);
                return;
            }
            if (e.button === 2) state.isRightClickPending = true;
        },
        handleMouseUp(e) {
            const gesture = state.selectionGesture;
            state.selectionGesture = null;
            if (dragState) {
                dragState.panel.classList.remove('dragging');
                dragState = null;
                cancelSelection();
                utils.stopEvent(e);
                return;
            }
            if (state.isSelectingInPanel) {
                resetPanelSelection();
                utils.stopEvent(e);
                return;
            }
            if (state.isRightClickPending && e.button === 0) {
                document.querySelectorAll('.translator-panel:not(.pinned)').forEach(utils.hidePanel);
                state.isRightClickPending = false;
                cancelSelection();
                return;
            }
            if (e.button === 2) {
                state.isRightClickPending = false;
                return;
            }
            if (utils.isClickInPanel(e) || gesture?.startedInEditable || utils.isEditableTarget(e.target)) {
                cancelSelection();
                return;
            }
            if (e.button !== 0 || !gesture || gesture.startedInPanel || gesture.clickCount >= 3) return;
            const doubleClick = gesture.clickCount === 2;
            const heldMs = e.timeStamp - gesture.startedAt;
            const moved = Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y);
            if (!doubleClick && (heldMs < CONFIG.selectionMinHoldMs || moved < CONFIG.selectionMinDistance)) return;
            const snapshot = captureTranslationSelection();
            if (snapshot?.sourceHighlight) {
                pendingRefine = snapshot;
                cancelHoverTimers();
            }
            handleSelection(snapshot);
        },
        handleOutsideClick(e) {
            if (state.isSelectingInPanel) {
                utils.stopEvent(e);
                return;
            }
            if (state.isRightClickPending || dragState || utils.isClickInPanel(e) || refineLocked()) return;
            document.querySelectorAll('.translator-panel:not(.pinned)').forEach(utils.hidePanel);
        }
    };

    window.addEventListener('blur', () => {
        cancelSelection();
        state.selectionGesture = null;
    });

    document.addEventListener('mousedown', eventHandlers.handleMouseDown, {capture: true, passive: false});
    document.addEventListener('mouseup', eventHandlers.handleMouseUp, {capture: true, passive: false});
    document.addEventListener('click', eventHandlers.handleOutsideClick, {capture: true, passive: false});
    document.addEventListener('contextmenu', e => {
        if (!(e.target instanceof Element) || !e.target.closest('.translator-panel')) {
            state.isRightClickPending = true;
        }
    }, {passive: false});

    // 共用命中与过渡入口，每帧最多测量一次文字矩形。
    let hoverFrame = null;
    let hoverPoint = null;
    document.addEventListener('mousemove', e => {
        hoverPoint = {x: e.clientX, y: e.clientY, target: e.target, buttons: e.buttons};
        if (hoverFrame !== null) return;
        hoverFrame = requestAnimationFrame(() => {
            hoverFrame = null;
            const {x, y, target, buttons} = hoverPoint;
            if (!buttons && !dragState && !state.selectionGesture) updateHoverTarget(x, y, target);
        });
    }, {passive: true});
    document.addEventListener('mouseleave', () => {
        hoverHighlights?.clear();
        scheduleHideHover();
    });

    // 流式回复、SPA 切页后丢弃失效 Range，避免残留词表和引用。
    const pruneHighlights = utils.debounce(() => {
        let changed = false;
        for (const range of highlightStore.keys()) {
            if (!isHighlightValid(range)) {
                removeHighlight(range, false);
                changed = true;
            }
        }
        if (changed) updateWordbookUI();
    }, 200);
    new MutationObserver(records => {
        if (highlightStore.size && records.some(record => {
            const element = record.target.nodeType === Node.TEXT_NODE ? record.target.parentElement : record.target;
            return !element?.closest?.('.translator-panel, .popdict-wordbook-button');
        })) pruneHighlights();
    }).observe(document.body, {childList: true, subtree: true, characterData: true});

    function refreshOpenDropdowns() {
        document.querySelectorAll('.translator-panel').forEach(panel => panel.refreshDropdown?.());
    }

    function setupTranslatorSwitch(targetPanel) {
        const titleWrapper = targetPanel.querySelector('.title-wrapper');
        const title = targetPanel.querySelector('.title');
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
            if (targetPanel.classList.contains('closing') || show === targetPanel.isDropdownOpen) return;
            targetPanel.isDropdownOpen = show;
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
                    if (!targetPanel.isDropdownOpen && !targetPanel.classList.contains('closing')) {
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
            utils.stopEvent(e);
            toggleDropdown(!targetPanel.isDropdownOpen);
        });

        dropdownMenu.addEventListener('click', e => {
            utils.stopEvent(e);
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
                    translate(targetPanel.translationText, targetPanel);
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
        if (e.target.closest('.title-wrapper, .icon-button, .dropdown-menu')) return;

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
        targetPanel.manualPosition = true;
        targetPanel.classList.add('dragging');
        utils.stopEvent(e);
    }

    // 所有窗口共用一组文档级拖动监听器，避免新窗口覆盖旧窗口的监听器。
    document.addEventListener('mousemove', e => {
        if (!dragState) return;
        const {panel, startX, startY, startLeft, startTop, scrollX, scrollY} = dragState;
        if (!panel.isConnected) {
            dragState = null;
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
        updateThemeButton(targetPanel.querySelector('.theme-button'), utils.isDarkMode());
        updatePinButton(targetPanel.querySelector('.pin-button'), targetPanel.classList.contains('pinned'));

        // 面板按钮共用事件入口，动作类保留各自的职责。
        targetPanel.addEventListener('click', e => {
            const button = e.target.closest('.icon-button, .audio-button');
            if (!button) return;
            utils.stopEvent(e);
            cancelSelection();
            if (button.classList.contains('audio-button')) {
                state.isSelectingInPanel = false;
                if (button.dataset.url) audio.play(button.dataset.url);
            } else if (button.classList.contains('unhighlight-button')) {
                removeHighlight(targetPanel.highlightRange);
            } else if (button.classList.contains('external-button')) {
                const url = EXTERNAL_URLS[targetPanel.translatorKey];
                if (url && targetPanel.translationText) window.open(url + encodeURIComponent(targetPanel.translationText), '_blank');
            } else if (button.classList.contains('pin-button')) {
                const pinned = targetPanel.classList.toggle('pinned');
                updatePinButton(button, pinned);
                // 固定后的悬浮窗交给普通窗口管理，取消自动关闭。
                if (pinned && targetPanel === hoverPanel) {
                    cancelHoverTimers();
                    hoverPanel = null;
                }
            } else if (button.classList.contains('theme-button')) {
                utils.toggleDarkMode();
            } else if (button.classList.contains('clear-button')) {
                hideHoverPanel();
                document.querySelectorAll('.translator-panel').forEach(panel => utils.hidePanel(panel, true));
                wordbookPanel = null;
                dragState?.panel.classList.remove('dragging');
                dragState = null;
                resetPanelSelection();
                state.isRightClickPending = false;
                state.selectionGesture = null;
            }
        });

        targetPanel.addEventListener('mousedown', e => {
            const inContent = e.target.closest('.content');
            if (inContent && !e.target.closest('.audio-button')) {
                if (e.detail < 3) {
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
                utils.stopEvent(e);
                document.querySelectorAll('.translator-panel:not(.pinned)').forEach(utils.hidePanel);
            }
        });
    }

    // 浏览器窗口尺寸变化时，重新限制所有翻译窗口的高度和位置。
    window.addEventListener('resize', utils.debounce(() => {
        document.querySelectorAll('.translator-panel:not(.dragging):not(.popdict-wordbook-panel)').forEach(panel => {
            utils.fitPanelToViewport(panel);
        });
    }, 100));

    // 页面滚动后，仅在窗口完全离开视口时将其拉回可见区域。
    let scrollTimer = null;
    window.addEventListener('scroll', () => {
        if (scrollTimer) return;
        scrollTimer = setTimeout(() => {
            scrollTimer = null;
            document.querySelectorAll('.translator-panel:not(.dragging):not(.popdict-wordbook-panel)').forEach(panel => {
                if (!panel.isConnected || panel.classList.contains('closing') || panel.style.display === 'none') return;
                const rect = panel.getBoundingClientRect();
                const outside = rect.right < CONFIG.panelSpacing
                    || rect.left > window.innerWidth - CONFIG.panelSpacing
                    || rect.bottom < CONFIG.panelSpacing
                    || rect.top > window.innerHeight - CONFIG.panelSpacing;
                if (!outside) return;

                utils.positionPanel(panel, rect.left, rect.top);
            });
        }, 100);
    }, {passive: true});
})();
