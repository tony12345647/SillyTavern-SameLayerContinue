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
    // 續寫前清理
    stripEnabled: true,       // 啟用刪詞
    stripTerms: '',           // 一行一條，支援 /regex/flags
    stripMode: 'prompt',      // 'prompt' = 只從送給AI的內容刪，聊天記錄保留原文 | 'message' = 直接改訊息
    stripScope: 'all',        // 'all' = 整篇 | 'tail' = 只處理結尾
    stripTailChars: 300,      // scope=tail 時處理最後幾個字
    stripBackup: true,        // 清理前備份原文，可還原

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
    return extension_settings[MODULE_NAME];
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
/* 續寫前清理                                                           */
/* ------------------------------------------------------------------ */

/** 把設定裡的刪除清單解析成 RegExp 陣列。純文字會自動跳脫。 */
function parseStripTerms() {
    const raw = String(settings().stripTerms ?? '');
    const patterns = [];
    for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
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
 * stripMode='prompt' 時這是暫時的：訊息會先被改成刪除後的版本送去續寫，
 * 生成結束再由 finalizeStrip() 把原文接回來，聊天記錄看起來沒被動過。
 * stripMode='message' 時就是永久改掉，靠備份還原。
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

    if (s.stripMode === 'message' && s.stripBackup) {
        mes.extra = mes.extra || {};
        mes.extra.slc_backup = original;
    }

    mes.mes = text;
    if (Array.isArray(mes.swipes) && Number.isInteger(mes.swipe_id)) {
        mes.swipes[mes.swipe_id] = text;
    }
    debug(`清理移除 ${count} 處，模式 ${s.stripMode}`);
    return { applied: true, count, original, sent: text, idx };
}

/**
 * 生成結束後收尾。prompt 模式會把原文接回去，只保留 AI 新寫的那一段。
 */
function finalizeStrip(state) {
    const s = settings();
    if (!state?.applied || s.stripMode !== 'prompt') return;

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
        toastr.warning('接不回原文（內容和送出時對不上），這次的刪除留在訊息裡了。可按「還原上次清理」處理。', '同層續寫');
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

/** 直接把刪除清單永久套用到訊息（面板上的「直接清理訊息」按鈕用）。 */
function applyStripToLastMessage({ render = true } = {}) {
    const item = lastAiMessage();
    if (!item) return { applied: false, count: 0 };
    const { idx, mes } = item;
    const original = mes.mes;
    const { text, count } = stripFromText(original);
    if (!count || text === original) return { applied: false, count: 0 };

    mes.extra = mes.extra || {};
    mes.extra.slc_backup = original;
    mes.mes = text;
    if (Array.isArray(mes.swipes) && Number.isInteger(mes.swipe_id)) {
        mes.swipes[mes.swipe_id] = text;
    }
    if (render) refreshMessageBlock(idx, mes);
    return { applied: true, count };
}

/** 還原最近一次清理。 */
function restoreLastStrip() {
    const item = lastAiMessage();
    if (!item) {
        toastr.warning('最後一則不是角色訊息');
        return;
    }
    const { idx, mes } = item;
    const backup = mes.extra?.slc_backup;
    if (typeof backup !== 'string') {
        toastr.warning('這則訊息沒有清理備份可以還原');
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
    toastr.success('已還原清理前的內容', '同層續寫');
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
    try {
        debug(`開始續寫（來源：${source}），目前長度 ${mes.mes?.length ?? 0}`);
        const awaited = await invokeNativeContinue();
        if (!awaited) await waitForGenerationEnd();
        finalizeStrip(stripState);
        syncSwipeText();
        return true;
    } catch (err) {
        console.error(LOG, err);
        // 生成失敗時，prompt 模式要把原文放回去，不能留下被刪過的版本
        if (stripState.applied && settings().stripMode === 'prompt') {
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
            <h4>續寫前清理</h4>
            <small class="slc_hint">續寫之前先把這些字詞從上一層內容裡拿掉，再讓 AI 接著寫。一行一條；用 /pattern/flags 可以寫正規表達式；# 開頭是註解。</small>

            <label class="checkbox_label" for="slc_stripEnabled">
                <input id="slc_stripEnabled" type="checkbox"><span>啟用清理</span>
            </label>

            <textarea id="slc_stripTerms" class="text_pole textarea_compact" rows="6" placeholder="（待續）&#10;※&#10;/\\[系統[^\\]]*\\]/&#10;# 井字號開頭這行不會生效"></textarea>

            <label for="slc_stripMode">刪除範圍</label>
            <select id="slc_stripMode" class="text_pole">
                <option value="prompt">只從送給 AI 的內容刪，聊天記錄保留原文</option>
                <option value="message">直接從訊息刪掉（永久，可還原）</option>
            </select>

            <label for="slc_stripScope">掃描範圍</label>
            <select id="slc_stripScope" class="text_pole">
                <option value="all">整篇訊息</option>
                <option value="tail">只處理結尾 N 字</option>
            </select>

            <label for="slc_stripTailChars">結尾範圍的字數</label>
            <input id="slc_stripTailChars" class="text_pole" type="number" min="10" max="5000" step="10">

            <label class="checkbox_label" for="slc_stripBackup">
                <input id="slc_stripBackup" type="checkbox"><span>清理前備份原文（可還原）</span>
            </label>

            <div class="flex-container flexGap5">
                <input id="slc_stripNow" class="menu_button" type="button" value="直接清理訊息">
                <input id="slc_stripRestore" class="menu_button" type="button" value="還原上次清理">
            </div>

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
        'forcePrefill', 'checkUpdateOnStart', 'stripEnabled', 'stripBackup',
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

    $('#slc_stripMode').val(s.stripMode).on('change', function () {
        settings().stripMode = String($(this).val());
        saveSettings();
    });

    $('#slc_stripScope').val(s.stripScope).on('change', function () {
        settings().stripScope = String($(this).val());
        saveSettings();
    });

    $('#slc_stripTerms').val(s.stripTerms).on('input', function () {
        settings().stripTerms = String($(this).val());
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

    for (const key of ['maxAutoRetries', 'minLength', 'stripTailChars']) {
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
    $('#slc_stripNow').on('click', () => {
        const r = applyStripToLastMessage({ render: true });
        if (r.applied) {
            const ctx = getContext();
            (ctx.saveChatConditional ?? ctx.saveChat)?.();
            toastr.success(`刪除了 ${r.count} 處`, '已直接改動訊息');
        } else {
            toastr.info('沒有符合的字詞，或清理沒有啟用', '同層續寫');
        }
    });
    $('#slc_stripRestore').on('click', () => restoreLastStrip());
    $('#slc_check').on('click', () => checkForUpdate({ silent: false }));
    $('#slc_update').on('click', () => runUpdate());
    renderVersionLine();
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
