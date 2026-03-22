/**
 * GSVI Inline TTS — Quote Extractor Module
 * Extracts quoted text from messages, shows selection modal,
 * generates TTS audio, and manages metadata persistence.
 */

import { saveChatDebounced } from '../../../../../script.js';
import { LOG } from './constants.js';
import { getSettings } from './settings.js';
import { fetchedVoices } from './api.js';
import { hashKey } from './utils.js';
import { audioCache, warmCacheFromIDB, generateWithCache, idbGet, idbDelete } from './cache.js';
import { playAudioBlob, stopCurrentPlayback } from './renderer.js';

// ═══════════════════════════════════════════════════════════════
// Quote Extraction
// ═══════════════════════════════════════════════════════════════

const QUOTE_PATTERNS = {
    double: /[\u201c\u201d"""]([^"\u201c\u201d"""]+?)[\u201c\u201d"""]/g,   // "" and ""
    cjk: /\u300c([^\u300c\u300d]+?)\u300d/g,                                // 「」
};

/**
 * Extract quoted text from raw message, excluding text already inside <tts> tags.
 * @param {string} rawText
 * @param {string} quoteStyle - "double" | "cjk" | "all"
 * @returns {{ text: string, index: number }[]}
 */
export function extractQuotes(rawText, quoteStyle) {
    if (!rawText) return [];

    // Strip <tts ...>...</tts> blocks so we don't re-extract tagged content
    const cleaned = rawText.replace(/<tts\s[^>]*>[\s\S]*?<\/tts>/gi, (m) => ' '.repeat(m.length));

    const results = [];
    const seen = new Set();

    const patterns = quoteStyle === 'all'
        ? Object.values(QUOTE_PATTERNS)
        : [QUOTE_PATTERNS[quoteStyle] || QUOTE_PATTERNS.double];

    for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(cleaned)) !== null) {
            const text = m[1].trim();
            if (text && !seen.has(text)) {
                seen.add(text);
                results.push({ text, index: m.index });
            }
        }
    }

    // Sort by position in the original text
    results.sort((a, b) => a.index - b.index);
    return results;
}

// ═══════════════════════════════════════════════════════════════
// Quote Selection Modal
// ═══════════════════════════════════════════════════════════════

/**
 * Open a modal that lets users pick which extracted quotes to generate TTS for.
 * @param {{ text: string, index: number }[]} quotes
 * @param {string} mesId
 * @param {object} chatMsg
 */
export function openQuoteSelectModal(quotes, mesId, chatMsg) {
    if (!quotes || quotes.length === 0) {
        toastr.info('未在此消息中找到引号内容', 'GSVI TTS');
        return;
    }

    // Remove old modal if any
    $('#gsvi-quote-modal').remove();

    const s = getSettings();
    const voices = fetchedVoices.length > 0 ? fetchedVoices : s.cachedVoices || [];

    // Build quote list
    let listHtml = '';
    quotes.forEach((q, i) => {
        listHtml += `
            <label class="gsvi-quote-item">
                <input type="checkbox" class="gsvi-quote-cb" data-idx="${i}" checked />
                <span class="gsvi-quote-text" title="${q.text.replace(/"/g, '&quot;')}">${q.text}</span>
            </label>`;
    });

    // Build voice options
    let voiceOptionsHtml = '';
    if (voices.length > 0) {
        const sorted = [...voices].sort((a, b) => a.name.localeCompare(b.name));
        sorted.forEach(v => {
            const sel = v.id === s.voiceId ? 'selected' : '';
            voiceOptionsHtml += `<option value="${v.id}" ${sel}>${v.name}</option>`;
        });
    } else {
        voiceOptionsHtml = '<option value="">(请先获取模型)</option>';
    }

    // Build emotion options for the default voice
    const defaultVoice = voices.find(v => v.id === s.voiceId);
    let emotionOptionsHtml = buildEmotionOptions(defaultVoice, s);

    const modalHtml = `
        <div id="gsvi-quote-modal" class="gsvi-modal-backdrop">
            <div class="gsvi-modal-container" style="max-width: 600px; width: 90%;">
                <div class="gsvi-modal-header">
                    <h3 class="gsvi-modal-title">引号语音提取</h3>
                    <button class="gsvi-modal-close" id="gsvi-quote-close"><i class="fa-solid fa-times"></i></button>
                </div>
                <div class="gsvi-modal-body" style="flex-direction: column; gap: 12px;">
                    <div class="gsvi-quote-toolbar">
                        <button id="gsvi-quote-select-all" class="menu_button gsvi-action-btn">
                            <i class="fa-solid fa-check-double"></i> 全选
                        </button>
                        <button id="gsvi-quote-deselect-all" class="menu_button gsvi-action-btn secondary">
                            <i class="fa-solid fa-xmark"></i> 取消全选
                        </button>
                        <span class="gsvi-quote-count">${quotes.length} 条引号内容</span>
                    </div>
                    <div id="gsvi-quote-list" class="gsvi-quote-list">
                        ${listHtml}
                    </div>

                    <!-- Collapsible TTS Settings -->
                    <details class="gsvi-quote-settings-details">
                        <summary class="gsvi-quote-settings-summary">
                            <i class="fa-solid fa-sliders"></i> TTS 设置
                            <i class="fa-solid fa-chevron-down gsvi-quote-chevron"></i>
                        </summary>
                        <div class="gsvi-quote-settings-body">
                            <div class="gsvi-settings-row">
                                <label>角色</label>
                                <select id="gsvi-quote-voice" class="text_pole" style="flex:1;min-width:0;">
                                    ${voiceOptionsHtml}
                                </select>
                            </div>
                            <div class="gsvi-settings-row">
                                <label>情绪</label>
                                <select id="gsvi-quote-emotion" class="text_pole" style="flex:1;min-width:0;">
                                    ${emotionOptionsHtml}
                                </select>
                            </div>
                        </div>
                    </details>
                </div>
                <div class="gsvi-modal-footer">
                    <button id="gsvi-quote-cancel" class="menu_button gsvi-modal-btn gsvi-modal-btn-secondary">取消</button>
                    <button id="gsvi-quote-generate" class="menu_button gsvi-modal-btn gsvi-modal-btn-primary">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> 生成语音
                    </button>
                </div>
            </div>
        </div>`;

    $('body').append(modalHtml);

    // Voice change → update emotion dropdown
    $('#gsvi-quote-voice').on('change', function () {
        const voiceId = $(this).val();
        const voice = voices.find(v => v.id === voiceId);
        const sLocal = getSettings();
        $('#gsvi-quote-emotion').html(buildEmotionOptions(voice, sLocal));
    });

    // Select / Deselect all
    $('#gsvi-quote-select-all').on('click', () => {
        $('#gsvi-quote-list .gsvi-quote-cb').prop('checked', true);
    });
    $('#gsvi-quote-deselect-all').on('click', () => {
        $('#gsvi-quote-list .gsvi-quote-cb').prop('checked', false);
    });

    // Close modal
    const closeModal = () => {
        const modal = $('#gsvi-quote-modal');
        modal.find('.gsvi-modal-container')
            .css('animation', 'gsvi-slide-up 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275) reverse');
        modal.css('animation', 'gsvi-fade-in 0.2s ease-out reverse');
        setTimeout(() => modal.remove(), 180);
    };

    $('#gsvi-quote-close, #gsvi-quote-cancel').on('click', closeModal);
    $('#gsvi-quote-modal').on('click', function (e) {
        if (e.target === this) closeModal();
    });

    // Generate
    $('#gsvi-quote-generate').on('click', function () {
        const selected = [];
        $('#gsvi-quote-list .gsvi-quote-cb:checked').each((_, el) => {
            const idx = parseInt($(el).data('idx'), 10);
            selected.push(quotes[idx]);
        });

        if (selected.length === 0) {
            toastr.warning('请至少选择一条引号内容', 'GSVI TTS');
            return;
        }

        const voiceId = $('#gsvi-quote-voice').val() || s.voiceId;
        const emotion = $('#gsvi-quote-emotion').val() || s.emotion || '默认';

        closeModal();

        const mesElement = document.querySelector(`div.mes[mesid="${mesId}"]`);
        if (!mesElement) return;

        generateQuoteTTS(selected, mesElement, chatMsg, voiceId, emotion);
    });
}

/**
 * Build emotion <option> HTML from a voice object.
 */
function buildEmotionOptions(voice, settings) {
    let emotions = [];
    if (voice) {
        if (voice.emotionsMap && settings.promptLang && voice.emotionsMap[settings.promptLang]) {
            emotions = voice.emotionsMap[settings.promptLang];
        } else if (voice.emotions) {
            emotions = voice.emotions;
        }
    }
    if (emotions.length === 0) {
        return '<option value="">(无可用情绪)</option>';
    }
    return emotions.map(e =>
        `<option value="${e}" ${settings.emotion === e ? 'selected' : ''}>${e}</option>`
    ).join('');
}

// ═══════════════════════════════════════════════════════════════
// TTS Generation for Quotes
// ═══════════════════════════════════════════════════════════════

let quoteLineCounter = 0;

/**
 * Generate TTS audio for selected quotes and insert players inline.
 */
async function generateQuoteTTS(selectedQuotes, mesElement, chatMsg, voiceId, emotion) {
    const mesTextEl = mesElement.querySelector('.mes_text');
    if (!mesTextEl) return;

    // Remove existing quote audio controls
    mesTextEl.querySelectorAll('.gsvi-audio-inline.gsvi-quote-audio').forEach(el => el.remove());

    const generations = [];

    for (const q of selectedQuotes) {
        const lineId = `gsvi-qline-${++quoteLineCounter}`;
        const playBtnId = `${lineId}-play`;
        const regenBtnId = `${lineId}-regen`;
        const key = hashKey(q.text, voiceId, emotion);

        let isCached = audioCache.has(key);

        // Check metadata
        if (chatMsg?.extra?.gsvi_quote_tts?.quotes) {
            const saved = chatMsg.extra.gsvi_quote_tts.quotes.find(sq => sq.cacheKey === key);
            if (saved?.serverPath && !isCached) {
                audioCache.set(key, { url: saved.serverPath, isServerPath: true });
                isCached = true;
            }
        }

        generations.push({
            lineId, playBtnId, regenBtnId,
            text: q.text, voiceId, emotion,
            key, isCached,
        });
    }

    // Warm IDB cache
    await warmCacheFromIDB(generations.map(g => g.key));
    for (const gen of generations) {
        gen.isCached = audioCache.has(gen.key);
    }

    // Find paragraphs for placement
    const paragraphs = Array.from(mesTextEl.querySelectorAll('p, blockquote'));

    for (const gen of generations) {
        const lineDiv = document.createElement('div');
        lineDiv.className = 'gsvi-audio-inline gsvi-quote-audio';

        const playStateClass = gen.isCached ? 'gsvi-state-ready' : 'gsvi-state-loading';
        const playBtnIcon = gen.isCached
            ? '<i class="fa-solid fa-play"></i>'
            : '<i class="fa-solid fa-spinner fa-spin"></i>';
        const cacheDataKey = gen.isCached ? `data-cache-key="${gen.key}"` : '';

        lineDiv.innerHTML = `
            <div class="gsvi-progress-bar"></div>
            <div class="gsvi-inline-meta">
                <b class="gsvi-inline-char" style="font-size:11px;opacity:0.6;"><i class="fa-solid fa-quote-left" style="margin-right:4px;"></i>引用</b>
                <span class="gsvi-inline-preview" title="${gen.text.replace(/"/g, '&quot;')}">${gen.text}</span>
            </div>
            <div class="gsvi-inline-right">
                <span class="gsvi-duration">0:00</span>
                <div class="gsvi-inline-btns">
                    <button id="${gen.playBtnId}" class="gsvi-btn ${playStateClass}" title="${gen.isCached ? '播放' : '生成中...'}" ${cacheDataKey}>
                        ${playBtnIcon}
                    </button>
                    <button id="${gen.playBtnId}-dl" class="gsvi-btn gsvi-dl-btn" title="下载音频" ${gen.isCached ? '' : 'disabled style="opacity:0.5;cursor:not-allowed;"'}>
                        <i class="fa-solid fa-download"></i>
                    </button>
                    <button id="${gen.regenBtnId}" class="gsvi-btn gsvi-regen-btn" title="单句重生成">
                        <i class="fa-solid fa-arrows-rotate"></i>
                    </button>
                </div>
            </div>`;

        // Find matching paragraph
        let targetP = null;
        for (let i = paragraphs.length - 1; i >= 0; i--) {
            if (paragraphs[i].textContent.includes(gen.text)) {
                targetP = paragraphs[i];
                break;
            }
        }

        if (targetP) {
            targetP.insertAdjacentElement('beforeend', lineDiv);
        } else {
            mesTextEl.appendChild(lineDiv);
        }

        // Bind events
        bindQuoteLineEvents(gen, chatMsg, lineDiv);

        // Start generation or load cached duration
        if (!gen.isCached) {
            triggerQuoteGeneration(gen, chatMsg);
        } else {
            const data = audioCache.get(gen.key);
            if (data?.url) {
                const tempAudio = new Audio(data.url);
                tempAudio.addEventListener('loadedmetadata', () => {
                    const dEl = lineDiv.querySelector('.gsvi-duration');
                    if (dEl) {
                        const m = Math.floor(tempAudio.duration / 60);
                        const sec = Math.floor(tempAudio.duration % 60);
                        dEl.textContent = `${m}:${sec.toString().padStart(2, '0')}`;
                    }
                });
            }
        }
    }
}

function bindQuoteLineEvents(gen, chatMsg, lineDiv) {
    const playBtn = document.getElementById(gen.playBtnId);
    const regenBtn = document.getElementById(gen.regenBtnId);
    const dlBtn = document.getElementById(`${gen.playBtnId}-dl`);

    if (playBtn) {
        playBtn.addEventListener('click', () => {
            if (playBtn.classList.contains('gsvi-state-loading')) return;
            if (playBtn.classList.contains('gsvi-state-error')) return;
            if (playBtn.classList.contains('gsvi-state-playing')) {
                stopCurrentPlayback();
                return;
            }
            const key = playBtn.dataset.cacheKey;
            if (key && audioCache.has(key)) {
                playAudioBlob(audioCache.get(key).url, gen.playBtnId);
            }
        });
    }

    if (dlBtn) {
        dlBtn.addEventListener('click', async () => {
            let data = audioCache.get(gen.key);
            let blob = data?.blob;
            if (!blob && data?.url) {
                try {
                    const resp = await fetch(data.url);
                    blob = await resp.blob();
                } catch (err) { console.error(`${LOG} Fetch failed`, err); }
            }
            if (!blob) blob = await idbGet(gen.key);
            if (!blob) { toastr.warning('尚未生成音频', 'GSVI TTS'); return; }

            const sanitize = (str) => (str || '').replace(/[^\p{L}\p{N}_-]/gu, '_').replace(/_{2,}/g, '_');
            const safeText = sanitize(gen.text).substring(0, 20);
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `gsvi_quote_${safeText}_${gen.key}.wav`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        });
    }

    if (regenBtn) {
        regenBtn.addEventListener('click', async () => {
            if (regenBtn.classList.contains('gsvi-spinning')) return;

            // Remove from cache
            if (audioCache.has(gen.key)) {
                const data = audioCache.get(gen.key);
                if (data.url?.startsWith('blob:')) URL.revokeObjectURL(data.url);
                audioCache.delete(gen.key);
            }
            await idbDelete(gen.key);

            // Clear metadata
            if (chatMsg?.extra?.gsvi_quote_tts?.quotes) {
                chatMsg.extra.gsvi_quote_tts.quotes = chatMsg.extra.gsvi_quote_tts.quotes
                    .filter(sq => sq.cacheKey !== gen.key);
                saveChatDebounced();
            }

            // Reset play button
            if (playBtn) {
                playBtn.classList.remove('gsvi-state-ready', 'gsvi-state-error', 'gsvi-state-playing');
                playBtn.classList.add('gsvi-state-loading');
                playBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
                playBtn.title = '生成中...';
            }
            if (dlBtn) {
                dlBtn.setAttribute('disabled', 'true');
                dlBtn.style.opacity = '0.5';
                dlBtn.style.cursor = 'not-allowed';
            }

            regenBtn.classList.add('gsvi-spinning');
            triggerQuoteGeneration(gen, chatMsg).finally(() => {
                regenBtn.classList.remove('gsvi-spinning');
            });
        });
    }
}

async function triggerQuoteGeneration(gen, chatMsg) {
    try {
        const result = await generateWithCache(gen.text, gen.voiceId, gen.emotion);
        const btn = document.getElementById(gen.playBtnId);
        if (btn) {
            btn.dataset.cacheKey = result.key;
            btn.classList.remove('gsvi-state-loading');
            btn.classList.add('gsvi-state-ready');
            btn.innerHTML = '<i class="fa-solid fa-play"></i>';
            btn.title = '播放';
        }

        // Enable download
        const dlBtn = document.getElementById(`${gen.playBtnId}-dl`);
        if (dlBtn) {
            dlBtn.removeAttribute('disabled');
            dlBtn.style.opacity = '';
            dlBtn.style.cursor = '';
        }

        // Save to metadata
        saveQuoteMetadata(chatMsg, gen.text, result.key, result.serverPath);
    } catch (err) {
        console.error(`${LOG} Quote TTS failed for "${gen.text.substring(0, 30)}...":`, err);
        const btn = document.getElementById(gen.playBtnId);
        if (btn) {
            btn.classList.remove('gsvi-state-loading');
            btn.classList.add('gsvi-state-error');
            btn.innerHTML = '⚠';
            btn.title = `生成失败: ${err.message}`;
        }
    }
}

function saveQuoteMetadata(chatMsg, text, cacheKey, serverPath) {
    if (!chatMsg) return;
    if (!chatMsg.extra) chatMsg.extra = {};
    if (!chatMsg.extra.gsvi_quote_tts) chatMsg.extra.gsvi_quote_tts = { quotes: [] };

    const existing = chatMsg.extra.gsvi_quote_tts.quotes.find(q => q.cacheKey === cacheKey);
    if (existing) {
        existing.serverPath = serverPath || existing.serverPath;
    } else {
        chatMsg.extra.gsvi_quote_tts.quotes.push({
            text,
            cacheKey,
            serverPath: serverPath || null,
        });
    }
    saveChatDebounced();
    console.log(`${LOG} Saved quote TTS metadata: "${text.substring(0, 30)}..." key=${cacheKey}`);
}

// ═══════════════════════════════════════════════════════════════
// Restore from Metadata
// ═══════════════════════════════════════════════════════════════

/**
 * Restore quote TTS players from saved metadata on page load / re-render.
 */
export async function restoreQuoteTTSFromMetadata(mesElement, chatMsg) {
    if (!chatMsg?.extra?.gsvi_quote_tts?.quotes?.length) return;

    const mesTextEl = mesElement.querySelector('.mes_text');
    if (!mesTextEl) return;

    // Don't duplicate if already restored
    if (mesTextEl.querySelectorAll('.gsvi-quote-audio').length > 0) return;

    const s = getSettings();
    const savedQuotes = chatMsg.extra.gsvi_quote_tts.quotes;

    // Pre-register server paths in cache
    for (const sq of savedQuotes) {
        if (sq.serverPath && !audioCache.has(sq.cacheKey)) {
            audioCache.set(sq.cacheKey, { url: sq.serverPath, isServerPath: true });
        }
    }

    // Warm IDB
    await warmCacheFromIDB(savedQuotes.map(sq => sq.cacheKey));

    const paragraphs = Array.from(mesTextEl.querySelectorAll('p, blockquote'));

    for (const sq of savedQuotes) {
        const isCached = audioCache.has(sq.cacheKey);
        const lineId = `gsvi-qline-${++quoteLineCounter}`;
        const playBtnId = `${lineId}-play`;
        const regenBtnId = `${lineId}-regen`;

        const gen = {
            lineId, playBtnId, regenBtnId,
            text: sq.text,
            voiceId: '', // Not needed for restored playback
            emotion: '',
            key: sq.cacheKey,
            isCached,
        };

        const lineDiv = document.createElement('div');
        lineDiv.className = 'gsvi-audio-inline gsvi-quote-audio';

        const playStateClass = isCached ? 'gsvi-state-ready' : 'gsvi-state-error';
        const playBtnIcon = isCached
            ? '<i class="fa-solid fa-play"></i>'
            : '<i class="fa-solid fa-circle-exclamation"></i>';
        const cacheDataKey = isCached ? `data-cache-key="${sq.cacheKey}"` : '';

        lineDiv.innerHTML = `
            <div class="gsvi-progress-bar"></div>
            <div class="gsvi-inline-meta">
                <b class="gsvi-inline-char" style="font-size:11px;opacity:0.6;"><i class="fa-solid fa-quote-left" style="margin-right:4px;"></i>引用</b>
                <span class="gsvi-inline-preview" title="${sq.text.replace(/"/g, '&quot;')}">${sq.text}</span>
            </div>
            <div class="gsvi-inline-right">
                <span class="gsvi-duration">0:00</span>
                <div class="gsvi-inline-btns">
                    <button id="${playBtnId}" class="gsvi-btn ${playStateClass}" title="${isCached ? '播放' : '音频未找到'}" ${cacheDataKey}>
                        ${playBtnIcon}
                    </button>
                    <button id="${playBtnId}-dl" class="gsvi-btn gsvi-dl-btn" title="下载音频" ${isCached ? '' : 'disabled style="opacity:0.5;cursor:not-allowed;"'}>
                        <i class="fa-solid fa-download"></i>
                    </button>
                </div>
            </div>`;

        // Place near matching text
        let targetP = null;
        for (let i = paragraphs.length - 1; i >= 0; i--) {
            if (paragraphs[i].textContent.includes(sq.text)) {
                targetP = paragraphs[i];
                break;
            }
        }
        if (targetP) {
            targetP.insertAdjacentElement('beforeend', lineDiv);
        } else {
            mesTextEl.appendChild(lineDiv);
        }

        // Bind play + download events
        bindQuoteLineEvents(gen, chatMsg, lineDiv);

        // Load duration
        if (isCached) {
            const data = audioCache.get(sq.cacheKey);
            if (data?.url) {
                const tempAudio = new Audio(data.url);
                tempAudio.addEventListener('loadedmetadata', () => {
                    const dEl = lineDiv.querySelector('.gsvi-duration');
                    if (dEl) {
                        const m = Math.floor(tempAudio.duration / 60);
                        const sec = Math.floor(tempAudio.duration % 60);
                        dEl.textContent = `${m}:${sec.toString().padStart(2, '0')}`;
                    }
                });
            }
        }
    }
}
