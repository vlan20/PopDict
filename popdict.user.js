// ==UserScript==
// @name         PopDict 词窗 - 划词翻译
// @namespace    https://github.com/vlan20/popdict
// @version      0.1.7
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

    // 静默启动：真实左键操作前仅注册入口，不读取页面/设置，不注入样式或联网。
    function activate(event) {
        if (!event.isTrusted || event.button !== 0) return;
        document.removeEventListener('mousedown', activate, true);
        initialize(event);
    }
    document.addEventListener('mousedown', activate, true);

    function initialize(firstEvent) {
    // 页面脚本 dispatchEvent()/click() 不能触发本脚本的查询、播放或导出。
    const on = (target, type, handler, options) => target.addEventListener(type, event => {
        if (event.isTrusted) handler(event);
    }, options);

    const panels = (filter = '') => document.querySelectorAll(`.translator-panel${filter}`);
    // 窗口尺寸/滚动时需要重新约束的面板（排除拖动中与词表）
    const floatingPanels = () => panels(':not(.dragging):not(.popdict-wordbook-panel)');

    // 配置项
    const CONFIG = {
        enableCambridge: false, // 暂停自动查询，保留模块和手动词典入口
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

    const ICONS = {external: '🔎', eraser: '🧹', lock: '🔒', unlock: '🔓', moon: '🌙', sun: '🔆', close: '❌', trash: '📤', audio: '🔊'};
    const ALLOWED_HOSTS = ['translate.googleapis.com', 'dict.youdao.com', 'dictionary.cambridge.org'];

    // 带过期时间的内存缓存（插入序淘汰）；词条缓存与"无词条"缓存共用。
    const cacheKey = (translator, text) => `${translator}:${text}`;
    const createExpiringCache = ttl => {
        const store = new Map();
        return {
            get(key) {
                const item = store.get(key);
                if (item && item.expires > Date.now()) return item.value;
                store.delete(key);
                return undefined;
            },
            set(key, value) {
                store.delete(key);
                store.set(key, {value, expires: Date.now() + ttl});
                if (store.size > CONFIG.maxCacheSize) store.delete(store.keys().next().value);
            }
        };
    };
    const translationCache = createExpiringCache(CONFIG.cacheExpiration);
    // 只接收解析器的明确无词条信号；不持久化，不记录网络/HTTP/解析异常。
    const negativeCache = createExpiringCache(CONFIG.negativeCacheExpiration);

    class NoEntryError extends Error {
        constructor() { super('词典确认无有效词条'); this.name = 'NoEntryError'; }
    }

    const dictionaryKey = text => text.trim().toLowerCase().replace(/’/g, "'").replace(/\s+/g, ' ');

    // 新建窗口前移除未固定的旧窗口，固定窗口保留。
    function cleanupPanels() {
        hideHoverPanel(true);
        panels(':not(.pinned)').forEach(panel => utils.removePanel(panel));
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

    // 默认匿名；仅剑桥词条查询显式允许浏览器正常 Cookie，不读取或复制 Cookie。
    const gmGet = (url, options = {}) => new Promise((resolve, reject) => {
        const destination = new URL(url);
        if (destination.protocol !== 'https:' || destination.username || destination.password
            || !ALLOWED_HOSTS.includes(destination.hostname)) {
            reject(new Error('已阻止非词典地址请求'));
            return;
        }
        if (!CONFIG.enableCambridge && destination.hostname === 'dictionary.cambridge.org') {
            reject(new Error('剑桥自动查询已关闭，请手动打开词典'));
            return;
        }
        GM_xmlhttpRequest({
            method: 'GET',
            url,
            anonymous: true,
            ...options,
            timeout: CONFIG.requestTimeout,
            onload: response => {
                if (response.status >= 200 && response.status < 300) return resolve(response);
                const message = destination.hostname === 'dictionary.cambridge.org' && response.status === 403
                    ? '剑桥访问被拒绝（HTTP 403）。可点击 🔎 手动打开词典检查访问状态，或手动切换引擎；脚本不会自动重试。'
                    : `HTTP ${response.status}`;
                reject(new Error(message));
            },
            onerror: () => reject(new Error('网络请求失败')),
            ontimeout: () => reject(new Error('请求超时')),
            onabort: () => reject(new Error('请求已取消'))
        });
    });

    // 仅规范 Google 查询副本；选区 Range 与 bookmark 继续保留原文和偏移。
    const normalizeGoogleText = text => text.replace(/\r\n?/g, '\n').trim()
        .split(/\n[ \t]*\n(?:[ \t]*\n)*/)
        .map(paragraph => paragraph.replace(/[ \t\n]+/g, ' ').trim()).filter(Boolean).join('\n\n');

    // 翻译器统一规范查询与缓存键，面板和外链复用相同文本。
    // enabled() 为 false 时直接返回 disabledResult，且发生在缓存之前，不触发查询或高亮。
    const createTranslator = (name, translateFn, {dictionary = false, normalize = text => text,
        enabled = () => true, disabledResult = null} = {}) => {
        const missingKey = text => cacheKey(name, dictionaryKey(text));
        const isMissing = text => dictionary && Boolean(negativeCache.get(missingKey(text)));
        return {
            name,
            normalize,
            isMissing: text => enabled() && isMissing(text),
            translate: async text => {
                if (!enabled()) return disabledResult;
                text = normalize(text);
                if (isMissing(text)) throw new NoEntryError();
                const cached = translationCache.get(cacheKey(name, text));
                if (cached) return cached;
                try {
                    const result = await translateFn(text);
                    if (!result?.html) throw new Error('翻译结果为空');
                    translationCache.set(cacheKey(name, text), result);
                    return result;
                } catch (error) {
                    if (dictionary && error instanceof NoEntryError) {
                        negativeCache.set(missingKey(text), true);
                        throw error;
                    }
                    throw new Error(`${name}失败: ${error?.message || '请求失败'}`);
                }
            }
        };
    };

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
            return { html: utils.escapeHtml(result[0].map(x => x[0]).join('')), highlightable: false };
        }, {normalize: normalizeGoogleText}),

        youdao: createTranslator('有道词典', async (text) => {
            const response = await gmGet(
                `https://dict.youdao.com/jsonapi?xmlVersion=5.1&jsonversion=2&q=${encodeURIComponent(text)}`,
                { headers: { 'Referer': 'https://dict.youdao.com' } }
            );

            const result = JSON.parse(response.responseText);
            if (result.error || (result.errorCode && String(result.errorCode) !== '0')) throw new Error('词典接口返回错误');
            if (result.query && dictionaryKey(result.query) !== dictionaryKey(text)) throw new Error('词典返回的查询词不匹配');
            const wordInfo = result.ec?.word?.[0];
            const definitions = (wordInfo?.trs || []).flatMap(item => item.tr || [])
                .flatMap(item => item.l?.i || []).filter(value => typeof value === 'string' && value.trim());
            const headword = wordInfo?.['return-phrase']?.l?.i;
            const exactEntry = !headword || (Array.isArray(headword) ? headword : [headword])
                .some(value => dictionaryKey(value) === dictionaryKey(text));
            if (Array.isArray(result.ec?.word) && !result.ec.word.length) throw new NoEntryError();
            // 音标 + 发音按钮
            const pronunciations = [['英', wordInfo?.ukphone, wordInfo?.ukspeech], ['美', wordInfo?.usphone, wordInfo?.usspeech]]
                .filter(([, phone, speech]) => phone && speech)
                .map(([type, phone, speech]) => createPronHtml(type, `/${phone}/`, `https://dict.youdao.com/dictvoice?audio=${speech}`));
            let translation = pronunciations.length ? `<div class="phonetic-buttons">${pronunciations.join('')}</div>\n\n` : '';

            // 获取翻译结果
            if (definitions.length) {
                translation += definitions.map(utils.escapeHtml).join('; ');
            } else if (result.fanyi) {
                translation = utils.escapeHtml(result.fanyi.tran);
            } else if (result.translation) {
                translation = utils.escapeHtml(result.translation.join('\n'));
            } else if (result.web_trans?.web_translation) {
                translation = utils.escapeHtml(result.web_trans.web_translation
                    .map(item => item.trans.map(t => t.value).join('; '))
                    .join('\n'));
            }

            if (!translation) throw new Error('未找到翻译结果');
            return {html: translation, highlightable: definitions.length > 0, dictionaryEntry: definitions.length > 0 && exactEntry};
        }, {dictionary: true}),

        cambridge: createTranslator('剑桥词典', async (text) => {
            const response = await gmGet(
                `https://dictionary.cambridge.org/search/english-chinese-simplified/direct/?q=${encodeURIComponent(text)}`,
                {
                    anonymous: false,
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
        }, {
            dictionary: true,
            enabled: () => CONFIG.enableCambridge, // 暂停自动查询，保留模块和手动词典入口
            disabledResult: {
                html: '<div>⚠ 当前暂不支持自动查询</div><button type="button" class="cambridge-open">🔎 在剑桥词典中打开</button>',
                highlightable: false
            }
        })
    };

    const EXTERNAL_URLS = {
        google: 'https://translate.google.com/?sl=auto&tl=zh-CN&text=',
        youdao: 'https://dict.youdao.com/w/',
        cambridge: 'https://dictionary.cambridge.org/search/english-chinese-simplified/direct/?q='
    };

    // 样式约定：`&` 即 .translator-panel；PANEL_CSS 中的声明统一追加 !important 以压过宿主页面样式。
    // 不能加 !important 的内容（主题变量、display:none 须可被行内样式覆盖、all:revert、动画、高亮）放在 SOFT_CSS。
    const SOFT_CSS = `
        & {
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
            --theme-transition: background-color 0.15s ease-out, color 0.15s ease-out, border-color 0.15s ease-out;
            display: none;
        }
        &.translator-panel-dark {
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
        & * { all: revert; }
        @keyframes popdict-loading { from { transform: translateX(-110%); } to { transform: translateX(290%); } }
        ::highlight(popdict-words) { background-color: rgba(245, 158, 11, 0.22); text-decoration: underline rgba(217, 119, 6, 0.7); }
        ::highlight(popdict-hover) { background-color: rgba(245, 158, 11, 0.38); }
        ::highlight(popdict-jump) { background-color: rgba(59, 130, 246, 0.3); }
    `;
    const PANEL_CSS = `
        /* 主题变量与面板基础 */
        & {
            position: absolute;
            z-index: 2147483647;
            flex-direction: column;
            box-sizing: border-box;
            max-width: min(${CONFIG.panelWidth}px, calc(100vw - ${CONFIG.panelSpacing * 2}px));
            max-height: calc(100vh - ${CONFIG.panelSpacing * 2}px);
            overflow: hidden;
            padding: var(--spacing-md);
            border: 1px solid var(--panel-border);
            border-radius: 6px;
            background: var(--panel-bg);
            box-shadow: 0 4px 12px var(--panel-shadow);
            color: var(--panel-text);
            font-size: ${CONFIG.fontSize}px;
            line-height: 1.5;
            opacity: 0;
            transform: none;
            transition: var(--theme-transition), opacity ${CONFIG.animationDuration}ms ease-out;
        }
        /* 隔离宿主网页样式；必须放在组件规则之前 */
        & * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            color: inherit;
            font-family: inherit;
            font-size: inherit;
            line-height: inherit;
            pointer-events: auto;
        }
        &.show { opacity: 1; }
        &:has(.source-preview) { width: 460px; max-width: calc(100vw - ${CONFIG.panelSpacing * 2}px); }
        & .cambridge-open {
            display: inline-block;
            margin-top: var(--spacing-lg);
            padding: 4px 8px;
            font-size: 12px;
            line-height: 1.4;
            border: 1px solid var(--panel-border);
            border-radius: 6px;
            background: var(--hover-bg);
            cursor: pointer;
        }
        & .cambridge-open:hover { background: var(--title-hover-bg); }
        & .cambridge-open:focus-visible, & .source-preview summary:focus-visible {
            outline: 2px solid var(--active-link);
        }
        &.dropdown-open { overflow: visible; }
        &.dragging { cursor: move; opacity: 0.95; pointer-events: none; transition: none; }
        /* 标题栏与翻译器切换 */
        & .title-bar {
            position: relative;
            display: flex;
            align-items: center;
            justify-content: flex-start;
            gap: var(--spacing-md);
            min-width: 0;
            margin: calc(-1 * var(--spacing-md)) calc(-1 * var(--spacing-md)) var(--spacing-md);
            padding: var(--spacing-xs) var(--spacing-md);
            border-bottom: 1px solid var(--panel-border);
            border-radius: 6px 6px 0 0;
            background: var(--title-bg);
            flex: 0 0 auto;
            cursor: move;
            user-select: none;
            transition: var(--theme-transition);
        }
        & .title-wrapper {
            position: relative;
            display: inline-flex;
            align-items: center;
            flex: 0 0 auto;
            width: max-content;
            gap: var(--spacing-sm);
            margin-right: auto;
            padding: var(--spacing-xs) var(--spacing-lg);
            border: 0;
            border-radius: var(--spacing-sm);
            background: transparent;
            cursor: pointer;
            transition: background-color 0.2s;
        }
        & .title-wrapper:hover, & .title-wrapper.open { background: var(--title-hover-bg); }
        & .title, & .switch-text {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: var(--font-sm);
        }
        & .title { color: var(--panel-text); font-weight: 500; }
        & .switch-text { color: var(--text-tertiary); opacity: 0.8; }
        /* 标题栏图标按钮 */
        & .icon-button {
            display: flex;
            align-items: center;
            justify-content: center;
            flex: 0 0 18px;
            width: 18px;
            height: 18px;
            padding: 0;
            border: 0;
            border-radius: 3px;
            background: transparent;
            color: var(--panel-text);
            cursor: pointer;
            opacity: 0.82;
            font: 15px/1 "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif;
            transition: background-color 0.15s, opacity 0.15s;
        }
        & .icon-button:hover { background: var(--title-hover-bg); opacity: 1; }
        & .pin-button.pinned { opacity: 1; }
        & .unhighlight-button[hidden] { display: none; }
        /* 翻译器下拉菜单 */
        & .dropdown-menu {
            position: absolute;
            top: calc(100% + 4px);
            left: 0;
            z-index: 2147483647;
            min-width: 150px;
            max-height: 300px;
            overflow-y: auto;
            border: 1px solid var(--panel-border);
            border-radius: 6px;
            background: var(--panel-bg);
            box-shadow: 0 2px 8px var(--panel-shadow);
            opacity: 0;
            visibility: hidden;
            transform: scale(0.95);
            transform-origin: top left;
            transition: opacity 0.15s ease-out, transform 0.15s ease-out, visibility 0.15s;
        }
        & .dropdown-menu.open-upward { top: auto; bottom: calc(100% + 4px); transform-origin: bottom left; }
        & .dropdown-menu.align-right { right: 0; left: auto; }
        & .dropdown-menu.show { visibility: visible; opacity: 1; transform: scale(1); }
        & .dropdown-menu::before, & .dropdown-menu::after, & .title-wrapper::before, & .title-wrapper::after, & .title-bar::before, & .title-bar::after {
            content: none;
            display: none;
        }
        & .dropdown-item {
            position: relative;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: var(--spacing-md) var(--spacing-xl);
            color: var(--panel-text);
            font-size: var(--font-sm);
            white-space: nowrap;
            cursor: pointer;
        }
        & .dropdown-item:hover { background: var(--hover-bg); }
        & .translator-name { display: flex; align-items: center; gap: var(--spacing-sm); }
        & .dropdown-item.active .translator-name { font-weight: 600; }
        & .dropdown-item.is-default .translator-name::after {
            content: '默认';
            margin-left: var(--spacing-sm);
            padding: 2px 4px;
            border-radius: 3px;
            background: var(--text-tertiary);
            color: var(--panel-bg);
            font-size: var(--font-xs);
            font-weight: 400;
            opacity: 0.8;
        }
        & .set-default {
            padding: var(--spacing-xs) var(--spacing-sm);
            border-radius: var(--spacing-xs);
            color: var(--text-tertiary);
            font-size: var(--font-xs);
            opacity: 0;
            transition: color 0.2s, background-color 0.2s, opacity 0.2s;
        }
        & .dropdown-item:hover .set-default { opacity: 1; }
        & .set-default:hover { background: var(--hover-bg); color: var(--active-link); }
        & .dropdown-item.is-default .set-default { display: none; }
        /* 加载状态与网页高亮 */
        & .loading-bar {
            position: absolute;
            top: 27px;
            left: 0;
            right: 0;
            height: 2px;
            overflow: hidden;
            opacity: 0;
            pointer-events: none;
        }
        &.loading .loading-bar { opacity: 1; }
        & .loading-bar::after {
            content: '';
            display: block;
            width: 38%;
            height: 100%;
            background: var(--active-link);
            animation: popdict-loading 0.9s ease-in-out infinite;
        }
        /* 页面高亮词汇 */
        .popdict-wordbook-button {
            position: fixed;
            right: 18px;
            bottom: 18px;
            z-index: 2147483646;
            min-width: 52px;
            height: 34px;
            padding: 0 12px;
            border: 1px solid #d1d5db;
            border-radius: 17px;
            background: #fff;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
            color: #111;
            font: 500 14px/1 sans-serif;
            cursor: pointer;
        }
        .popdict-wordbook-button:hover { background: #f1f5f9; }
        .popdict-wordbook-button.dark { border-color: #333; background: #1a1a1a; color: #e0e0e0; }
        .popdict-wordbook-button.dark:hover { background: #2c2c2c; }
        &.popdict-wordbook-panel {
            position: fixed;
            right: 18px;
            bottom: 62px;
            left: auto;
            top: auto;
            display: flex;
            width: max-content;
            min-width: 210px;
            max-width: min(340px, calc(100vw - 24px));
            max-height: min(60vh, 420px);
            opacity: 1;
            transform: none;
        }
        .popdict-wordbook-panel .title-bar { margin-bottom: 0; cursor: default; }
        .popdict-wordbook-panel .wordbook-title { margin-right: auto; }
        .popdict-wordbook-panel .wordbook-export {
            border: 0;
            background: transparent;
            color: var(--panel-text);
            font-size: var(--font-sm);
            cursor: pointer;
            opacity: 0.68;
        }
        .popdict-wordbook-panel .wordbook-export:hover { opacity: 1; }
        .popdict-wordbook-panel .wordbook-list { padding: 3px; }
        .popdict-wordbook-panel .wordbook-item {
            gap: var(--spacing-sm);
            padding: 3px 6px;
            border-radius: var(--spacing-sm);
            font-size: 15px;
            line-height: 1.25;
        }
        .popdict-wordbook-panel .wordbook-word {
            flex: 1 1 auto;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .popdict-wordbook-panel .wordbook-count {
            flex: 0 0 auto;
            color: var(--text-tertiary);
            font-size: var(--font-sm);
        }
        .popdict-wordbook-panel .wordbook-remove { color: var(--panel-text); opacity: 0; visibility: hidden; }
        .popdict-wordbook-panel .wordbook-item:hover .wordbook-remove, .popdict-wordbook-panel .wordbook-remove:focus-visible {
            opacity: 1;
            visibility: visible;
        }
        /* 翻译内容 */
        & .content {
            position: relative;
            display: flex;
            flex: 1 1 auto;
            flex-direction: column;
            min-height: 0;
            overflow: hidden;
        }
        & .source-text {
            flex: 0 0 auto;
            padding: var(--spacing-md);
            border-bottom: 1px solid var(--panel-border);
            background: var(--panel-bg);
            transition: var(--theme-transition);
            color: var(--panel-text);
            font-size: ${CONFIG.sourceFontSize}px;
            font-weight: 600;
            white-space: pre-wrap;
            user-select: text;
        }
        & .source-text, & .translation, & .def-content { overflow-wrap: anywhere; }
        & .translation-container { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: var(--spacing-md); }
        & .translation {
            max-width: 100%;
            color: var(--panel-text);
            font-size: ${CONFIG.translationFontSize}px;
            white-space: normal;
            user-select: text;
        }
        & .translation-prose, & .source-prose {
            white-space: normal;
            font-size: ${CONFIG.translationFontSize}px;
            line-height: 1.55;
        }
        & .translation-prose p + p, & .source-prose p + p { margin-top: .5em; }
        & .source-preview { margin-bottom: var(--spacing-lg); border-bottom: 1px solid var(--panel-border); }
        & .source-preview summary {
            display: list-item;
            padding: var(--spacing-sm) 0;
            font-size: 12px;
            line-height: 1.4;
            color: var(--text-secondary);
            cursor: pointer;
        }
        & .source-preview .source-text {
            padding: var(--spacing-sm) 0 var(--spacing-lg);
            border: 0;
            font-weight: 400;
        }
        & .error { padding: var(--spacing-xl) 0; color: var(--error); font-size: var(--font-sm); text-align: center; }
        /* 词典释义组件 */
        & .phonetic-buttons, & .sense-phonetic { display: flex; flex-wrap: wrap; }
        & .phonetic-buttons { gap: var(--spacing-xl); margin-bottom: var(--spacing-sm); }
        & .phonetic-item {
            display: flex;
            align-items: center;
            gap: var(--spacing-xs);
            padding: var(--spacing-xs) var(--spacing-sm);
            color: var(--text-secondary);
            font-size: 12px;
            line-height: 1.3;
            white-space: nowrap;
            user-select: text;
        }
        & .audio-button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: var(--spacing-xs) var(--spacing-sm);
            border: 0;
            border-radius: var(--spacing-xs);
            background: transparent;
            color: var(--active-link);
            font: var(--font-lg)/1 "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif;
            cursor: pointer;
            opacity: 0.82;
            transition: background-color 0.15s, opacity 0.15s, transform 0.2s;
        }
        & .audio-button:hover { background: var(--hover-bg); opacity: 1; }
        & .audio-button:active { transform: scale(0.95); }
        & .sense-block {
            display: flex;
            align-items: flex-start;
            gap: var(--spacing-md);
            margin: var(--spacing-xs) 0;
            padding: var(--spacing-xs) 0;
            border-bottom: 1px solid var(--panel-border);
            transition: var(--theme-transition);
        }
        & .sense-block:first-child { margin-top: 0; }
        & .sense-block:last-child { margin-bottom: 0; border-bottom: 0; }
        & .pos-tags {
            display: flex;
            flex-direction: column;
            flex-shrink: 0;
            align-items: center;
            min-width: 35px;
            gap: var(--spacing-xs);
        }
        & .pos-tag {
            width: 100%;
            padding: var(--spacing-xs) var(--spacing-sm);
            border-radius: var(--spacing-xs);
            background: #6b7280;
            color: #fff;
            font-size: 12px;
            line-height: 1.3;
            font-weight: 500;
            text-align: center;
            user-select: text;
        }
        & .level-tag {
            min-width: 24px;
            margin-top: var(--spacing-xs);
            padding: var(--spacing-xs) var(--spacing-sm);
            border-radius: 3px;
            font-weight: 500;
            letter-spacing: 0.5px;
            text-align: center;
            font-size: 11px;
            line-height: 1.2;
            background: var(--hover-bg);
        }
        & .def-content { flex: 1; min-width: 0; overflow: visible; }
        & .sense-phonetic { gap: var(--spacing-md); margin-bottom: var(--spacing-xs); font-size: 12px; line-height: 1.3; opacity: 0.8; }
        & .sense-phonetic .audio-button { padding: var(--spacing-xs); }
        /* 词典正文密度：共用组件，不为每个翻译器复制面板样式。 */
        & .def-text, & .phrase-text { font-size: 13px; line-height: 1.45; }
        & .trans-line { font-size: 14px; line-height: 1.45; }
        & .phrase-text { font-weight: 600; }
        /* 滚动条 */
        & .dropdown-menu::-webkit-scrollbar { width: 3px; height: 3px; }
        & .translation-container::-webkit-scrollbar { width: 5px; height: 5px; }
        & .dropdown-menu::-webkit-scrollbar-thumb, & .translation-container::-webkit-scrollbar-thumb {
            border-radius: 4px;
            background: var(--text-tertiary);
        }
        & .dropdown-menu::-webkit-scrollbar-thumb:hover, & .translation-container::-webkit-scrollbar-thumb:hover {
            background: var(--text-secondary);
        }
        & .dropdown-menu::-webkit-scrollbar-track { background: transparent; }
        & .translation-container::-webkit-scrollbar-track { border-radius: 4px; background: var(--hover-bg); }
        /* 关闭动画 */
        &.closing { opacity: 0; pointer-events: none; }
        &.closing * { pointer-events: none; }
    `;
    const withImportant = css => css.replace(/([\w-]+\s*:[^;{}]+?)\s*;/g, '$1 !important;');
    GM_addStyle((SOFT_CSS + withImportant(PANEL_CSS)).replace(/&/g, '.translator-panel'));

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
            panels(':not(.closing)').forEach(panel => {
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
        hideUnpinned: () => panels(':not(.pinned)').forEach(panel => utils.hidePanel(panel)),
        isEditableTarget: target => {
            for (let node = target; node instanceof Element; node = node.getRootNode()?.host) {
                if (node.isContentEditable || node.closest('input, textarea, select, option')) return true;
            }
            return false;
        },
        isClickInPanel: e => e.target instanceof Element && Boolean(
            e.target.closest('.translator-panel, .popdict-wordbook-button')
        ),
        stopEvent(e) {
            e.preventDefault();
            e.stopPropagation();
        }
    };

    const buildContentHTML = (text, html, translatorKey) => {
        // 输入已转义；空行分段，单换行按普通空白排版，不固定网页源码的断行。
        const paragraphs = escaped => escaped.replace(/\r\n?/g, '\n').trim().split(/\n[ \t]*\n(?:[ \t]*\n)*/)
            .filter(part => part.trim()).map(part => `<p>${part.trim()}</p>`).join('');
        const prose = translatorKey === 'google';
        const escaped = utils.escapeHtml(text);
        const original = `<div class="source-text${prose ? ' source-prose' : ''}">${prose ? paragraphs(escaped) : escaped}</div>`;
        const translation = `<div class="translation${prose ? ' translation-prose' : ''}">${prose ? paragraphs(html) : html}</div>`;
        // 长文本共用一个滚动区域；原生 details 保留全文，无额外展开状态。
        return translatorKey === 'google' && text.length > 160
            ? `<div class="translation-container"><details class="source-preview"><summary>查看原文</summary>${original}</details>${translation}</div>`
            : `${original}<div class="translation-container">${translation}</div>`;
    };

    // 在原选区内截取英文部分，仅生成 Range，不改写原文节点。
    function sliceSelectionRange(selected, start, end) {
        if (selected.startContainer === selected.endContainer && selected.startContainer.nodeType === Node.TEXT_NODE) {
            const range = selected.cloneRange();
            range.setStart(selected.startContainer, selected.startOffset + start);
            range.setEnd(selected.startContainer, selected.startOffset + end);
            return range;
        }
        let container = selected.commonAncestorContainer;
        if (container.nodeType === Node.TEXT_NODE) container = container.parentElement;
        if (!container || container.closest?.('.translator-panel')) return null;
        const range = document.createRange();
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        let node, offset = 0, started = false;
        while ((node = walker.nextNode())) {
            if (!selected.intersectsNode(node)) continue;
            const from = node === selected.startContainer ? selected.startOffset : 0;
            const to = node === selected.endContainer ? selected.endOffset : node.length;
            const next = offset + to - from;
            if (!started && start < next) {
                range.setStart(node, from + start - offset);
                started = true;
            }
            if (started && end <= next) {
                range.setEnd(node, from + end - offset);
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

        on(wordbookPanel, 'click', e => {
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
            on(wordbookButton, 'click', e => {
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
                || (range.startContainer.getRootNode() === oldRange.startContainer.getRootNode()
                    && range.compareBoundaryPoints(Range.END_TO_START, oldRange) < 0
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
        on(panel, 'mouseenter', () => {
            cancelHoverTimers();
            utils.revivePanel(panel);
        });
        on(panel, 'mouseleave', e => {
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

        const translator = TRANSLATORS[targetPanel.translatorKey];
        if (!translator) throw new Error('未找到指定的翻译器');

        const textToTranslate = translator.normalize(text.replace(/\r\n?/g, '\n').trim());
        if (!textToTranslate) throw new Error('翻译文本为空');

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
            content.innerHTML = buildContentHTML(textToTranslate, result.html, targetPanel.translatorKey);
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
            targetPanel.querySelector('.content').innerHTML = buildContentHTML(translationText, resultHtml, translatorKey);
        }
        setHighlightButton(targetPanel, Boolean(highlightRange));
        setupPanelEvents(targetPanel);
        return targetPanel;
    }

    function containingHighlight(range) {
        return Array.from(highlightStore.keys()).find(source => isHighlightValid(source)
            && source.startContainer.getRootNode() === range.startContainer.getRootNode()
            && source.compareBoundaryPoints(Range.START_TO_START, range) <= 0
            && source.compareBoundaryPoints(Range.END_TO_END, range) >= 0) || null;
    }

    // 只使用本次鼠标事件路径中的 shadow roots，不扫描页面或穿透 closed roots。
    function readSelectionRange(roots = []) {
        const selection = window.getSelection();
        if (!selection) return null;
        let source;
        if (selection.getComposedRanges) {
            const ranges = selection.getComposedRanges({shadowRoots: roots});
            if (ranges.length !== 1) return null;
            source = ranges[0];
        } else {
            const scoped = roots.find(root => typeof root.getSelection === 'function')?.getSelection() || selection;
            if (scoped.rangeCount !== 1) return null;
            source = scoped.getRangeAt(0);
        }
        if (source.startContainer.getRootNode() !== source.endContainer.getRootNode()) return null;
        const range = document.createRange();
        range.setStart(source.startContainer, source.startOffset);
        range.setEnd(source.endContainer, source.endOffset);
        return range.collapsed ? null : range;
    }

    function selectionIsCurrent(snapshot) {
        if (snapshot.epoch !== selectionEpoch) return false;
        const current = readSelectionRange(snapshot.roots);
        if (!current) return false;
        if (current.startContainer.getRootNode() !== snapshot.selectedRange.startContainer.getRootNode()) return false;
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

    // Range.toString() 不保留块级段落边界；只遍历选区内的节点构造查询副本。
    function googleSelectionText(range) {
        const root = range.commonAncestorContainer;
        if (root.nodeType === Node.TEXT_NODE) return normalizeGoogleText(range.toString());
        const styles = new Map();
        const style = element => {
            if (!styles.has(element)) styles.set(element, getComputedStyle(element));
            return styles.get(element);
        };
        const paragraphOf = node => {
            for (let element = node.parentElement; element; element = element.parentElement) {
                if (!/^(inline(?:-block|-flex|-grid)?|contents)$/.test(style(element).display)) return element;
            }
            return root;
        };
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
            acceptNode: node => {
                if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
                if (node.nodeType === Node.ELEMENT_NODE && (node.matches('script, style, template, noscript, input, textarea, select')
                    || style(node).display === 'none' || style(node).visibility === 'hidden')) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        const parts = [];
        let node, previousParagraph;
        while ((node = walker.nextNode())) {
            if (node.nodeType === Node.ELEMENT_NODE) {
                if (node.tagName === 'BR') parts.push('\n\n');
                continue;
            }
            const text = node.data.slice(node === range.startContainer ? range.startOffset : 0,
                node === range.endContainer ? range.endOffset : node.length);
            if (text.trim()) {
                const paragraph = paragraphOf(node);
                if (previousParagraph && previousParagraph !== paragraph) parts.push('\n\n');
                previousParagraph = paragraph;
            }
            parts.push(text);
        }
        return normalizeGoogleText(parts.join(''));
    }

    // 手势判定 → 选区快照 → 英文提取 → 请求/高亮，共用同一条处理链。
    function captureTranslationSelection(roots) {
        const selectedRange = readSelectionRange(roots);
        if (!selectedRange) return null;
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
        const queryText = translatorKey === 'google' ? googleSelectionText(range) : prepared.text;
        if (!queryText) return null;
        return {translatorKey, bookmark: {range, text: prepared.text}, queryText, selectedRange, rawText, roots,
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
        if (sourceHighlight && !(translatorKey === 'cambridge' && !CONFIG.enableCambridge)) return refineSelection(snapshot);
        const rect = bookmark.range.getBoundingClientRect();

        if (!sourceHighlight) cleanupPanels();
        const targetPanel = createTranslatorPanel({translatorKey});
        targetPanel.selectionBookmark = bookmark;
        document.body.appendChild(targetPanel);
        utils.showPanel(rect, targetPanel);
        await translate(snapshot.queryText, targetPanel);
    }, CONFIG.triggerDelay);

    const eventHandlers = {
        handleMouseDown(e) {
            const target = e.composedPath()[0];
            cancelSelection();
            state.selectionGesture = e.button === 0 ? {
                startedAt: e.timeStamp, x: e.clientX, y: e.clientY, clickCount: e.detail,
                startedInPanel: utils.isClickInPanel(e), startedInEditable: utils.isEditableTarget(target),
                roots: e.composedPath().filter(node => node instanceof ShadowRoot && node.mode === 'open'),
                sourceHighlight: highlightAtPoint(e.clientX, e.clientY, target)
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
                utils.hideUnpinned();
                state.isRightClickPending = false;
                cancelSelection();
                return;
            }
            if (e.button === 2) {
                state.isRightClickPending = false;
                return;
            }
            if (utils.isClickInPanel(e) || gesture?.startedInEditable || utils.isEditableTarget(e.composedPath()[0])) {
                cancelSelection();
                return;
            }
            if (e.button !== 0 || !gesture || gesture.startedInPanel || gesture.clickCount >= 3) return;
            const doubleClick = gesture.clickCount === 2;
            const heldMs = e.timeStamp - gesture.startedAt;
            const moved = Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y);
            if (!doubleClick && (heldMs < CONFIG.selectionMinHoldMs || moved < CONFIG.selectionMinDistance)) return;
            const roots = [...new Set([...gesture.roots,
                ...e.composedPath().filter(node => node instanceof ShadowRoot && node.mode === 'open')])];
            const snapshot = captureTranslationSelection(roots);
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
            utils.hideUnpinned();
        }
    };

    on(window, 'blur', () => {
        cancelSelection();
        state.selectionGesture = null;
    });

    on(document, 'mousedown', eventHandlers.handleMouseDown, {capture: true, passive: false});
    on(document, 'mouseup', eventHandlers.handleMouseUp, {capture: true, passive: false});
    on(document, 'click', eventHandlers.handleOutsideClick, {capture: true, passive: false});
    on(document, 'contextmenu', e => {
        if (!(e.target instanceof Element) || !e.target.closest('.translator-panel')) {
            state.isRightClickPending = true;
        }
    }, {passive: false});

    // 共用命中与过渡入口，每帧最多测量一次文字矩形。
    let hoverFrame = null;
    let hoverPoint = null;
    on(document, 'mousemove', e => {
        if (!highlightStore.size) return;
        hoverPoint = {x: e.clientX, y: e.clientY, target: e.composedPath()[0], buttons: e.buttons};
        if (hoverFrame !== null) return;
        hoverFrame = requestAnimationFrame(() => {
            hoverFrame = null;
            const {x, y, target, buttons} = hoverPoint;
            if (!buttons && !dragState && !state.selectionGesture) updateHoverTarget(x, y, target);
        });
    }, {passive: true});
    on(document, 'mouseleave', () => {
        hoverHighlights?.clear();
        scheduleHideHover();
    });

    // 失效高亮在用户下次操作词表/选词时清理，不后台监听页面内容变化。

    function refreshOpenDropdowns() {
        panels().forEach(panel => panel.refreshDropdown?.());
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

        on(targetPanel, 'click', e => {
            if (!e.target.closest('.title-wrapper') && targetPanel.isDropdownOpen) toggleDropdown(false);
        });

        on(titleWrapper, 'click', e => {
            utils.stopEvent(e);
            toggleDropdown(!targetPanel.isDropdownOpen);
        });

        on(dropdownMenu, 'click', e => {
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

        on(targetPanel, 'mouseenter', () => clearTimeout(targetPanel.dropdownCloseTimer));
        on(targetPanel, 'mouseleave', () => {
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
    on(document, 'mousemove', e => {
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
        // toggle 不冒泡；只调整本面板位置，不触发查询。
        targetPanel.addEventListener('toggle', e => {
            if (e.target.matches('.source-preview')) utils.fitPanelToViewport(targetPanel);
        }, true);
        setupTranslatorSwitch(targetPanel);
        updateThemeButton(targetPanel.querySelector('.theme-button'), utils.isDarkMode());
        updatePinButton(targetPanel.querySelector('.pin-button'), targetPanel.classList.contains('pinned'));

        // 面板按钮共用事件入口，动作类保留各自的职责。
        on(targetPanel, 'click', e => {
            const button = e.target.closest('.icon-button, .audio-button, .cambridge-open');
            if (!button) return;
            utils.stopEvent(e);
            cancelSelection();
            if (button.classList.contains('audio-button')) {
                state.isSelectingInPanel = false;
                if (button.dataset.url) audio.play(button.dataset.url);
            } else if (button.classList.contains('unhighlight-button')) {
                removeHighlight(targetPanel.highlightRange);
            } else if (button.classList.contains('external-button') || button.classList.contains('cambridge-open')) {
                const url = EXTERNAL_URLS[targetPanel.translatorKey];
                if (url && targetPanel.translationText) window.open(url + encodeURIComponent(targetPanel.translationText), '_blank', 'noopener,noreferrer');
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
                panels().forEach(panel => utils.hidePanel(panel, true));
                wordbookPanel = null;
                dragState?.panel.classList.remove('dragging');
                dragState = null;
                resetPanelSelection();
                state.isRightClickPending = false;
                state.selectionGesture = null;
            }
        });

        on(targetPanel, 'mousedown', e => {
            const inContent = e.target.closest('.content');
            if (inContent && !e.target.closest('button, summary')) {
                if (e.detail < 3) {
                    state.isSelectingInPanel = true;
                    document.body.style.userSelect = 'none';
                    e.stopPropagation();
                }
                return;
            }
            beginPanelDrag(e, targetPanel);
        });

        on(targetPanel, 'mousemove', e => {
            if (state.isSelectingInPanel) e.stopPropagation();
        });

        on(targetPanel, 'contextmenu', e => {
            const selection = window.getSelection();
            if (selection?.isCollapsed || !e.target.closest('.content')) {
                utils.stopEvent(e);
                utils.hideUnpinned();
            }
        });
    }

    // 浏览器窗口尺寸变化时，重新限制所有翻译窗口的高度和位置。
    on(window, 'resize', utils.debounce(() => {
        floatingPanels().forEach(panel => utils.fitPanelToViewport(panel));
    }, 100));

    // 页面滚动后，仅在窗口完全离开视口时将其拉回可见区域。
    let scrollTimer = null;
    on(window, 'scroll', () => {
        if (scrollTimer) return;
        scrollTimer = setTimeout(() => {
            scrollTimer = null;
            floatingPanels().forEach(panel => {
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
    eventHandlers.handleMouseDown(firstEvent);
    }
})();
