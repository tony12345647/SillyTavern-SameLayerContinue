/**
 * 同層續寫 (Same-Layer Continue) for SillyTavern
 *
 * 目的：模型回應被網路中斷／截斷時，直接在「同一層訊息」上接著寫下去，
 *      不新增訊息層、不新增 swipe。底層一律走 SillyTavern 內建的 continue 機制。
 */

import { extension_settings, getContext } from '../../../extensions.js';

const MODULE_NAME = 'sameLayerContinue';
const LOG = '[同層續寫]';

/** 從自己的檔案位置推回擴充資料夾名稱，不用寫死路徑。 */
const EXT_URL = new URL('.', import.meta.url);
const EXT_NAME = decodeURIComponent(EXT_URL.pathname.replace(/\/+$/, '').split('/').pop() || '');

const defaultSettings = {
    enabled: true,

    // 自動偵測
    autoDetect: true,
    autoAction: 'toast',      // 'toast' = 跳提示讓我按 | 'auto' = 直接自動續寫 | 'none' = 只記錄不動作
    maxAutoRetries: 2,        // 同一層最多自動續寫幾次

    // 偵測規則
    detectPunctuation: true,  // 結尾沒有句末標點
    detectUnclosed: true,     // 引號／括號／星號未閉合
    detectCodeBlock: true,    // ``` 未閉合
    minLength: 1,             // 訊息短於這個字數就不判斷（0 = 都判斷）

    // 注入（決定「已寫好的那半段」怎麼送進去）
    forcePrefill: true,       // 強制把已寫內容當 assistant prefill 送出
    joinMode: 'none',         // 'default'=沿用ST | 'none' | 'space' | 'newline' | 'double'
    customNudge: '',          // 自訂續寫指示，空白 = 用 ST 預設

    // 行為
    // 續寫用的模型
    switchTarget: 'none',     // 'none' | 'profile' = 換連線設定檔 | 'model' = 只換模型
    profileName: '',          // 設定檔名稱
    modelSelectId: '',        // 模型下拉選單的 DOM id（不同 API 不一樣）
    modelValue: '',           // 模型值
    profileWaitMs: 800,       // 切換後等多久再送出，讓連線穩定

    // 續寫前清理
    stripEnabled: true,       // 啟用刪詞
    stripList: [],            // [{ t: '字詞或 /regex/flags', on: true }]
    stripTerms: '',           // 舊版格式，載入時自動轉成 stripList
    stripScope: 'all',        // 'all' = 整篇 | 'tail' = 只處理結尾
    stripTailChars: 300,      // scope=tail 時處理最後幾個字

    trimTrailing: true,       // 續寫前先去掉結尾多餘空白
    syncSwipe: true,          // 續寫後把結果同步回目前的 swipe
    showWandButton: true,     // 在魔杖選單顯示按鈕
    checkUpdateOnStart: true, // 啟動時檢查有沒有新版
    debug: false,
};

let autoRetryCount = 0;
let busy = false;

/** ST 的設定物件，啟動時動態載入；載不到就只是不做覆寫。 */
let powerUser = null;
let oaiSettings = null;

const JOIN_MAP = {
    none: '',
    space: ' ',
    newline: '\n',
    double: '\n\n',
};

/* ------------------------------------------------------------------ */
/* 設定                                                                */
/* ------------------------------------------------------------------ */

function settings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE_NAME][k] === undefined) {
            extension_settings[MODULE_NAME][k] = v;
        }
    }
    const conf = extension_settings[MODULE_NAME];

    // 舊版的多行文字框 → 新版清單，轉一次就好
    if (typeof conf.stripTerms === 'string' && conf.stripTerms.trim() && !conf.stripList?.length) {
        conf.stripList = conf.stripTerms
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'))
            .map(t => ({ t, on: true }));
        conf.stripTerms = '';
    }
    if (!Array.isArray(conf.stripList)) conf.stripList = [];

    // 舊版的 useProfile 布林 → switchTarget
    if (typeof conf.useProfile === 'boolean') {
        if (conf.useProfile && conf.switchTarget === 'none') conf.switchTarget = 'profile';
        delete conf.useProfile;
    }

    return conf;
}

function saveSettings() {
    getContext().saveSettingsDebounced?.();
}

function debug(...args) {
    if (settings().debug) console.log(LOG, ...args);
}

/* ------------------------------------------------------------------ */
/* 截斷偵測                                                             */
/* ------------------------------------------------------------------ */

const TERMINALS = /[。．.!！?？…⋯~～\u3002\uff01\uff1f]$/u;
const TRAILING_CLOSERS = /[*_`~"'」』）)\]】》＞>\s]+$/u;

function countOf(text, ch) {
    let n = 0;
    for (const c of text) if (c === ch) n++;
    return n;
}

/**
 * 判斷一段文字看起來是不是被切斷的。
 * @returns {{truncated: boolean, reasons: string[]}}
 */
function analyzeTail(text) {
    const s = settings();
    const reasons = [];
    const raw = (text ?? '').replace(/\s+$/u, '');

    if (!raw) return { truncated: true, reasons: ['訊息是空的'] };
    if (s.minLength > 0 && raw.length < s.minLength) {
        return { truncated: false, reasons: [] };
    }

    if (s.detectCodeBlock && (raw.match(/```/g)?.length ?? 0) % 2 === 1) {
        reasons.push('程式碼區塊沒有閉合');
    }

    if (s.detectUnclosed) {
        const pairs = [['「', '」'], ['『', '』'], ['（', '）'], ['(', ')'], ['《', '》'], ['【', '】'], ['“', '”']];
        for (const [open, close] of pairs) {
            if (countOf(raw, open) > countOf(raw, close)) {
                reasons.push(`${open}${close} 沒有閉合`);
                break;
            }
        }
        if (countOf(raw, '"') % 2 === 1) reasons.push('雙引號沒有閉合');
        // 忽略 **粗體**：把成對的 ** 先移掉再數單顆 *
        const stars = raw.replace(/\*\*/g, '');
        if (countOf(stars, '*') % 2 === 1) reasons.push('星號沒有閉合');
    }

    if (s.detectPunctuation) {
        const stripped = raw.replace(TRAILING_CLOSERS, '');
        if (stripped && !TERMINALS.test(stripped)) {
            const last = stripped.slice(-1);
            if (/[,，、;；:：\-—]/u.test(last)) {
                reasons.push('結尾停在逗號／頓號');
            } else {
                reasons.push('結尾沒有句末標點');
            }
        }
    }

    return { truncated: reasons.length > 0, reasons };
}


/* ------------------------------------------------------------------ */
/* 續寫用的連線設定檔                                                    */
/* ------------------------------------------------------------------ */

/** 讀出所有連線設定檔的名稱。 */
async function getProfileNames() {
    const conf = extension_settings.connectionManager;
    if (Array.isArray(conf?.profiles) && conf.profiles.length) {
        return conf.profiles.map(p => p?.name).filter(Boolean);
    }
    // 備援：問斜線指令
    const ctx = getContext();
    try {
        const res = await ctx.executeSlashCommandsWithOptions?.('/profile-list', {
            handleParserErrors: true, showOutput: false,
        });
        const parsed = JSON.parse(res?.pipe ?? '[]');
        return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch (err) {
        debug('取不到設定檔清單', err);
        return [];
    }
}

/** 目前用的設定檔名稱。 */
async function getCurrentProfile() {
    const ctx = getContext();
    try {
        const res = await ctx.executeSlashCommandsWithOptions?.('/profile', {
            handleParserErrors: true, showOutput: false,
        });
        const name = String(res?.pipe ?? '').trim();
        return name && name !== 'undefined' ? name : null;
    } catch (err) {
        debug('取不到目前設定檔', err);
        return null;
    }
}

/**
 * 切到指定設定檔。
 * @returns {Promise<string|null>} 切換前的設定檔名稱；沒切換就回 null
 */
async function switchProfile(target) {
    const ctx = getContext();
    if (!target || typeof ctx.executeSlashCommandsWithOptions !== 'function') return null;

    const previous = await getCurrentProfile();
    if (previous === target) {
        debug('已經在目標設定檔，不切換');
        return null;
    }

    try {
        await ctx.executeSlashCommandsWithOptions(`/profile ${target}`, {
            handleParserErrors: true, showOutput: false,
        });
        const wait = Math.max(0, Number(settings().profileWaitMs) || 0);
        if (wait) await new Promise(r => setTimeout(r, wait));
        debug(`設定檔 ${previous ?? '(未知)'} → ${target}`);
        return previous;
    } catch (err) {
        console.error(LOG, '切換設定檔失敗', err);
        toastr.warning(`切換到「${target}」失敗，用目前的設定續寫`, '同層續寫');
        return null;
    }
}


/* ---- 直接換模型（讀 ST 各後端的模型下拉選單）---- */

/** 找出頁面上所有模型下拉選單。目前 API 的那個會是可見的。 */
function getModelSelects() {
    const found = [];
    $('select[id^="model_"], #openrouter_model, #horde_model').each(function () {
        const $s = $(this);
        const count = $s.find('option').length;
        if (!count) return;
        found.push({ id: this.id, visible: $s.is(':visible'), count });
    });
    // 可見的排前面
    found.sort((a, b) => Number(b.visible) - Number(a.visible) || b.count - a.count);
    return found;
}

/** 目前這個 API 在用的模型選單。 */
function activeModelSelect() {
    return getModelSelects()[0] ?? null;
}

/** 讀出某個選單裡的模型選項。 */
function getModelOptions(selectId) {
    if (!selectId) return [];
    return $(`#${selectId} option`).map(function () {
        const value = String(this.value ?? '');
        if (!value) return null;
        return { value, label: ($(this).text() || value).trim() };
    }).get().filter(Boolean);
}

/**
 * 換模型。
 * @returns {Promise<{id: string, value: string}|null>} 切換前的值，沒切換就 null
 */
async function switchModel(selectId, value) {
    if (!selectId || !value) return null;
    const $sel = $(`#${selectId}`);
    if (!$sel.length) {
        toastr.warning('找不到模型選單，可能 API 換了。到設定裡重新讀取模型清單。', '同層續寫');
        return null;
    }
    const previous = String($sel.val() ?? '');
    if (previous === value) {
        debug('已經是目標模型，不切換');
        return null;
    }
    $sel.val(value).trigger('change');
    const wait = Math.max(0, Number(settings().profileWaitMs) || 0);
    if (wait) await new Promise(r => setTimeout(r, wait));
    debug(`模型 ${previous || '(空)'} → ${value}`);
    return { id: selectId, value: previous };
}

/* ------------------------------------------------------------------ */
/* 續寫前清理                                                           */
/* ------------------------------------------------------------------ */

/** 目前生效的字詞（跳過關掉的和空白的）。 */
function activeTerms() {
    const list = settings().stripList;
    return (Array.isArray(list) ? list : [])
        .filter(e => e && e.on !== false)
        .map(e => String(e.t ?? '').trim())
        .filter(Boolean);
}

/** 把清單解析成 RegExp 陣列。純文字自動跳脫，/pattern/flags 當正規表達式。 */
function parseStripTerms() {
    const patterns = [];
    for (const t of activeTerms()) {
        const asRegex = t.match(/^\/(.+)\/([gimsuy]*)$/);
        try {
            if (asRegex) {
                const flags = asRegex[2].includes('g') ? asRegex[2] : asRegex[2] + 'g';
                patterns.push(new RegExp(asRegex[1], flags));
            } else {
                patterns.push(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
            }
        } catch (err) {
            debug('略過無效規則：', t, err);
        }
    }
    return patterns;
}

function runPatterns(text, patterns) {
    let out = text;
    let count = 0;
    for (const re of patterns) {
        re.lastIndex = 0;
        const hits = out.match(re);
        if (hits?.length) {
            count += hits.length;
            out = out.replace(re, '');
        }
    }
    return { out, count };
}

/**
 * 對一段文字套用刪除清單。
 * @returns {{text: string, count: number}}
 */
function stripFromText(text) {
    const s = settings();
    const patterns = parseStripTerms();
    if (!patterns.length || typeof text !== 'string') return { text, count: 0 };

    if (s.stripScope === 'tail') {
        const n = Math.max(1, Number(s.stripTailChars) || 300);
        const cut = Math.max(0, text.length - n);
        const head = text.slice(0, cut);
        const { out, count } = runPatterns(text.slice(cut), patterns);
        return { text: head + out, count };
    }

    const { out, count } = runPatterns(text, patterns);
    return { text: out, count };
}

/** 把 DOM 上那則訊息重畫，讓刪除結果立刻看得到。 */
function refreshMessageBlock(idx, mes) {
    const ctx = getContext();
    try {
        if (typeof ctx.updateMessageBlock === 'function') {
            ctx.updateMessageBlock(idx, mes);
            return;
        }
    } catch (err) {
        debug('updateMessageBlock 失敗', err);
    }
    const $block = $(`#chat .mes[mesid="${idx}"] .mes_text`);
    if ($block.length && typeof ctx.messageFormatting === 'function') {
        $block.html(ctx.messageFormatting(mes.mes, mes.name, mes.is_system, mes.is_user, idx));
    }
}

/**
 * 續寫前把刪除清單套到最後一層訊息上。
 *
 * 這是暫時的：訊息先被改成刪除後的版本送去續寫，生成結束由 finalizeStrip()
 * 把原文接回來，聊天記錄看起來沒被動過，AI 卻沒看到那些字。
 *
 * @returns {{applied: boolean, count: number, original: string|null, sent: string|null}}
 */
function prepareStrip() {
    const s = settings();
    const none = { applied: false, count: 0, original: null, sent: null };
    if (!s.stripEnabled) return none;

    const item = lastAiMessage();
    if (!item) return none;

    const { idx, mes } = item;
    const original = mes.mes;
    const { text, count } = stripFromText(original);
    if (!count || text === original) return none;

    mes.mes = text;
    if (Array.isArray(mes.swipes) && Number.isInteger(mes.swipe_id)) {
        mes.swipes[mes.swipe_id] = text;
    }
    debug(`送出前移除 ${count} 處`);
    return { applied: true, count, original, sent: text, idx };
}

/**
 * 生成結束後把原文接回去，只保留 AI 新寫的那一段。
 */
function finalizeStrip(state) {
    if (!state?.applied) return;

    const item = lastAiMessage();
    if (!item) return;
    const { idx, mes } = item;

    // 續寫是往後append，所以現在的內容應該以送出去的那份為開頭
    const sentAfterTrim = state.sentTrimmed ?? state.sent;
    let addition = null;
    if (typeof mes.mes === 'string') {
        if (mes.mes.startsWith(sentAfterTrim)) {
            addition = mes.mes.slice(sentAfterTrim.length);
        } else if (mes.mes.startsWith(state.sent)) {
            addition = mes.mes.slice(state.sent.length);
        }
    }

    if (addition === null) {
        toastr.warning('接不回原文（內容和送出時對不上），被刪掉的字暫時留在訊息裡。按「還原原文」可以救回來。', '同層續寫');
        mes.extra = mes.extra || {};
        mes.extra.slc_backup = state.original;
        debug('finalizeStrip 對不上，保留刪除後版本');
        return;
    }

    mes.mes = state.original + addition;
    if (Array.isArray(mes.swipes) && Number.isInteger(mes.swipe_id)) {
        mes.swipes[mes.swipe_id] = mes.mes;
    }
    refreshMessageBlock(idx, mes);
    debug(`已接回原文，新增 ${addition.length} 字`);
}

/** 還原原文（接不回去時的救援）。 */
function restoreLastStrip() {
    const item = lastAiMessage();
    if (!item) {
        toastr.warning('最後一則不是角色訊息');
        return;
    }
    const { idx, mes } = item;
    const backup = mes.extra?.slc_backup;
    if (typeof backup !== 'string') {
        toastr.warning('這則訊息沒有備份可以還原');
        return;
    }
    mes.mes = backup;
    if (Array.isArray(mes.swipes) && Number.isInteger(mes.swipe_id)) {
        mes.swipes[mes.swipe_id] = backup;
    }
    delete mes.extra.slc_backup;
    refreshMessageBlock(idx, mes);
    const ctx = getContext();
    (ctx.saveChatConditional ?? ctx.saveChat)?.();
    toastr.success('已還原原文', '同層續寫');
}

/* ------------------------------------------------------------------ */
/* 續寫本體                                                             */
/* ------------------------------------------------------------------ */

/**
 * 暫時覆寫 ST 的續寫相關設定，讓「已寫好的那半段」以我們要的方式送進去。
 * 回傳一個還原函式，續寫結束後一定要呼叫。
 */
function applyPromptOverrides() {
    const s = settings();
    const undo = [];

    const setIfPresent = (obj, key, value) => {
        if (!obj || !(key in obj)) return false;
        const old = obj[key];
        if (old === value) return true;
        obj[key] = value;
        undo.push(() => { obj[key] = old; });
        return true;
    };

    if (s.forcePrefill) {
        // 把目前這層已有的內容當成 assistant 的開頭送出，
        // 模型看到的是「文章本體」而不是一句「請繼續」。
        const okA = setIfPresent(oaiSettings, 'continue_prefill', true);
        const okB = setIfPresent(powerUser, 'continue_prefill', true);
        debug('prefill 覆寫', { oai: okA, power: okB });
    }

    if (s.joinMode !== 'default') {
        const postfix = JOIN_MAP[s.joinMode] ?? '';
        setIfPresent(powerUser, 'continue_postfix', postfix);
        setIfPresent(oaiSettings, 'continue_postfix', postfix);
        debug('接縫覆寫為', JSON.stringify(postfix));
    }

    const nudge = String(s.customNudge ?? '').trim();
    if (nudge) {
        setIfPresent(oaiSettings, 'continue_nudge_prompt', nudge);
        setIfPresent(powerUser, 'continue_nudge_prompt', nudge);
        debug('續寫指示覆寫');
    }

    return () => {
        while (undo.length) undo.pop()();
        debug('已還原 ST 設定');
    };
}

/** 等待這次生成真的結束（給不會 await 的 fallback 路徑用）。 */
function waitForGenerationEnd(timeoutMs = 180000) {
    const ctx = getContext();
    const es = ctx.eventSource;
    const et = ctx.eventTypes ?? {};
    if (!es || !et.GENERATION_ENDED) return new Promise(r => setTimeout(r, 2000));

    return new Promise(resolve => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            es.removeListener?.(et.GENERATION_ENDED, finish);
            if (et.GENERATION_STOPPED) es.removeListener?.(et.GENERATION_STOPPED, finish);
            resolve();
        };
        es.once ? es.once(et.GENERATION_ENDED, finish) : es.on(et.GENERATION_ENDED, finish);
        if (et.GENERATION_STOPPED) es.on(et.GENERATION_STOPPED, finish);
        setTimeout(finish, timeoutMs);
    });
}

function lastAiMessage() {
    const ctx = getContext();
    const chat = ctx.chat;
    if (!Array.isArray(chat) || chat.length === 0) return null;
    const idx = chat.length - 1;
    const mes = chat[idx];
    if (!mes || mes.is_user || mes.is_system) return null;
    return { idx, mes };
}

/** 呼叫 SillyTavern 內建的 continue，逐層 fallback。 */
async function invokeNativeContinue() {
    const ctx = getContext();

    if (typeof ctx.executeSlashCommandsWithOptions === 'function') {
        debug('使用 executeSlashCommandsWithOptions');
        await ctx.executeSlashCommandsWithOptions('/continue', { handleParserErrors: true, showOutput: false });
        return true;
    }
    if (typeof ctx.executeSlashCommands === 'function') {
        debug('使用 executeSlashCommands');
        await ctx.executeSlashCommands('/continue');
        return true;
    }
    if (typeof ctx.generate === 'function') {
        debug('使用 ctx.generate("continue")');
        await ctx.generate('continue');
        return true;
    }
    const $btn = $('#option_continue');
    if ($btn.length) {
        debug('使用 #option_continue 按鈕');
        $btn.trigger('click');
        return false;
    }
    throw new Error('這個 SillyTavern 版本找不到可用的 continue 介面');
}

/** 續寫後把結果寫回目前的 swipe，避免切 swipe 時內容跑掉。 */
function syncSwipeText() {
    if (!settings().syncSwipe) return;
    const ctx = getContext();
    const item = lastAiMessage();
    if (!item) return;
    const { mes } = item;
    if (Array.isArray(mes.swipes) && Number.isInteger(mes.swipe_id) && mes.swipes[mes.swipe_id] !== mes.mes) {
        mes.swipes[mes.swipe_id] = mes.mes;
        debug('已同步 swipe 內容');
        (ctx.saveChatConditional ?? ctx.saveChat)?.();
    }
}

/**
 * 對最後一層 AI 訊息續寫。
 * @param {{source?: string, silent?: boolean}} opts
 */
async function continueSameLayer({ source = 'manual', silent = false } = {}) {
    const s = settings();
    if (!s.enabled) return false;

    if (busy) {
        if (!silent) toastr.info('續寫進行中，請等它跑完');
        return false;
    }

    const ctx = getContext();
    const item = lastAiMessage();
    if (!item) {
        if (!silent) toastr.warning('最後一則不是角色訊息，沒辦法同層續寫');
        return false;
    }

    if (ctx.onlineStatus === 'no_connection') {
        if (!silent) toastr.error('目前沒有連上 API，先確認連線再續寫');
        return false;
    }

    const { mes } = item;

    const stripState = prepareStrip();

    if (s.trimTrailing && typeof mes.mes === 'string') {
        const trimmed = mes.mes.replace(/\s+$/u, '');
        if (trimmed !== mes.mes) {
            mes.mes = trimmed;
            debug('已去掉結尾空白');
        }
    }
    if (stripState.applied) stripState.sentTrimmed = mes.mes;

    busy = true;
    const restore = applyPromptOverrides();
    let previousProfile = null;
    let previousModel = null;
    try {
        if (s.switchTarget === 'profile' && s.profileName) {
            previousProfile = await switchProfile(s.profileName);
        } else if (s.switchTarget === 'model' && s.modelValue) {
            previousModel = await switchModel(s.modelSelectId, s.modelValue);
        }
        debug(`開始續寫（來源：${source}），目前長度 ${mes.mes?.length ?? 0}`);
        const awaited = await invokeNativeContinue();
        if (!awaited) await waitForGenerationEnd();
        finalizeStrip(stripState);
        syncSwipeText();
        return true;
    } catch (err) {
        console.error(LOG, err);
        // 生成失敗時，prompt 模式要把原文放回去，不能留下被刪過的版本
        if (stripState.applied) {
            const item2 = lastAiMessage();
            if (item2 && item2.mes.mes === (stripState.sentTrimmed ?? stripState.sent)) {
                item2.mes.mes = stripState.original;
                if (Array.isArray(item2.mes.swipes) && Number.isInteger(item2.mes.swipe_id)) {
                    item2.mes.swipes[item2.mes.swipe_id] = stripState.original;
                }
                refreshMessageBlock(item2.idx, item2.mes);
                debug('生成失敗，已還原原文');
            }
        }
        if (!silent) toastr.error(String(err?.message ?? err), '續寫失敗');
        return false;
    } finally {
        restore();
        if (previousProfile) {
            await switchProfile(previousProfile);
        }
        if (previousModel) {
            await switchModel(previousModel.id, previousModel.value);
        }
        busy = false;
    }
}

/* ------------------------------------------------------------------ */
/* 自動偵測流程                                                         */
/* ------------------------------------------------------------------ */

function offerContinue(reasons) {
    const text = `偵測到訊息可能被截斷（${reasons.join('、')}）。點這裡在同一層繼續寫。`;
    const t = toastr.warning(text, '要續寫嗎？', {
        timeOut: 15000,
        extendedTimeOut: 15000,
        closeButton: true,
        tapToDismiss: false,
        onclick: () => continueSameLayer({ source: 'toast' }),
    });
    return t;
}

async function onGenerationEnded() {
    const s = settings();
    if (!s.enabled || !s.autoDetect || busy) return;
    if (s.autoAction === 'none') return;

    // 等 ST 把訊息寫回 chat 陣列
    await new Promise(r => setTimeout(r, 250));

    const item = lastAiMessage();
    if (!item) return;

    const { truncated, reasons } = analyzeTail(item.mes.mes);
    debug('偵測結果', truncated, reasons);
    if (!truncated) {
        autoRetryCount = 0;
        return;
    }

    if (s.autoAction === 'toast') {
        offerContinue(reasons);
        return;
    }

    if (s.autoAction === 'auto') {
        if (autoRetryCount >= s.maxAutoRetries) {
            toastr.warning(`已自動續寫 ${autoRetryCount} 次，還是判定被截斷，先停下來讓你看看。`, '同層續寫');
            return;
        }
        autoRetryCount++;
        toastr.info(`偵測到截斷（${reasons.join('、')}），自動續寫第 ${autoRetryCount} 次…`, '同層續寫', { timeOut: 4000 });
        await continueSameLayer({ source: 'auto', silent: true });
    }
}

function onMessageSent() {
    autoRetryCount = 0;
}

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 更新                                                                 */
/* ------------------------------------------------------------------ */

let cachedVersionInfo = null;

async function postExtensionApi(path, extraBody = {}) {
    const ctx = getContext();
    const headers = ctx.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' };

    // 新版 ST 需要 global 旗標，舊版沒有。兩種都試。
    for (const global of [false, true, undefined]) {
        const body = { extensionName: EXT_NAME, ...extraBody };
        if (global !== undefined) body.global = global;
        try {
            const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
            if (res.ok) return await res.json();
            debug(`${path} global=${global} 回應 ${res.status}`);
        } catch (err) {
            debug(`${path} global=${global} 失敗`, err);
        }
    }
    return null;
}

/** 讀本機這份擴充的 manifest 版本號。 */
async function localVersion() {
    try {
        const res = await fetch(new URL('manifest.json', EXT_URL).href, { cache: 'no-store' });
        const json = await res.json();
        return { version: json.version, homePage: json.homePage };
    } catch (err) {
        debug('讀不到本機 manifest', err);
        return { version: null, homePage: null };
    }
}

/** 備援：直接去 GitHub 抓遠端 manifest 比版本號。 */
async function remoteManifestVersion(homePage) {
    const m = String(homePage ?? '').match(/github\.com\/([^/]+)\/([^/#?]+)/i);
    if (!m) return null;
    const [, owner, repo] = m;
    for (const branch of ['main', 'master']) {
        try {
            const url = `https://raw.githubusercontent.com/${owner}/${repo.replace(/\.git$/, '')}/${branch}/manifest.json`;
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) continue;
            const json = await res.json();
            if (json?.version) return json.version;
        } catch (err) {
            debug('遠端 manifest 抓取失敗', branch, err);
        }
    }
    return null;
}

/**
 * 檢查更新。
 * @returns {Promise<{hasUpdate: boolean, local: string|null, detail: string}>}
 */
async function checkForUpdate({ silent = false } = {}) {
    const { version: local, homePage } = await localVersion();

    // 主要路徑：問 ST 自己的 git 狀態，最準
    const info = await postExtensionApi('/api/extensions/version');
    if (info && typeof info.isUpToDate === 'boolean') {
        cachedVersionInfo = info;
        const hasUpdate = !info.isUpToDate;
        const detail = hasUpdate
            ? `有新的 commit 可以拉（目前 ${String(info.currentCommitHash ?? '').slice(0, 7) || '未知'}）`
            : `已是最新（${String(info.currentCommitHash ?? '').slice(0, 7) || '未知'}）`;
        if (!silent) toastr[hasUpdate ? 'info' : 'success'](detail, '同層續寫');
        return { hasUpdate, local, detail };
    }

    // 備援路徑：比 manifest 版本號
    const remote = await remoteManifestVersion(homePage);
    if (remote && local) {
        const hasUpdate = remote !== local;
        const detail = hasUpdate ? `遠端是 ${remote}，本機是 ${local}` : `已是最新（${local}）`;
        if (!silent) toastr[hasUpdate ? 'info' : 'success'](detail, '同層續寫');
        return { hasUpdate, local, detail };
    }

    const detail = '查不到版本資訊，可能是手動安裝（沒有 git）或 manifest 的 homePage 沒填對';
    if (!silent) toastr.warning(detail, '同層續寫');
    return { hasUpdate: false, local, detail };
}

/** 觸發 ST 更新這個擴充（等同 git pull），完成後請使用者重整。 */
async function runUpdate() {
    const $btn = $('#slc_update');
    $btn.prop('disabled', true).val('更新中…');
    try {
        const result = await postExtensionApi('/api/extensions/update');
        if (!result) {
            toastr.error('ST 的更新介面沒有回應。手動安裝的擴充沒有 git 記錄，無法自動更新。', '更新失敗');
            return;
        }
        if (result.isUpToDate) {
            toastr.success('已經是最新版，沒有東西要拉。', '同層續寫');
            return;
        }
        const hash = String(result.shortCommitHash ?? '').slice(0, 7);
        toastr.success(`已更新到 ${hash || '最新版'}。點這裡重新整理頁面套用。`, '更新完成', {
            timeOut: 0,
            extendedTimeOut: 0,
            tapToDismiss: false,
            onclick: () => location.reload(),
        });
    } catch (err) {
        console.error(LOG, err);
        toastr.error(String(err?.message ?? err), '更新失敗');
    } finally {
        $btn.prop('disabled', false).val('立即更新');
    }
}

async function renderVersionLine() {
    const { version } = await localVersion();
    $('#slc_version').text(version ? `v${version}` : '版本未知');
}

const WAND_BUTTON_HTML = `
<div id="slc_wand_button" class="list-group-item flex-container flexGap5 interactable" tabindex="0" title="在同一層訊息上繼續寫，不新增訊息層">
    <div class="fa-solid fa-forward-step extensionsMenuExtensionButton"></div>
    <span>續寫本層</span>
</div>`;

const SETTINGS_HTML = `
<div class="same-layer-continue-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>同層續寫 (Same-Layer Continue)</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <small class="slc_hint">回應被網路切斷時，接著同一層繼續寫，不會新增訊息層或 swipe。</small>

            <label class="checkbox_label" for="slc_enabled">
                <input id="slc_enabled" type="checkbox"><span>啟用擴充</span>
            </label>
            <label class="checkbox_label" for="slc_showWandButton">
                <input id="slc_showWandButton" type="checkbox"><span>在魔杖選單顯示「續寫本層」</span>
            </label>

            <hr class="sysHR">
            <h4>自動偵測</h4>
            <label class="checkbox_label" for="slc_autoDetect">
                <input id="slc_autoDetect" type="checkbox"><span>回應結束後自動檢查是否被截斷</span>
            </label>

            <label for="slc_autoAction">偵測到截斷時</label>
            <select id="slc_autoAction" class="text_pole">
                <option value="toast">跳提示，我自己決定要不要續寫</option>
                <option value="auto">直接自動續寫</option>
                <option value="none">什麼都不做（只記在主控台）</option>
            </select>

            <label for="slc_maxAutoRetries">同一層最多自動續寫次數</label>
            <input id="slc_maxAutoRetries" class="text_pole" type="number" min="1" max="10" step="1">

            <hr class="sysHR">
            <h4>判定規則</h4>
            <label class="checkbox_label" for="slc_detectPunctuation">
                <input id="slc_detectPunctuation" type="checkbox"><span>結尾沒有句末標點</span>
            </label>
            <label class="checkbox_label" for="slc_detectUnclosed">
                <input id="slc_detectUnclosed" type="checkbox"><span>引號／括號／星號沒有閉合</span>
            </label>
            <label class="checkbox_label" for="slc_detectCodeBlock">
                <input id="slc_detectCodeBlock" type="checkbox"><span>程式碼區塊沒有閉合</span>
            </label>
            <label for="slc_minLength">短於這個字數就不判斷</label>
            <input id="slc_minLength" class="text_pole" type="number" min="0" max="500" step="1">

            <hr class="sysHR">
            <h4>注入內容</h4>
            <small class="slc_hint">preset、世界書、角色卡、作者註記、深度注入都由 ST 原生流程重跑一次，跟你手動按 Continue 完全一致。下面控制的是「已寫好的那半段」怎麼送進去。</small>

            <label class="checkbox_label" for="slc_forcePrefill">
                <input id="slc_forcePrefill" type="checkbox"><span>把已寫好的內容當 prefill 送出（強烈建議開）</span>
            </label>

            <label for="slc_joinMode">接縫處插入什麼</label>
            <select id="slc_joinMode" class="text_pole">
                <option value="none">不插入任何字元（中文用這個）</option>
                <option value="space">一個空白（英文用）</option>
                <option value="newline">換行</option>
                <option value="double">兩個換行</option>
                <option value="default">沿用 ST 原本設定</option>
            </select>

            <label for="slc_customNudge">自訂續寫指示（留空 = 用 ST 預設）</label>
            <textarea id="slc_customNudge" class="text_pole textarea_compact" rows="3" placeholder="例：[接續上文繼續寫下去，不要重複已寫過的內容，不要重新開場。]"></textarea>

            <hr class="sysHR">
            <h4>續寫用的模型</h4>
            <small class="slc_hint">續寫時切換到指定的連線設定檔（API＋模型＋預設集），跑完自動切回原本的。需要先在 ST 的「連線設定檔」裡建好設定檔。</small>

            <label for="slc_switchTarget">續寫時</label>
            <select id="slc_switchTarget" class="text_pole">
                <option value="none">用目前的設定（不切換）</option>
                <option value="profile">切換連線設定檔（API＋模型＋預設集）</option>
                <option value="model">只換模型</option>
            </select>

            <div id="slc_profileRow">
                <div class="slc_list_head">
                    <span>要用的設定檔</span>
                    <div id="slc_profileRefresh" class="slc_add fa-solid fa-rotate" title="重新讀取設定檔清單"></div>
                </div>
                <select id="slc_profileName" class="text_pole"></select>
            </div>

            <div id="slc_modelRow">
                <div class="slc_list_head">
                    <span>要用的模型</span>
                    <div id="slc_modelRefresh" class="slc_add fa-solid fa-rotate" title="重新讀取模型清單"></div>
                </div>
                <select id="slc_modelSelectId" class="text_pole"></select>
                <select id="slc_modelValue" class="text_pole"></select>
                <small class="slc_hint">模型清單直接讀自 ST 目前連線的後端。換了 API 之後記得按重新讀取。</small>
            </div>

            <label for="slc_profileWaitMs">切換後等待毫秒數</label>
            <input id="slc_profileWaitMs" class="text_pole" type="number" min="0" max="10000" step="100">

            <hr class="sysHR">
            <h4>續寫前清理</h4>
            <small class="slc_hint">續寫之前把這些字詞從送給 AI 的內容裡拿掉，讓它看不到、往別的方向接著寫。聊天記錄裡的原文不會被改動。一行一條；用 /pattern/flags 可以寫正規表達式；# 開頭是註解。</small>

            <label class="checkbox_label" for="slc_stripEnabled">
                <input id="slc_stripEnabled" type="checkbox"><span>啟用清理</span>
            </label>

            <div class="slc_list_head">
                <span>要刪除的字詞</span>
                <div id="slc_stripAdd" class="slc_add fa-solid fa-plus" title="新增一條"></div>
            </div>
            <div id="slc_stripList" class="slc_term_list"></div>

            <label for="slc_stripScope">掃描範圍</label>
            <select id="slc_stripScope" class="text_pole">
                <option value="all">整篇訊息</option>
                <option value="tail">只處理結尾 N 字</option>
            </select>

            <label for="slc_stripTailChars">結尾範圍的字數</label>
            <input id="slc_stripTailChars" class="text_pole" type="number" min="10" max="5000" step="10">

            <div class="flex-container flexGap5">
                <input id="slc_stripPreview" class="menu_button" type="button" value="預覽送給 AI 的內容">
                <input id="slc_stripRestore" class="menu_button" type="button" value="還原原文">
            </div>
            <textarea id="slc_previewBox" class="text_pole textarea_compact" rows="5" readonly placeholder="按上面的預覽鍵，這裡會顯示刪除之後、實際要送給 AI 的那份內容。聊天記錄不會被改動。"></textarea>

            <hr class="sysHR">
            <h4>續寫行為</h4>
            <label class="checkbox_label" for="slc_trimTrailing">
                <input id="slc_trimTrailing" type="checkbox"><span>續寫前先去掉結尾多餘空白</span>
            </label>
            <label class="checkbox_label" for="slc_syncSwipe">
                <input id="slc_syncSwipe" type="checkbox"><span>續寫後把結果同步回目前的 swipe</span>
            </label>
            <label class="checkbox_label" for="slc_debug">
                <input id="slc_debug" type="checkbox"><span>在主控台輸出偵錯訊息</span>
            </label>

            <hr class="sysHR">
            <div class="flex-container flexGap5">
                <input id="slc_test" class="menu_button" type="button" value="測試偵測最後一則">
                <input id="slc_run" class="menu_button" type="button" value="立刻續寫本層">
            </div>

            <hr class="sysHR">
            <h4>更新 <small id="slc_version" class="slc_version"></small></h4>
            <label class="checkbox_label" for="slc_checkUpdateOnStart">
                <input id="slc_checkUpdateOnStart" type="checkbox"><span>啟動時自動檢查有沒有新版</span>
            </label>
            <div class="flex-container flexGap5">
                <input id="slc_check" class="menu_button" type="button" value="檢查更新">
                <input id="slc_update" class="menu_button" type="button" value="立即更新">
            </div>
            <small class="slc_hint">更新等同對擴充資料夾做一次 git pull，完成後需要重新整理頁面。手動安裝（沒有 git 記錄）的話只能重新下載覆蓋。</small>
        </div>
    </div>
</div>`;

function bindSettingsUI() {
    const s = settings();

    const checkboxes = [
        'enabled', 'showWandButton', 'autoDetect', 'detectPunctuation',
        'detectUnclosed', 'detectCodeBlock', 'trimTrailing', 'syncSwipe', 'debug',
        'forcePrefill', 'checkUpdateOnStart', 'stripEnabled',
    ];
    for (const key of checkboxes) {
        const $el = $(`#slc_${key}`);
        $el.prop('checked', !!s[key]);
        $el.on('change', function () {
            settings()[key] = !!$(this).prop('checked');
            saveSettings();
            if (key === 'showWandButton') refreshWandButton();
        });
    }

    $('#slc_autoAction').val(s.autoAction).on('change', function () {
        settings().autoAction = String($(this).val());
        saveSettings();
    });

    $('#slc_switchTarget').val(s.switchTarget).on('change', function () {
        settings().switchTarget = String($(this).val());
        saveSettings();
        updateSwitchRows();
        if (settings().switchTarget === 'model') renderModelSelects();
        if (settings().switchTarget === 'profile') renderProfileSelect();
    });

    $('#slc_modelSelectId').on('change', function () {
        settings().modelSelectId = String($(this).val());
        settings().modelValue = '';
        saveSettings();
        renderModelOptions();
    });

    $('#slc_modelValue').on('change', function () {
        settings().modelValue = String($(this).val());
        saveSettings();
    });

    $('#slc_modelRefresh').on('click', () => {
        renderModelSelects();
        toastr.info('已重新讀取模型清單', '同層續寫');
    });

    $('#slc_profileName').on('change', function () {
        settings().profileName = String($(this).val());
        saveSettings();
    });

    $('#slc_profileRefresh').on('click', () => renderProfileSelect());

    $('#slc_stripScope').val(s.stripScope).on('change', function () {
        settings().stripScope = String($(this).val());
        saveSettings();
    });

    $('#slc_joinMode').val(s.joinMode).on('change', function () {
        settings().joinMode = String($(this).val());
        saveSettings();
    });

    $('#slc_customNudge').val(s.customNudge).on('input', function () {
        settings().customNudge = String($(this).val());
        saveSettings();
    });

    for (const key of ['maxAutoRetries', 'minLength', 'stripTailChars', 'profileWaitMs']) {
        $(`#slc_${key}`).val(s[key]).on('input', function () {
            const v = Number($(this).val());
            if (Number.isFinite(v)) {
                settings()[key] = v;
                saveSettings();
            }
        });
    }

    $('#slc_test').on('click', () => {
        const item = lastAiMessage();
        if (!item) {
            toastr.warning('最後一則不是角色訊息');
            return;
        }
        const { truncated, reasons } = analyzeTail(item.mes.mes);
        if (truncated) {
            toastr.warning(reasons.join('、'), '判定為截斷');
        } else {
            toastr.success('看起來是完整的', '判定為完整');
        }
    });

    $('#slc_run').on('click', () => continueSameLayer({ source: 'settings' }));
    $('#slc_stripPreview').on('click', () => {
        const item = lastAiMessage();
        if (!item) {
            toastr.warning('最後一則不是角色訊息');
            return;
        }
        const { text, count } = stripFromText(item.mes.mes);
        $('#slc_previewBox').val(text);
        toastr.info(count ? `會移除 ${count} 處` : '沒有符合的字詞', '預覽');
    });
    $('#slc_stripRestore').on('click', () => restoreLastStrip());
    $('#slc_check').on('click', () => checkForUpdate({ silent: false }));
    $('#slc_update').on('click', () => runUpdate());
    renderVersionLine();
    renderStripList();
    bindStripList();
    renderProfileSelect();
    renderModelSelects();
    updateSwitchRows();
}

function renderModelSelects() {
    const s = settings();
    const $which = $('#slc_modelSelectId');
    if (!$which.length) return;

    const selects = getModelSelects();
    $which.empty();
    if (!selects.length) {
        $which.append($('<option value=""></option>').text('（找不到模型選單）'));
        $('#slc_modelValue').empty().append($('<option value=""></option>').text('（無）'));
        return;
    }

    for (const sel of selects) {
        const label = `${sel.id.replace(/^model_/, '').replace(/_select$/, '')}（${sel.count}）${sel.visible ? ' ←目前' : ''}`;
        $which.append($('<option></option>').attr('value', sel.id).text(label));
    }

    const chosen = selects.some(x => x.id === s.modelSelectId) ? s.modelSelectId : selects[0].id;
    $which.val(chosen);
    if (chosen !== s.modelSelectId) {
        s.modelSelectId = chosen;
        saveSettings();
    }
    renderModelOptions();
}

function renderModelOptions() {
    const s = settings();
    const $val = $('#slc_modelValue');
    if (!$val.length) return;

    const options = getModelOptions(s.modelSelectId);
    $val.empty();
    if (!options.length) {
        $val.append($('<option value=""></option>').text('（這個選單沒有選項）'));
        return;
    }
    $val.append($('<option value=""></option>').text('（不指定）'));
    for (const o of options) {
        $val.append($('<option></option>').attr('value', o.value).text(o.label));
    }
    if (s.modelValue && !options.some(o => o.value === s.modelValue)) {
        $val.append($('<option></option>').attr('value', s.modelValue).text(`${s.modelValue}（清單裡沒有）`));
    }
    $val.val(s.modelValue ?? '');
}

function updateSwitchRows() {
    const t = settings().switchTarget;
    $('#slc_profileRow').toggle(t === 'profile');
    $('#slc_modelRow').toggle(t === 'model');
}

async function renderProfileSelect() {
    const $sel = $('#slc_profileName');
    if (!$sel.length) return;
    const saved = settings().profileName;
    const names = await getProfileNames();

    $sel.empty();
    if (!names.length) {
        $sel.append($('<option value=""></option>').text('（找不到連線設定檔）'));
        return;
    }
    $sel.append($('<option value=""></option>').text('（不指定）'));
    for (const n of names) {
        $sel.append($('<option></option>').attr('value', n).text(n));
    }
    // 存的設定檔被刪掉時保留選項，避免看起來像被清空
    if (saved && !names.includes(saved)) {
        $sel.append($('<option></option>').attr('value', saved).text(`${saved}（已不存在）`));
    }
    $sel.val(saved ?? '');
}

function renderStripList() {
    const $list = $('#slc_stripList');
    if (!$list.length) return;
    $list.empty();

    const list = settings().stripList;
    if (!list.length) {
        $list.append($('<div class="slc_empty"></div>').text('還沒有字詞。點上面的 + 新增。'));
        return;
    }

    list.forEach((item, i) => {
        const $row = $('<div class="slc_term_row"></div>').attr('data-idx', i);
        const $on = $('<input type="checkbox" title="暫時停用這一條">').prop('checked', item.on !== false);
        const $txt = $('<input type="text" class="text_pole slc_term_input">')
            .attr('placeholder', '字詞，或 /regex/flags')
            .val(String(item.t ?? ''));
        const $del = $('<div class="slc_term_del fa-solid fa-trash-can" title="刪除這一條"></div>');
        $row.append($on, $txt, $del);
        $list.append($row);
    });
}

function bindStripList() {
    const $list = $('#slc_stripList');

    $list.on('input', '.slc_term_input', function () {
        const i = Number($(this).closest('.slc_term_row').attr('data-idx'));
        const list = settings().stripList;
        if (list[i]) {
            list[i].t = String($(this).val());
            saveSettings();
        }
    });

    $list.on('change', 'input[type="checkbox"]', function () {
        const i = Number($(this).closest('.slc_term_row').attr('data-idx'));
        const list = settings().stripList;
        if (list[i]) {
            list[i].on = $(this).prop('checked');
            saveSettings();
        }
    });

    $list.on('click', '.slc_term_del', function () {
        const i = Number($(this).closest('.slc_term_row').attr('data-idx'));
        settings().stripList.splice(i, 1);
        saveSettings();
        renderStripList();
    });

    // Enter 直接再開一條，方便連續輸入
    $list.on('keydown', '.slc_term_input', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        addStripTerm();
    });

    $('#slc_stripAdd').on('click', () => addStripTerm());
}

function addStripTerm() {
    settings().stripList.push({ t: '', on: true });
    saveSettings();
    renderStripList();
    $('#slc_stripList .slc_term_row').last().find('.slc_term_input').trigger('focus');
}

function refreshWandButton() {
    $('#slc_wand_button').remove();
    if (!settings().showWandButton) return;
    const $menu = $('#extensionsMenu');
    if (!$menu.length) return;
    $menu.append(WAND_BUTTON_HTML);
    $('#slc_wand_button').on('click', () => continueSameLayer({ source: 'wand' }));
}

/* ------------------------------------------------------------------ */
/* 啟動                                                                 */
/* ------------------------------------------------------------------ */

jQuery(async () => {
    settings();

    // 動態載入 ST 的設定物件；載不到就退化成純原生行為，不會壞掉。
    try {
        ({ power_user: powerUser } = await import('../../../power-user.js'));
    } catch (err) {
        debug('載不到 power-user.js', err);
    }
    try {
        ({ oai_settings: oaiSettings } = await import('../../../openai.js'));
    } catch (err) {
        debug('載不到 openai.js', err);
    }

    const $container = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    $container.append(SETTINGS_HTML);
    bindSettingsUI();
    refreshWandButton();

    const ctx = getContext();
    const es = ctx.eventSource;
    const et = ctx.eventTypes ?? {};

    if (es && et.GENERATION_ENDED) es.on(et.GENERATION_ENDED, onGenerationEnded);
    if (es && et.MESSAGE_SENT) es.on(et.MESSAGE_SENT, onMessageSent);
    if (es && et.CHAT_CHANGED) es.on(et.CHAT_CHANGED, onMessageSent);

    // 提供斜線指令：/slcontinue
    try {
        const { SlashCommandParser } = await import('../../../slash-commands/SlashCommandParser.js');
        const { SlashCommand } = await import('../../../slash-commands/SlashCommand.js');
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'slcontinue',
            callback: async () => {
                await continueSameLayer({ source: 'slash' });
                return '';
            },
            helpString: '在同一層訊息上繼續續寫（同層續寫擴充）。',
        }));
    } catch (err) {
        debug('這個版本沒有新版斜線指令 API，略過註冊', err);
    }

    if (settings().checkUpdateOnStart) {
        setTimeout(async () => {
            const { hasUpdate, detail } = await checkForUpdate({ silent: true });
            if (hasUpdate) {
                toastr.info(`${detail}。點這裡到設定面板更新。`, '同層續寫有新版', {
                    timeOut: 12000,
                    onclick: () => $('#slc_update').closest('.inline-drawer-content').show(),
                });
            }
        }, 8000);
    }

    console.log(LOG, `已載入（資料夾：${EXT_NAME}）`);
});
