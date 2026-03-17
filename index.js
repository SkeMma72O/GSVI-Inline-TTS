/**
 * GSVI Inline TTS Extension for SillyTavern
 * Detects <tts char="..." emotion="..."> tags in chat messages,
 * generates audio via GPT-SoVITS API, and renders inline play buttons.
 */

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, saveChatDebounced, eventSource, event_types, setExtensionPrompt, extension_prompt_types } from "../../../../script.js";
import { Popup, POPUP_TYPE, POPUP_RESULT } from "../../../../scripts/popup.js";

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

const EXT_NAME = "GSVI-Extension";
const SETTINGS_KEY = "gsvi_inline_tts";
const LOG = "[GSVI-TTS]";

const TTS_TAG_REGEX = /<tts\s+char="([^"]+)"\s+emotion="([^"]*?)"(?:\s+lang="([^"]*?)")?\s*>([\s\S]*?)<\/tts>/gi;
const DEFAULT_PREVIEW_TEXT = "你好呀，这是一段试听文本。今天天气真好！";

const defaultSettings = {
    enabled: true,
    endpoint: "http://localhost:8001",
    apiFormat: "auto",        // auto | adapter | gsvi
    voiceId: "",
    voiceVersion: "",         // e.g. "v4" → model becomes "GSVI-v4"
    speed: 1.0,
    textLang: "多语种混合",
    promptLang: "",
    emotion: "",
    textSplitMethod: "按标点符号切",
    batchSize: 1,
    saveLocally: false,
    saveToServer: false,
    maxConcurrent: 3,
    promptList: [
        {
            id: "default",
            name: "Default Formatting",
            content: "" // Populated at runtime from default_prompt.txt
        }
    ],
    injectEnabled: false,
    injectPosition: 0, // 0 = System, 1 = Before Chat, 2 = In Chat
    themeColor: "#3ac6edff",
    cachedVoices: [], // Stores fetched voices offline
    // Character → voice mapping: { charName: voiceId }
    characterVoices: {},
    testVoiceId: "",
    testEmotion: "",
};

// ═══════════════════════════════════════════════════════════════
// Runtime State
// ═══════════════════════════════════════════════════════════════

/** @type {Map<string, { blob?: Blob, url: string, isServerPath?: boolean }>} hash → audio data */
const audioCache = new Map();

/** @type {Map<string, Promise>} hash → pending generation promise */
const pendingGenerations = new Map();

let currentGenerations = 0;

/** @type {Array<{ id: string, name: string, language: string, emotions?: string[], promptLangs?: string[], emotionsMap?: object, version?: string }>} */
let fetchedVoices = [];

/** @type {Audio|null} */
let currentAudio = null;
let currentPlayingBtnId = null;

// ═══════════════════════════════════════════════════════════════
// Settings Management
// ═══════════════════════════════════════════════════════════════

function getSettings() {
    if (!extension_settings[SETTINGS_KEY]) {
        extension_settings[SETTINGS_KEY] = structuredClone(defaultSettings);
    }
    const s = extension_settings[SETTINGS_KEY];
    // Ensure all default keys are present (for compatibility across updates)
    for (const [key, val] of Object.entries(defaultSettings)) {
        if (!(key in s)) {
            s[key] = structuredClone(val);
        }
    }
    // Specifically: ensure promptList is a non-empty array
    if (!s.promptList || !Array.isArray(s.promptList) || s.promptList.length === 0) {
        s.promptList = structuredClone(defaultSettings.promptList);
    }
    return s;
}

function saveSettings() {
    saveSettingsDebounced();
}

// ═══════════════════════════════════════════════════════════════
// API Format Detection
// ═══════════════════════════════════════════════════════════════

function detectFormat(endpoint, override) {
    if (override === "adapter" || override === "gsvi") return override;
    try {
        const url = new URL(endpoint);
        if (url.port === "8000") return "gsvi";
    } catch { /* ignore */ }
    return "adapter";
}

// ═══════════════════════════════════════════════════════════════
// TTS API — Fetch Voices / Models
// ═══════════════════════════════════════════════════════════════

async function fetchVoicesAdapter(endpoint) {
    const tryPaths = ["/speakers", "/speakers_list", "/character_list"];
    for (const path of tryPaths) {
        try {
            const resp = await fetch(`${endpoint}${path}`);
            if (!resp.ok) continue;
            const data = await resp.json();

            let list = [];
            if (Array.isArray(data)) list = data;
            else if (data.speakers && Array.isArray(data.speakers)) list = data.speakers;
            else if (data.characters && Array.isArray(data.characters)) list = data.characters;
            else if (typeof data === "object") list = Object.keys(data);

            if (list.length === 0) continue;

            return list.map(s => {
                const name = typeof s === "string" ? s : (s.name || s.id || String(s));
                return { id: name, name, language: "auto" };
            });
        } catch (err) {
            console.warn(`${LOG} fetchVoices ${path}: ${err.message}`);
        }
    }
    throw new Error("无法获取角色列表 (尝试了 /speakers, /speakers_list, /character_list)");
}

async function fetchVoicesGSVI(endpoint) {
    const versions = ["v2", "v3", "v4", "v2Pro"];
    const allVoices = [];

    for (const version of versions) {
        try {
            const resp = await fetch(`${endpoint}/models/${version}`);
            if (!resp.ok) continue;
            const data = await resp.json();
            const models = data.models || data;

            if (typeof models !== "object" || Object.keys(models).length === 0) continue;

            for (const [modelName, folders] of Object.entries(models)) {
                const emotions = [];
                const promptLangs = [];
                const emotionsMap = {};
                let promptLang = "";

                if (folders && typeof folders === "object") {
                    for (const [folderName, emotionList] of Object.entries(folders)) {
                        if (!promptLang) promptLang = folderName;
                        promptLangs.push(folderName);
                        emotionsMap[folderName] = Array.isArray(emotionList) ? emotionList.filter(e => e && e.length > 0) : [];
                        if (Array.isArray(emotionList)) {
                            emotions.push(...emotionList.filter(e => e && e.length > 0));
                        }
                    }
                }

                allVoices.push({
                    id: modelName,
                    name: `${modelName} [${version}]`,
                    language: promptLang || "auto",
                    emotions,
                    promptLangs,
                    emotionsMap,
                    version,
                });
            }
        } catch (err) {
            console.warn(`${LOG} /models/${version}: ${err.message}`);
        }
    }

    if (allVoices.length === 0) {
        throw new Error("GPT-SoVITS: 没有找到任何模型 (v2/v3/v4/v2Pro)");
    }
    return allVoices;
}

async function fetchVoiceList() {
    const s = getSettings();
    const endpoint = s.endpoint.replace(/\/$/, "");
    const format = detectFormat(endpoint, s.apiFormat);

    console.log(`${LOG} Fetching voices: format=${format}, endpoint=${endpoint}`);

    if (format === "adapter") {
        return fetchVoicesAdapter(endpoint);
    } else {
        return fetchVoicesGSVI(endpoint);
    }
}

// ═══════════════════════════════════════════════════════════════
// TTS API — Synthesize
// ═══════════════════════════════════════════════════════════════

async function synthesizeAdapter(text, endpoint, settings) {
    const emotion = settings._emotion || settings.emotion || "";
    const voiceId = settings._voiceId || settings.voiceId || "";
    const targetVoice = (emotion && emotion !== "default" && emotion !== "默认")
        ? `${voiceId}/${emotion}`
        : voiceId;

    const body = {
        text,
        target_voice: targetVoice,
        use_st_adapter: true,
        text_lang: settings.textLang || "多语种混合",
        prompt_lang: settings.promptLang || "",
        text_split_method: settings.textSplitMethod || "按标点符号切",
        batch_size: parseInt(settings.batchSize, 10) || 1,
        media_type: "wav",
        streaming_mode: "false",
    };

    console.debug(`${LOG} POST ${endpoint}/`, body);

    const resp = await fetch(`${endpoint}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Adapter HTTP ${resp.status}: ${errText}`);
    }
    return resp.arrayBuffer();
}

async function synthesizeGSVI(text, endpoint, settings) {
    const voiceId = settings._voiceId || settings.voiceId || "";
    const emotion = settings._emotion || settings.emotion || "默认";

    const body = {
        model: `GSVI-${settings.voiceVersion || settings._voiceVersion || "v2Pro"}`,
        input: text,
        voice: voiceId,
        response_format: "wav",
        speed: settings.speed || 1,
        other_params: {
            app_key: "",
            text_lang: settings.textLang || "多语种混合",
            prompt_lang: settings.promptLang || "",
            emotion: emotion || "默认",
            top_k: 10,
            top_p: 1,
            temperature: 1,
            text_split_method: settings.textSplitMethod || "按标点符号切",
            batch_size: parseInt(settings.batchSize, 10) || 1,
            batch_threshold: 0.75,
            split_bucket: true,
            fragment_interval: 0.3,
            parallel_infer: true,
            repetition_penalty: 1.35,
            sample_steps: 16,
            if_sr: false,
            seed: -1,
        },
    };

    console.debug(`${LOG} POST ${endpoint}/v1/audio/speech`, body);

    const resp = await fetch(`${endpoint}/v1/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`GSVI HTTP ${resp.status}: ${errText}`);
    }
    return resp.arrayBuffer();
}

/**
 * Generate audio for given text with specified voice and emotion.
 * @param {string} text
 * @param {string} voiceId
 * @param {string} emotion
 * @returns {Promise<{ blob: Blob, url: string }>}
 */
async function generateAudio(text, voiceId, emotion, langOverride) {
    const s = getSettings();
    const endpoint = s.endpoint.replace(/\/$/, "");
    const format = detectFormat(endpoint, s.apiFormat);

    const allVoices = fetchedVoices.length > 0 ? fetchedVoices : (s.cachedVoices || []);
    let synthVoice = allVoices.find(v => v.id === voiceId);

    // Fallback if the requested voiceId doesn't exist in our known list
    if (!synthVoice && s.voiceId) {
        console.warn(`${LOG} Voice "${voiceId}" not found, falling back to default "${s.voiceId}"`);
        voiceId = s.voiceId;
        synthVoice = allVoices.find(v => v.id === voiceId);
    }

    // Use the voice's own first promptLang if available, fall back to global setting
    let resolvedPromptLang = s.promptLang || "";
    if (synthVoice?.promptLangs && synthVoice.promptLangs.length > 0) {
        resolvedPromptLang = synthVoice.promptLangs[0];
    }

    const synthSettings = {
        ...s,
        _voiceId: voiceId,
        _emotion: emotion,
        _voiceVersion: synthVoice?.version,
        promptLang: resolvedPromptLang,
        // If the <tts> tag specified a lang override, use it
        textLang: langOverride || s.textLang,
    };

    const arrayBuffer = format === "adapter"
        ? await synthesizeAdapter(text, endpoint, synthSettings)
        : await synthesizeGSVI(text, endpoint, synthSettings);

    const blob = new Blob([arrayBuffer], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    return { blob, url };
}

// ═══════════════════════════════════════════════════════════════
// Audio Cache & Generation
// ═══════════════════════════════════════════════════════════════

function hashKey(text, voiceId, emotion) {
    // Simple string hash
    const str = `${text}|${voiceId}|${emotion}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
}

/**
 * Generate audio with concurrency control and caching.
 * Returns cached result if available.
 */
async function generateWithCache(text, voiceId, emotion, langOverride) {
    const key = hashKey(text, voiceId, emotion);

    // 1. In-memory cache
    if (audioCache.has(key)) {
        return { ...audioCache.get(key), key };
    }

    // 2. IndexedDB persistent cache
    const persisted = await idbGet(key);
    if (persisted) {
        const url = URL.createObjectURL(persisted);
        audioCache.set(key, { blob: persisted, url });
        return { blob: persisted, url, key };
    }

    // 3. Check pending
    if (pendingGenerations.has(key)) {
        await pendingGenerations.get(key);
        if (audioCache.has(key)) {
            return { ...audioCache.get(key), key };
        }
    }

    // 4. Wait for concurrency slot
    const s = getSettings();
    while (currentGenerations >= s.maxConcurrent) {
        await new Promise(r => setTimeout(r, 100));
    }

    currentGenerations++;

    const promise = generateAudio(text, voiceId, emotion, langOverride)
        .then(async result => {
            audioCache.set(key, result);
            // 1. Persist to IDB for future page loads
            if (result.blob) await idbSet(key, result.blob);
            // 2. Optionally upload to SillyTavern server
            const s = getSettings();
            if (s.saveToServer && result.blob) {
                try {
                    const serverPath = await uploadAudioToST(result.blob, text, voiceId, emotion);
                    result.serverPath = serverPath;
                } catch (err) {
                    console.warn(`${LOG} Server upload failed:`, err);
                }
            }
            return result;
        })
        .finally(() => {
            currentGenerations--;
            pendingGenerations.delete(key);
        });

    pendingGenerations.set(key, promise);

    const result = await promise;
    return { ...result, key };
}

// ═══════════════════════════════════════════════════════════════
// Server Upload
// ═══════════════════════════════════════════════════════════════

/**
 * Upload an audio blob to SillyTavern's /api/files/upload endpoint.
 * Follows the same pattern as voiceMessageService.js.
 * @param {Blob} blob
 * @param {string} text - dialogue text (used in filename)
 * @param {string} voiceId
 * @param {string} emotion
 * @returns {Promise<string>} server-side web path
 */
async function uploadAudioToST(blob, text, voiceId, emotion) {
    // Read blob as base64
    const base64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(',')[1]);
        reader.readAsDataURL(blob);
    });

    // Determine extension from blob MIME type
    const ext = blob.type.includes('mp3') || blob.type.includes('mpeg') ? 'mp3' : 'wav';

    // Build a readable filename: gsvi_角色_情感_前10字_timestamp.ext
    const safeName = (voiceId || 'unknown').replace(/[^a-zA-Z0-9一-龥_-]/g, '_').substring(0, 30);
    const safeEmo = (emotion || '').replace(/[^a-zA-Z0-9一-龥_-]/g, '_').substring(0, 20);
    const safeText = (text || '').replace(/[^a-zA-Z0-9一-龥_-]/g, '_').substring(0, 10);
    const filename = `gsvi_${safeName}_${safeEmo}_${safeText}_${Date.now()}.${ext}`;

    return new Promise((resolve, reject) => {
        jQuery.ajax({
            url: '/api/files/upload',
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ name: filename, data: base64 }),
            success: (result) => {
                const webPath = (result.path || `user/files/${filename}`).replace(/\\/g, '/');
                console.log(`${LOG} Audio saved to server: ${webPath}`);
                resolve(webPath);
            },
            error: (xhr, status, err) => {
                console.error(`${LOG} Upload failed:`, xhr.responseText);
                reject(new Error(`Upload failed: ${xhr.status} ${err}`));
            },
        });
    });
}

// ═══════════════════════════════════════════════════════════════
// Audio Playback
// ═══════════════════════════════════════════════════════════════

function stopCurrentPlayback() {
    if (currentAudio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
        currentAudio = null;
    }
    if (currentPlayingBtnId) {
        const btn = document.getElementById(currentPlayingBtnId);
        if (btn) {
            btn.classList.remove("gsvi-state-playing");
            btn.classList.add("gsvi-state-ready");
            btn.innerHTML = "▶";
            btn.title = "播放";
        }
        currentPlayingBtnId = null;
    }
}

function playAudioBlob(blobUrl, playBtnId) {
    stopCurrentPlayback();

    const audio = new Audio(blobUrl);
    currentAudio = audio;
    currentPlayingBtnId = playBtnId;

    const btn = document.getElementById(playBtnId);
    if (btn) {
        btn.classList.remove("gsvi-state-ready");
        btn.classList.add("gsvi-state-playing");
        btn.innerHTML = "⏸";
        btn.title = "暂停";
    }

    audio.onended = () => {
        if (btn) {
            btn.classList.remove("gsvi-state-playing");
            btn.classList.add("gsvi-state-ready");
            btn.innerHTML = '<i class="fa-solid fa-play"></i>';
            btn.title = "播放";
        }
        currentAudio = null;
        currentPlayingBtnId = null;
    };

    audio.onerror = () => {
        if (btn) {
            btn.classList.remove("gsvi-state-playing");
            btn.classList.add("gsvi-state-error");
            btn.innerHTML = "⚠";
            btn.title = "播放失败";
        }
        currentAudio = null;
        currentPlayingBtnId = null;
    };

    audio.play().catch(err => {
        console.error(`${LOG} playback error:`, err);
    });
}

// ═══════════════════════════════════════════════════════════════
// Message Parsing & DOM Rendering
// ═══════════════════════════════════════════════════════════════

let lineCounter = 0;

function resolveVoiceForChar(charName) {
    const s = getSettings();
    const allVoices = fetchedVoices.length > 0 ? fetchedVoices : (s.cachedVoices || []);

    // 1. Check character mappings: ModelID -> CharacterName
    if (s.characterVoices) {
        for (const [voiceId, mappedName] of Object.entries(s.characterVoices)) {
            if (mappedName === charName) {
                return voiceId;
            }
        }
    }

    // 2. Check if the character name exactly matches one of the known voice IDs or names
    const matchingVoice = allVoices.find(v => v.id === charName || v.name === charName);

    if (matchingVoice) {
        return matchingVoice.id;
    }

    // Fall back to default voiceId
    return s.voiceId || "";
}

/**
 * Process a rendered message element: find <tts> tags in the raw text,
 * and append playable buttons at the bottom of the message.
 */
async function processMessageElement(mesElement, chatMsg) {
    const s = getSettings();
    if (!s.enabled) return;

    const mesTextEl = mesElement.querySelector(".mes_text");
    if (!mesTextEl) return;

    const rawText = chatMsg ? chatMsg.mes : mesElement.getAttribute("mes");
    if (!rawText || !rawText.includes("<tts ")) return;

    const generations = [];
    TTS_TAG_REGEX.lastIndex = 0;
    let match;

    while ((match = TTS_TAG_REGEX.exec(rawText)) !== null) {
        const charName = match[1];
        const emotion = match[2];
        const langOverride = match[3] || null; // optional lang attribute
        const dialogue = match[4].trim();
        const lineId = `gsvi-line-${++lineCounter}`;
        const playBtnId = `${lineId}-play`;
        const regenBtnId = `${lineId}-regen`;

        const voiceId = resolveVoiceForChar(charName);
        const key = hashKey(dialogue, voiceId, emotion);

        let isCached = audioCache.has(key);
        let serverPath = null;

        // Check metadata for server path if not in local memory
        if (chatMsg && chatMsg.extra && chatMsg.extra.gsvi_tts && chatMsg.extra.gsvi_tts[key]) {
            serverPath = chatMsg.extra.gsvi_tts[key];
            if (!isCached) {
                // Register server path in memory cache so play button works immediately
                audioCache.set(key, { url: serverPath, isServerPath: true });
                isCached = true;
            }
        }

        if (voiceId) {
            generations.push({ lineId, playBtnId, regenBtnId, text: dialogue, voiceId, emotion, charName, noVoice: false, isCached, langOverride, key });
        } else {
            generations.push({ lineId, playBtnId, regenBtnId, text: dialogue, voiceId: "", emotion, charName, noVoice: true, isCached: false, langOverride, key });
        }
    }

    if (generations.length === 0) return;

    // Pre-warm IDB cache so previously generated lines show as ready immediately
    const keysToWarm = generations
        .filter(g => !g.noVoice)
        .map(g => g.key);
    await warmCacheFromIDB(keysToWarm);

    // Update isCached after IDB warm
    for (const gen of generations) {
        if (!gen.noVoice) {
            gen.isCached = audioCache.has(gen.key);
        }
    }

    // Clean up existing audio containers to prevent duplicates on regeneration
    mesTextEl.querySelectorAll(".gsvi-audio-inline").forEach(el => el.remove());

    // Append button items inline beneath the corresponding text paragraphs
    const paragraphs = Array.from(mesTextEl.querySelectorAll('p, div, blockquote, span'));

    for (const gen of generations) {
        const lineDiv = document.createElement("div");
        lineDiv.className = "gsvi-audio-inline";

        const playStateClass = gen.isCached ? "gsvi-state-ready" : "gsvi-state-loading";
        const playBtnIcon = gen.isCached
            ? '<i class="fa-solid fa-play"></i>'
            : '<i class="fa-solid fa-spinner fa-spin"></i>';

        const cacheDataKey = gen.isCached ? `data-cache-key="${gen.key}"` : '';

        lineDiv.innerHTML = `
            <div class="gsvi-inline-meta">
                <b class="gsvi-inline-char">${gen.charName}</b>
                <span class="gsvi-inline-emo">[${gen.emotion}]</span>
                <span class="gsvi-inline-preview" title="${gen.text.replace(/"/g, '&quot;')}">${gen.text}</span>
            </div>
            <div class="gsvi-inline-btns">
                <button id="${gen.playBtnId}" class="gsvi-btn ${playStateClass}" title="${gen.isCached ? '播放' : '生成中...'}" ${cacheDataKey}>
                    ${playBtnIcon}
                </button>
                <button id="${gen.playBtnId}-dl" class="gsvi-btn gsvi-dl-btn" title="下载音频" ${gen.isCached ? "" : 'disabled style="opacity:0.5;cursor:not-allowed;"'}>
                    <i class="fa-solid fa-download"></i>
                </button>
                <button id="${gen.regenBtnId}" class="gsvi-btn gsvi-regen-btn" title="单句重生成">
                    <i class="fa-solid fa-arrows-rotate"></i>
                </button>
            </div>
        `;

        // Find the most appropriate paragraph to append to
        let targetP = null;
        const searchSnippet = gen.text.substring(0, Math.min(20, gen.text.length));

        for (let i = paragraphs.length - 1; i >= 0; i--) {
            if (paragraphs[i].textContent.includes(searchSnippet) || paragraphs[i].textContent.includes(gen.text)) {
                targetP = paragraphs[i];
                break;
            }
        }

        if (targetP) {
            targetP.insertAdjacentElement('afterend', lineDiv);
        } else {
            mesTextEl.appendChild(lineDiv);
        }

        bindLineEvents(gen, chatMsg);

        // Bind download button
        const dlBtn = document.getElementById(`${gen.playBtnId}-dl`);
        if (dlBtn) {
            dlBtn.addEventListener("click", async () => {
                let data = audioCache.get(gen.key);
                let blob = data?.blob;
                if (!blob && data?.url) {
                    // It's a server path, fetch it
                    try {
                        const resp = await fetch(data.url);
                        blob = await resp.blob();
                    } catch (err) { console.error(`${LOG} Fetch failed`, err); }
                }
                if (!blob) blob = await idbGet(gen.key);
                if (!blob) { toastr.warning("尚未生成音频", "GSVI TTS"); return; }

                // Sanitize filename parts: keep letters, numbers, underscores, and dashes
                const sanitize = (str) => (str || "").replace(/[^\p{L}\p{N}_-]/gu, "_").replace(/_{2,}/g, "_");
                const safeName = sanitize(gen.charName).substring(0, 20);
                const safeEmo = sanitize(gen.emotion).substring(0, 15);
                const safeText = sanitize(gen.text).substring(0, 10);

                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = `gsvi_${safeName}_${safeEmo}_${safeText}_${gen.key}.wav`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 5000);
            });
        }

        if (!gen.noVoice) {
            if (!gen.isCached) {
                triggerGeneration(gen, chatMsg);
            }
        } else {
            const btn = document.getElementById(gen.playBtnId);
            if (btn) {
                btn.classList.remove("gsvi-state-loading");
                btn.classList.add("gsvi-state-error");
                btn.innerHTML = "⚠";
                btn.title = `未配置角色 "${gen.charName}" 的语音`;
            }
        }
    }
}

function bindLineEvents(gen, chatMsg) {
    const playBtn = document.getElementById(gen.playBtnId);
    const regenBtn = document.getElementById(gen.regenBtnId);

    if (playBtn) {
        playBtn.addEventListener("click", () => {
            if (playBtn.classList.contains("gsvi-state-loading")) return;
            if (playBtn.classList.contains("gsvi-state-error")) return;

            if (playBtn.classList.contains("gsvi-state-playing")) {
                // Pause
                stopCurrentPlayback();
                return;
            }

            // Play
            const key = playBtn.dataset.cacheKey;
            if (key && audioCache.has(key)) {
                playAudioBlob(audioCache.get(key).url, gen.playBtnId);
            }
        });
    }

    if (regenBtn) {
        regenBtn.addEventListener("click", async () => {
            if (regenBtn.classList.contains("gsvi-spinning")) return;
            if (!gen.voiceId) {
                toastr.warning(`角色 "${gen.charName}" 未配置语音`);
                return;
            }

            // Remove from cache
            const oldKey = gen.key;
            if (oldKey) {
                if (audioCache.has(oldKey)) {
                    const data = audioCache.get(oldKey);
                    if (data.url && data.url.startsWith("blob:")) URL.revokeObjectURL(data.url);
                    audioCache.delete(oldKey);
                }
                await idbDelete(oldKey);
            }

            // Clear metadata for this key
            if (chatMsg && chatMsg.extra && chatMsg.extra.gsvi_tts && chatMsg.extra.gsvi_tts[oldKey]) {
                delete chatMsg.extra.gsvi_tts[oldKey];
                saveChatDebounced();
            }

            // Stop if currently playing this line
            if (currentPlayingBtnId === gen.playBtnId) {
                stopCurrentPlayback();
            }

            // Reset play button
            if (playBtn) {
                playBtn.classList.remove("gsvi-state-ready", "gsvi-state-error", "gsvi-state-playing");
                playBtn.classList.add("gsvi-state-loading");
                playBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
                playBtn.title = "生成中...";
            }

            // Disable download button
            const dlBtn = document.getElementById(`${gen.playBtnId}-dl`);
            if (dlBtn) {
                dlBtn.setAttribute("disabled", "true");
                dlBtn.style.opacity = "0.5";
                dlBtn.style.cursor = "not-allowed";
            }

            // Spin regen button
            regenBtn.classList.add("gsvi-spinning");

            triggerGeneration(gen, chatMsg).finally(() => {
                regenBtn.classList.remove("gsvi-spinning");
            });
        });
    }
}

async function triggerGeneration(gen, chatMsg) {
    try {
        const result = await generateWithCache(gen.text, gen.voiceId, gen.emotion, gen.langOverride);
        const btn = document.getElementById(gen.playBtnId);
        if (btn) {
            btn.dataset.cacheKey = result.key;
            btn.classList.remove("gsvi-state-loading");
            btn.classList.add("gsvi-state-ready");
            btn.innerHTML = '<i class="fa-solid fa-play"></i>';
            btn.title = "播放";
        }

        // Save server path to chat metadata
        if (result.serverPath && chatMsg) {
            if (!chatMsg.extra) chatMsg.extra = {};
            if (!chatMsg.extra.gsvi_tts) chatMsg.extra.gsvi_tts = {};
            chatMsg.extra.gsvi_tts[result.key] = result.serverPath;
            saveChatDebounced();
            console.log(`${LOG} Saved audio path to chat metadata: ${result.serverPath}`);
        }

        // Enable download button after generation completes
        const dlBtn = document.getElementById(`${gen.playBtnId}-dl`);
        if (dlBtn) {
            dlBtn.removeAttribute("disabled");
            dlBtn.style.opacity = "";
            dlBtn.style.cursor = "";
        }
    } catch (err) {
        console.error(`${LOG} Generation failed for "${gen.text.substring(0, 30)}...":`, err);
        const btn = document.getElementById(gen.playBtnId);
        if (btn) {
            btn.classList.remove("gsvi-state-loading");
            btn.classList.add("gsvi-state-error");
            btn.innerHTML = "⚠";
            btn.title = `生成失败: ${err.message}`;
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// Settings Panel UI
// ═══════════════════════════════════════════════════════════════

function buildSettingsHtml() {
    const s = getSettings();
    return `
    <div class="gsvi-settings-section">
        <div class="gsvi-settings-row">
            <label>API 端点</label>
            <input id="gsvi_endpoint" type="text" class="text_pole" value="${s.endpoint}" placeholder="http://localhost:8001" />
        </div>

        <div class="gsvi-settings-row">
            <label>API 格式</label>
            <select id="gsvi_api_format" class="text_pole">
                <option value="auto" ${s.apiFormat === "auto" ? "selected" : ""}>自动检测 (按端口)</option>
                <option value="adapter" ${s.apiFormat === "adapter" ? "selected" : ""}>Adapter (9881)</option>
                <option value="gsvi" ${s.apiFormat === "gsvi" ? "selected" : ""}>GSVI Inference (8000)</option>
            </select>
        </div>
        <div class="gsvi-settings-note">Adapter: 端口 9881，POST /。GSVI: 端口 8000，POST /v1/audio/speech。</div>

        <div class="gsvi-settings-row">
            <label>默认角色</label>
            <select id="gsvi_default_voice" class="text_pole" style="flex:1;min-width:0;">
                <option value="">点击获取按钮加载模型列表</option>
            </select>
            <button id="gsvi_fetch_voices" class="menu_button gsvi-fetch-btn">
                <i class="fa-solid fa-rotate"></i> 获取
            </button>
        </div>

        <div class="gsvi-settings-row">
            <label>语速</label>
            <div class="gsvi-slider-row">
                <input id="gsvi_speed" type="range" min="0.5" max="2.0" step="0.1" value="${s.speed}" />
                <span id="gsvi_speed_val" class="gsvi-slider-val">${s.speed}x</span>
            </div>
        </div>

        <div class="gsvi-settings-row">
            <label>文本语言</label>
            <select id="gsvi_text_lang" class="text_pole">
                ${["中文", "英语", "日语", "粤语", "韩语", "中英混合", "日英混合", "粤英混合", "韩英混合", "多语种混合", "多语种混合(粤语)"]
            .map(l => `<option value="${l}" ${s.textLang === l ? "selected" : ""}>${l}</option>`).join("")}
            </select>
        </div>

        <div class="gsvi-settings-row">
            <label>参考语言</label>
            <select id="gsvi_prompt_lang" class="text_pole">
                <option value="">(请先获取声音列表)</option>
            </select>
        </div>

        <div class="gsvi-settings-row">
            <label>默认情绪</label>
            <select id="gsvi_emotion" class="text_pole">
                <option value="">(请先获取声音列表)</option>
            </select>
        </div>

        <div class="gsvi-settings-row">
            <label>文本切分</label>
            <select id="gsvi_split_method" class="text_pole">
                ${["不切", "凑四句一切", "凑50字一切", "按中文句号。切", "按英文句号.切", "按标点符号切"]
            .map(m => `<option value="${m}" ${(s.textSplitMethod || "") === m ? "selected" : ""}>${m}</option>`).join("")}
            </select>
        </div>

        <div class="gsvi-settings-row">
            <label>Batch Size</label>
            <div class="gsvi-slider-row">
                <input id="gsvi_batch_size" type="range" min="1" max="100" step="1" value="${s.batchSize}" />
                <span id="gsvi_batch_size_val" class="gsvi-slider-val">${s.batchSize}</span>
            </div>
        </div>
        <hr />
        
        <div class="gsvi-settings-row">
            <span style="font-size:13px; font-weight:bold;">UI 与 交互</span>
        </div>
        <div class="gsvi-settings-row">
            <label>播放按钮主题色</label>
            <input id="gsvi_theme_color" type="color" value="${s.themeColor}" style="width: 40px; height: 24px; padding: 0; border: none; background: none; cursor: pointer;" />
        </div>
        <div class="gsvi-toggle-row">
            <label>保存音频到服务器</label>
            <input id="gsvi_save_to_server" type="checkbox" ${s.saveToServer ? "checked" : ""} />
        </div>

        <hr />
        
        <div class="gsvi-settings-row">
            <span style="font-size:13px; font-weight:bold;">提示词注入</span>
        </div>
        <div class="gsvi-toggle-row">
            <label>开启提示词注入</label>
            <input id="gsvi_inject_enabled" type="checkbox" ${s.injectEnabled ? "checked" : ""} />
        </div>
        <div class="gsvi-settings-row">
            <label>注入位置</label>
            <select id="gsvi_inject_position" class="text_pole">
                <option value="1" ${s.injectPosition == 1 ? "selected" : ""}>D0</option>
                <option value="2" ${s.injectPosition == 2 ? "selected" : ""}>指定深度</option>
            </select>
        </div>
        <div class="gsvi-settings-row" id="gsvi_depth_row" style="${s.injectPosition == 2 ? '' : 'display:none;'}">
            <label>注入深度 D</label>
            <input id="gsvi_inject_depth" type="number" class="text_pole" min="1" max="20" value="${s.injectDepth || 3}" style="width:70px;" />
        </div>
        <div class="gsvi-settings-actions">
            <button id="gsvi_open_prompt_modal" class="menu_button" style="background-color: var(--SmartThemeQuoteColor, #52a9af); color: white;">
                <i class="fa-solid fa-list-check"></i> 管理提示词
            </button>
            <button id="gsvi_open_char_mapping_modal" class="menu_button" style="background-color: #34d399; color: white;">
                <i class="fa-solid fa-user-tag"></i> 角色名映射
            </button>
        </div>

        <hr />
        
        <div class="gsvi-settings-row">
            <span style="font-size:13px; font-weight:bold;">试听设置</span>
        </div>
        <div class="gsvi-settings-row">
            <label>试听角色</label>
            <select id="gsvi_test_voice" class="text_pole">
                <option value="">(请先获取模型)</option>
            </select>
        </div>
        <div class="gsvi-settings-row">
            <label>试听情绪</label>
            <select id="gsvi_test_emotion" class="text_pole">
                <option value="">(无可用情绪)</option>
            </select>
        </div>

        <hr />

        <div class="gsvi-settings-actions">
            <button id="gsvi_save_settings" class="menu_button">
                <i class="fa-solid fa-save"></i> 保存设置
            </button>
            <button id="gsvi_test_btn" class="menu_button">
                <i class="fa-solid fa-play"></i> 试听
            </button>
            <button id="gsvi_clear_cache" class="menu_button">
                <i class="fa-solid fa-trash"></i> 清理缓存
            </button>
        </div>
    </div>`;
}

function bindSettingsEvents() {
    const s = getSettings();

    // Endpoint
    $("#gsvi_endpoint").on("change", function () {
        s.endpoint = $(this).val().trim();
        saveSettings();
    });

    // API format
    $("#gsvi_api_format").on("change", function () {
        s.apiFormat = $(this).val();
        saveSettings();
    });

    // Default Voice
    $("#gsvi_default_voice").on("change", function () {
        s.voiceId = $(this).val();
        const voice = fetchedVoices.find(v => v.id === s.voiceId) || s.cachedVoices.find(v => v.id === s.voiceId);
        if (voice && voice.version) {
            s.voiceVersion = voice.version;
        }
        saveSettings();
        updatePromptLangDropdown(s.voiceId);
        updateEmotionSelect(s.voiceId, "gsvi_emotion", "emotion");
    });

    // Test Voice
    $("#gsvi_test_voice").on("change", function () {
        s.testVoiceId = $(this).val();
        saveSettings();
        updateEmotionSelect(s.testVoiceId, "gsvi_test_emotion", "testEmotion");
    });

    // Fetch voices
    $("#gsvi_fetch_voices").on("click", async function () {
        const btn = $(this);
        btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> 获取中...');
        try {
            const voices = await fetchVoiceList();
            console.log(`${LOG} Fetched ${voices.length} voices.`);
            fetchedVoices = voices;
            // Cache voices in settings so they persist across reloads
            const s = getSettings();
            s.cachedVoices = voices;
            saveSettingsDebounced();

            toastr.success(`成功获取 ${voices.length} 个模型`, "GSVI TTS");

            // Rebuild setting UI for voices
            buildVoiceSelects();
        } catch (err) {
            console.error(`${LOG} fetchVoices error:`, err);
            toastr.error(err.message, "GSVI TTS");
        } finally {
            btn.prop("disabled", false).html('<i class="fa-solid fa-rotate"></i> 获取');
        }
    });

    // Speed slider
    $("#gsvi_speed").on("input", function () {
        const val = parseFloat($(this).val());
        s.speed = val;
        $("#gsvi_speed_val").text(`${val.toFixed(1)}x`);
        saveSettings();
    });

    // Text lang
    $("#gsvi_text_lang").on("change", function () {
        s.textLang = $(this).val();
        saveSettings();
    });

    // Prompt lang
    $("#gsvi_prompt_lang").on("change", function () {
        s.promptLang = $(this).val();
        updateEmotionSelect(s.voiceId, "gsvi_emotion", "emotion");
        saveSettings();
    });

    // Emotion
    $("#gsvi_emotion").on("change", function () {
        s.emotion = $(this).val();
        saveSettings();
    });

    // Test Emotion
    $("#gsvi_test_emotion").on("change", function () {
        s.testEmotion = $(this).val();
        saveSettings();
    });

    // Split method
    $("#gsvi_split_method").on("change", function () {
        s.textSplitMethod = $(this).val();
        saveSettings();
    });

    // Batch size slider
    $("#gsvi_batch_size").on("input", function () {
        const val = parseInt($(this).val(), 10);
        s.batchSize = val;
        $("#gsvi_batch_size_val").text(val);
        saveSettings();
    });

    // Save locally toggle
    $("#gsvi_save_to_server").on("change", function () {
        s.saveToServer = $(this).prop("checked");
        saveSettings();
    });

    // Test button
    $("#gsvi_test_btn").on("click", async function () {
        const btn = $(this);
        if (!s.voiceId) {
            toastr.warning("请先选择一个角色", "GSVI TTS");
            return;
        }
        btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> 生成中...');
        try {
            const result = await generateAudio(DEFAULT_PREVIEW_TEXT, s.voiceId, s.emotion || "默认");
            playAudioBlob(result.url, "gsvi_test_btn");
            toastr.success("试听播放中", "GSVI TTS");
        } catch (err) {
            console.error(`${LOG} Test playback error:`, err);
            toastr.error(err.message, "GSVI TTS");
        } finally {
            btn.prop("disabled", false).html('<i class="fa-solid fa-play"></i> 试听');
        }
    });

    // Inject position — toggle depth row visibility
    $("#gsvi_inject_position").on("change", function () {
        const pos = parseInt($(this).val(), 10);
        $("#gsvi_depth_row").toggle(pos === 2);
    });

    // Save button — read all current UI values
    $("#gsvi_save_settings").on("click", function () {
        readSettingsFromUI();
        toastr.success("设置已保存", "GSVI TTS");
    });

    // Send prompt button
    $("#gsvi_send_prompt_btn").on("click", function () {
        const text = $("#gsvi_prompt_guidance").val().trim();
        if (!text) return;

        // Use SillyTavern's slash command to send as system message or just inject into chat input
        // Since we want to send it directly, we can put it in the chat area
        $("#send_textarea").val(text);
        $("#send_but").click();

        toastr.success("已发送指导提示词", "GSVI TTS");
    });

    // Color picker realtime update
    $("#gsvi_theme_color").on("input", function () {
        document.documentElement.style.setProperty('--gsvi-theme-color', $(this).val());
    });

    // Prompt Manager Modal
    $("#gsvi_open_prompt_modal").on("click", function () {
        openPromptManagerModal();
    });

    // Character Mapping Modal
    $("#gsvi_open_char_mapping_modal").on("click", function () {
        openCharacterMappingModal();
    });

    $("#gsvi_clear_cache").on("click", function () {
        // Revoke all blob URLs
        for (const [, data] of audioCache) {
            if (data.url && data.url.startsWith("blob:")) URL.revokeObjectURL(data.url);
        }
        audioCache.clear();
        pendingGenerations.clear();
        stopCurrentPlayback();
        toastr.success(`缓存已清理`, "GSVI TTS");
    });
}

/**
 * Read all current values from the settings UI into the settings object.
 * Ensures settings are always in sync with what the user sees.
 */
function readSettingsFromUI() {
    const s = getSettings();
    s.endpoint = ($("#gsvi_endpoint").val() || "").trim();
    s.apiFormat = $("#gsvi_api_format").val() || "auto";
    s.voiceId = $("#gsvi_voice").val() || "";
    s.speed = parseFloat($("#gsvi_speed").val()) || 1.0;
    s.textLang = $("#gsvi_text_lang").val() || "多语种混合";
    s.promptLang = $("#gsvi_prompt_lang").val() || "";
    s.emotion = $("#gsvi_emotion").val() || "";
    s.textSplitMethod = $("#gsvi_split_method").val() || "按标点符号切";
    s.batchSize = parseInt($("#gsvi_batch_size").val(), 10) || 1;
    s.saveToServer = $("#gsvi_save_to_server").prop("checked");
    s.themeColor = $("#gsvi_theme_color").val() || "#52a9af";
    s.injectEnabled = $("#gsvi_inject_enabled").prop("checked");
    s.injectPosition = parseInt($("#gsvi_inject_position").val(), 10) || 0;
    s.injectDepth = parseInt($("#gsvi_inject_depth").val(), 10) || 3;

    // Apply theme
    applyThemeColor();

    // Update voice version from fetched data
    const voice = fetchedVoices.find(v => v.id === s.voiceId);
    if (voice && voice.version) {
        s.voiceVersion = voice.version;
    }

    saveSettings();
    return s;
}

function applyThemeColor() {
    const s = getSettings();
    if (s.themeColor) {
        document.documentElement.style.setProperty('--gsvi-theme-color', s.themeColor);
    }
}

function updatePromptLangDropdown(voiceId) {
    const s = getSettings();
    const sourceVoices = fetchedVoices.length > 0 ? fetchedVoices : (s.cachedVoices || []);
    const voice = sourceVoices.find(v => v.id === voiceId);
    if (!voice) return;

    // Update prompt lang dropdown
    const promptLangSelect = $("#gsvi_prompt_lang");
    promptLangSelect.empty();
    if (voice.promptLangs && voice.promptLangs.length > 0) {
        for (const lang of voice.promptLangs) {
            promptLangSelect.append(`<option value="${lang}" ${s.promptLang === lang ? "selected" : ""}>${lang}</option>`);
        }
        // Set first if not already set
        if (!s.promptLang || !voice.promptLangs.includes(s.promptLang)) {
            s.promptLang = voice.promptLangs[0];
            promptLangSelect.val(s.promptLang);
            saveSettings();
        }
    } else {
        promptLangSelect.append('<option value="">(无)</option>');
    }
}

function updateEmotionSelect(voiceId, selectId, settingKey) {
    const s = getSettings();
    const allVoices = fetchedVoices.length > 0 ? fetchedVoices : (s.cachedVoices || []);
    const voice = allVoices.find(v => v.id === voiceId);

    const emotionSelect = $(`#${selectId}`);
    emotionSelect.empty();

    let emotions = [];
    if (voice) {
        if (voice.emotionsMap && s.promptLang && voice.emotionsMap[s.promptLang]) {
            emotions = voice.emotionsMap[s.promptLang];
        } else if (voice.emotions) {
            emotions = voice.emotions;
        }
    }

    if (emotions.length > 0) {
        for (const em of emotions) {
            emotionSelect.append(`<option value="${em}" ${s[settingKey] === em ? "selected" : ""}>${em}</option>`);
        }
    } else {
        emotionSelect.append('<option value="">(无可用情绪)</option>');
    }
}

// ═══════════════════════════════════════════════════════════════
// Event Handlers
// ═══════════════════════════════════════════════════════════════

function buildVoiceSelects() {
    const s = getSettings();
    const voices = fetchedVoices.length > 0 ? fetchedVoices : (s.cachedVoices || []);

    const defaultVoiceSelect = $("#gsvi_default_voice");
    const testVoiceSelect = $("#gsvi_test_voice");

    defaultVoiceSelect.empty();
    testVoiceSelect.empty();

    if (voices.length === 0) {
        defaultVoiceSelect.append('<option value="">(请先获取模型)</option>');
        testVoiceSelect.append('<option value="">(请先获取模型)</option>');
        return;
    }

    // Sort voices by name
    voices.sort((a, b) => a.name.localeCompare(b.name));

    for (const v of voices) {
        const displayName = v.name; // API already includes version in name (e.g. "角色 [v4]")

        defaultVoiceSelect.append(`<option value="${v.id}" ${s.voiceId === v.id ? "selected" : ""}>${displayName}</option>`);
        testVoiceSelect.append(`<option value="${v.id}" ${s.testVoiceId === v.id ? "selected" : ""}>${displayName}</option>`);
    }

    if (!s.voiceId || !voices.find(v => v.id === s.voiceId)) {
        s.voiceId = voices[0].id;
        s.voiceVersion = voices[0].version;
        defaultVoiceSelect.val(s.voiceId);
        saveSettings();
    }

    updatePromptLangDropdown(s.voiceId);
    updateEmotionSelect(s.voiceId, "gsvi_emotion", "emotion");
    updateEmotionSelect(s.testVoiceId, "gsvi_test_emotion", "testEmotion");
}

function onMessageRendered(messageId) {
    const s = getSettings();
    if (!s.enabled) return;

    const context = getContext();
    if (!context || !context.chat) return;

    let chatMsg = null;
    if (context.chat[messageId]) {
        chatMsg = context.chat[messageId];
    } else {
        const numId = parseInt(messageId, 10);
        if (!isNaN(numId) && context.chat[numId]) chatMsg = context.chat[numId];
    }

    // Find the message element by mesid
    const mesElement = document.querySelector(`div.mes[mesid="${messageId}"]`);
    if (!mesElement) return;

    processMessageElement(mesElement, chatMsg);
}

// ═══════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════

jQuery(async () => {
    console.log(`${LOG} Extension loading...`);

    // Init settings
    getSettings();
    applyThemeColor();

    // Build and inject settings panel
    const settingsHtml = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>GSVI Inline TTS</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                ${buildSettingsHtml()}
            </div>
        </div>`;

    $("#extensions_settings").append(settingsHtml);

    // Bind settings events
    bindSettingsEvents();

    // Load default prompt from file and update settings if still using factory default
    loadDefaultPromptFromFile();

    // Listen for message render events
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onMessageRendered);
    eventSource.on(event_types.MESSAGE_UPDATED, onMessageRendered);

    // Process existing messages on chat load
    eventSource.on(event_types.CHAT_CHANGED, () => {
        // Small delay to let messages render
        setTimeout(() => {
            const context = getContext();
            document.querySelectorAll("div.mes").forEach(mes => {
                const mesId = mes.getAttribute("mesid");
                let chatMsg = null;
                if (context && context.chat) {
                    chatMsg = context.chat[mesId] || context.chat[parseInt(mesId, 10)];
                }
                processMessageElement(mes, chatMsg);
            });
        }, 500);
    });

    console.log(`${LOG} Extension loaded.`);
});

// ═══════════════════════════════════════════════════════════════
// Default Prompt File Loader
// ═══════════════════════════════════════════════════════════════

/**
 * Fetches default_prompt.txt from the extension folder and uses its content
 * as the default prompt entry. Only updates settings if the promptList only
 * has one entry and it matches the original factory default name
 * (i.e., the user hasn't customized it yet).
 */
async function loadDefaultPromptFromFile() {
    try {
        const scriptUrl = import.meta.url;
        const extDir = scriptUrl.substring(0, scriptUrl.lastIndexOf('/'));
        const url = `${extDir}/default_prompt.txt`;
        const resp = await fetch(url, { cache: "no-store" });
        if (!resp.ok) {
            console.warn(`${LOG} default_prompt.txt not found (${resp.status})`);
            return;
        }
        const content = await resp.text();
        const s = getSettings();

        // Only auto-apply if the user has exactly 1 prompt entry and it's the factory default
        const isDefaultOnly = s.promptList.length === 1 &&
            (s.promptList[0].name === "Default Formatting" || s.promptList[0].name === "默认提示词");

        if (isDefaultOnly) {
            s.promptList[0].content = content.trim();
            // Don't save — content is ephemeral from file; user can save explicitly
            console.log(`${LOG} Default prompt loaded from file.`);
        }
    } catch (err) {
        console.warn(`${LOG} Failed to load default_prompt.txt:`, err);
    }
}


// ═══════════════════════════════════════════════════════════════
// Prompt Injection Modal & Logic
// ═══════════════════════════════════════════════════════════════

function openPromptManagerModal() {
    const s = getSettings();
    // Don't overwrite saved prompt list; only initialize if completely missing
    if (!s.promptList || !Array.isArray(s.promptList)) {
        s.promptList = structuredClone(defaultSettings.promptList);
    }

    // Remove old if exists
    $("#gsvi-custom-modal").remove();

    let listHtml = "";
    s.promptList.forEach((p) => {
        listHtml += createPromptItemHtml(p.id, p.name, p.content);
    });

    // Build Reference Panel Data
    const voices = fetchedVoices.length > 0 ? fetchedVoices : (s.cachedVoices || []);

    // Build per-character + per-emotion grouped HTML for the generator panel
    let genPanelHtml = "";

    if (voices.length === 0) {
        genPanelHtml = "<div style='opacity:0.5; font-size:11px;'>尚未获取模型，请先点击「获取」按钮</div>";
    } else {
        for (const v of voices) {
            // Use mapped character name if available, otherwise strip bracketed strings like "[v4]" from the character name for display and selection
            let charName = (s.characterVoices && s.characterVoices[v.id]) || (v.name || v.id).replace(/\s*\[.*?\]/g, "").trim();

            // Collect this voice's emotions
            let emoList = [];
            if (v.emotionsMap) {
                for (const list of Object.values(v.emotionsMap)) {
                    for (const e of list) {
                        if (e && !emoList.includes(e)) emoList.push(e);
                    }
                }
            } else if (v.emotions) {
                emoList = [...v.emotions];
            }

            const emoChips = emoList.length > 0
                ? emoList.map(e => `<div class="gsvi-chip emo-chip" data-char="${charName}" data-val="${e}">${e}</div>`).join("")
                : `<span style="font-size:11px;opacity:0.5;">（无情感数据）</span>`;

            genPanelHtml += `
                <div class="gsvi-char-group" style="margin-bottom:12px;">
                    <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                        <div class="gsvi-chip char-chip" data-val="${charName}" style="margin:0;">${charName}</div>
                    </div>
                    <div class="gsvi-char-emo-list" style="padding-left:8px; border-left: 2px solid rgba(255,255,255,0.1);">${emoChips}</div>
                </div>
            `;
        }
    }

    const modalHtml = `
        <div id="gsvi-custom-modal" class="gsvi-modal-backdrop">
            <div class="gsvi-modal-container gsvi-prompt-manager-modal">
                <div class="gsvi-modal-header">
                    <h3 class="gsvi-modal-title">GSVI TTS 提示词管理器</h3>
                    <button class="gsvi-modal-close" id="gsvi-modal-close-btn"><i class="fa-solid fa-times"></i></button>
                </div>
                
                <div class="gsvi-modal-body">
                    <!-- Left: Prompt List -->
                    <div class="gsvi-prompt-list-section">
                        <div class="gsvi-prompt-list-header">
                            <div class="gsvi-prompt-list-note">自上而下注入。</div>
                            <div class="gsvi-prompt-list-actions">
                                <button id="gsvi-prompt-add" class="menu_button gsvi-action-btn">
                                    <i class="fa-solid fa-plus"></i> 添加条目
                                </button>
                                <button id="gsvi-prompt-insert-default" class="menu_button gsvi-action-btn secondary" title="插入默认提示词">
                                    <i class="fa-solid fa-file-import"></i> 默认提示词
                                </button>
                            </div>
                        </div>
                        <div id="gsvi-prompt-list" class="gsvi-prompt-list-container">
                            ${listHtml}
                        </div>
                    </div>
                    
                    <!-- Right: Reference & Generator Panel -->
                    <div class="gsvi-reference-panel">
                        <h4 class="gsvi-generator-title">提示词生成器</h4>
                        <div class="gsvi-generator-note">点选角色（蓝）和情感（黄），然后点击下方按钮生成。</div>
                        
                        <div id="gsvi-generator-panel" class="gsvi-generator-list">
                            ${genPanelHtml}
                        </div>

                        <button id="gsvi-prompt-generate" class="menu_button gsvi-generator-btn">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> 生成角色情感提示词
                        </button>
                    </div>
                </div>
                
                <div class="gsvi-modal-footer">
                    <button id="gsvi-modal-cancel" class="menu_button gsvi-modal-btn gsvi-modal-btn-secondary">取消</button>
                    <button id="gsvi-modal-save" class="menu_button gsvi-modal-btn gsvi-modal-btn-primary">保存修改</button>
                </div>
            </div>
        </div>
    `;

    $("body").append(modalHtml);

    // Chip selection — char chips toggle blue, emo chips toggle amber
    $("#gsvi-custom-modal .char-chip").on("click", function () {
        $(this).toggleClass("selected");
        $(this).css({
            "background": $(this).hasClass("selected") ? "var(--gsvi-theme-color)" : "rgba(255,255,255,0.05)",
            "color": $(this).hasClass("selected") ? "#fff" : ""
        });
    });

    $("#gsvi-custom-modal .emo-chip").on("click", function () {
        $(this).toggleClass("selected");
        $(this).css({
            "background": $(this).hasClass("selected") ? "rgba(245,158,11,0.8)" : "rgba(255,255,255,0.05)",
            "color": $(this).hasClass("selected") ? "#000" : ""
        });
    });

    // Auto-Generate logic
    $("#gsvi-prompt-generate").on("click", function () {
        const selectedChars = [];
        $("#gsvi-generator-panel .char-chip.selected").each((_, el) => selectedChars.push($(el).data("val")));

        if (selectedChars.length === 0) {
            toastr.warning("请至少选择一个角色（点击角色名标签）", "GSVI TTS");
            return;
        }

        // Per-character emotion map from selection
        const charEmoMap = {};
        selectedChars.forEach(c => { charEmoMap[c] = []; });

        $("#gsvi-generator-panel .emo-chip.selected").each((_, el) => {
            const charAttr = $(el).data("char");
            const emoVal = $(el).data("val");
            if (charAttr && charEmoMap[charAttr] !== undefined) {
                charEmoMap[charAttr].push(emoVal);
            }
        });

        // Build content string
        let genContent = "Voice character availability:\n";
        for (const [char, emos] of Object.entries(charEmoMap)) {
            if (emos.length > 0) {
                genContent += `- ${char}: ${emos.join(", ")}\n`;
            } else {
                genContent += `- ${char}\n`;
            }
        }
        genContent += "Only use characters and emotions listed above.";

        const newId = Date.now().toString();
        $("#gsvi-prompt-list").append(createPromptItemHtml(newId, "可用角色情感映射", genContent));
        initDragAndDrop();

        const listDiv = document.getElementById("gsvi-prompt-list");
        listDiv.scrollTop = listDiv.scrollHeight;
    });

    // Close Modal Events
    const closeModal = () => {
        const modal = $("#gsvi-custom-modal");
        modal.find(".gsvi-modal-container").css("animation", "gsvi-slide-up 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275) reverse");
        modal.css("animation", "gsvi-fade-in 0.2s ease-out reverse");
        setTimeout(() => modal.remove(), 180);
    };

    $("#gsvi-modal-close-btn, #gsvi-modal-cancel").on("click", closeModal);
    $("#gsvi-custom-modal").on("click", function (e) {
        if (e.target === this) closeModal();
    });

    // Save Logic
    $("#gsvi-modal-save").on("click", function () {
        const newList = [];
        $("#gsvi-prompt-list .gsvi-prompt-item").each((_, el) => {
            const id = $(el).data("id") || Date.now().toString();
            const name = $(el).find(".gsvi-prompt-name").val() || "Untitled";
            const content = $(el).find(".gsvi-prompt-content").val() || "";
            if (content.trim()) {
                newList.push({ id, name, content });
            }
        });
        s.promptList = newList;
        saveSettingsDebounced();
        applyPromptInjection();
        // Show success, but keep modal open for continued editing
        toastr.success("提示词已保存生效", "GSVI TTS");
    });

    // Handle Add Button
    $("#gsvi-prompt-add").on("click", function () {
        const newId = Date.now().toString();
        $("#gsvi-prompt-list").append(createPromptItemHtml(newId, "New Prompt", ""));
        initDragAndDrop();
    });

    // Handle Insert Default Button
    $("#gsvi-prompt-insert-default").on("click", async function () {
        try {
            const scriptUrl = import.meta.url;
            const extDir = scriptUrl.substring(0, scriptUrl.lastIndexOf('/'));
            const url = `${extDir}/default_prompt.txt`;
            const resp = await fetch(url, { cache: "no-store" });
            if (!resp.ok) { toastr.error("读取默认提示词文件失败", "GSVI"); return; }
            const content = await resp.text();
            const newId = Date.now().toString();
            $("#gsvi-prompt-list").append(createPromptItemHtml(newId, "Default Formatting", content.trim()));
            initDragAndDrop();
        } catch (err) {
            console.error(`${LOG} Failed to load default_prompt.txt:`, err);
        }
    });

    // Handle Delete — delegate to the list container, not a non-existent #gsvi-prompt-manager
    $("#gsvi-prompt-list").on("click", ".gsvi-prompt-del", function () {
        $(this).closest(".gsvi-prompt-item").remove();
    });

    // Add drag and drop logic
    initDragAndDrop();
}

function createPromptItemHtml(id, name, content) {
    return `
        <div class="gsvi-glass-item gsvi-prompt-item" data-id="${id}">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <i class="fa-solid fa-grip-vertical gsvi-drag-handle" style="cursor: grab; color: rgba(255,255,255,0.4); font-size: 16px;"></i>
                    <input type="text" class="gsvi-glass-input gsvi-prompt-name" value="${name.replace(/"/g, '&quot;')}" placeholder="Name" style="font-weight: bold; width: 160px;" />
                </div>
                <button class="menu_button gsvi-prompt-del" title="删除" style="padding: 6px 10px; min-width: auto; background: rgba(220, 38, 38, 0.2); border: 1px solid rgba(220,38,38,0.4); border-radius: 6px; color: #fca5a5;"><i class="fa-solid fa-trash"></i></button>
            </div>
            <textarea class="gsvi-glass-input gsvi-prompt-content" placeholder="输入提示词内容..." style="width: 100%; height: 85px; resize: vertical;">${content.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</textarea>
        </div>
    `;
}

function initDragAndDrop() {
    const list = document.getElementById('gsvi-prompt-list');
    if (!list) return;

    // Sortable may be available globally in SillyTavern UI
    if (typeof Sortable !== 'undefined') {
        Sortable.create(list, {
            handle: '.gsvi-drag-handle',
            animation: 150
        });
    }
}

// ═══════════════════════════════════════════════════════════════
// Character Mapping Modal
// ═══════════════════════════════════════════════════════════════

function openCharacterMappingModal() {
    const s = getSettings();
    const voices = fetchedVoices.length > 0 ? fetchedVoices : (s.cachedVoices || []);

    if (voices.length === 0) {
        toastr.warning("尚未获取模型，请先点击「获取」按钮", "GSVI TTS");
        return;
    }

    $("#gsvi-mapping-modal").remove();

    let listHtml = "";
    voices.sort((a, b) => a.name.localeCompare(b.name)).forEach((v) => {
        const mappedName = (s.characterVoices && s.characterVoices[v.id]) || "";
        listHtml += `
            <div class="gsvi-glass-item" style="padding: 8px 12px; display: flex; align-items: center; gap: 12px;">
                <div style="flex: 1; min-width: 0;">
                    <div style="font-size: 13px; font-weight: bold; opacity: 0.9;">${v.name}</div>
                    <div style="font-size: 11px; opacity: 0.6;">ID: ${v.id}</div>
                </div>
                <div style="flex: 1;">
                    <input type="text" class="gsvi-glass-input gsvi-mapping-name" 
                        data-voice-id="${v.id}" 
                        value="${mappedName.replace(/"/g, '&quot;')}" 
                        placeholder="映射角色名 (如: 李四)" 
                        style="width: 100%; font-size: 12px;" />
                </div>
            </div>
        `;
    });

    const modalHtml = `
        <div id="gsvi-mapping-modal" class="gsvi-modal-backdrop">
            <div class="gsvi-modal-container" style="max-width: 600px; width: 90%;">
                <div class="gsvi-modal-header">
                    <h3 class="gsvi-modal-title">角色名 - 模型名映射</h3>
                    <button class="gsvi-modal-close" id="gsvi-mapping-close-btn"><i class="fa-solid fa-times"></i></button>
                </div>
                <div class="gsvi-modal-body" style="flex-direction: column;">
                    <div style="font-size: 12px; opacity: 0.7; margin-bottom: 12px;">
                        为模型映射一个自定义角色名。在 &lt;tts char="李四"&gt; 中使用该名称时，将自动调用对应的模型。
                    </div>
                    <div id="gsvi-mapping-list" style="overflow-y: auto; flex: 1; padding-right: 8px;">
                        ${listHtml}
                    </div>
                </div>
                <div class="gsvi-modal-footer">
                    <button id="gsvi-mapping-cancel" class="menu_button gsvi-modal-btn gsvi-modal-btn-secondary">取消</button>
                    <button id="gsvi-mapping-save" class="menu_button gsvi-modal-btn gsvi-modal-btn-primary">保存修改</button>
                </div>
            </div>
        </div>
    `;

    $("body").append(modalHtml);

    const closeModal = () => $("#gsvi-mapping-modal").remove();
    $("#gsvi-mapping-close-btn, #gsvi-mapping-cancel").on("click", closeModal);
    $("#gsvi-mapping-modal").on("click", function (e) { if (e.target === this) closeModal(); });

    $("#gsvi-mapping-save").on("click", function () {
        const mappings = {};
        $("#gsvi-mapping-list .gsvi-mapping-name").each((_, el) => {
            const voiceId = $(el).data("voice-id");
            const mappedName = $(el).val().trim();
            if (mappedName) {
                mappings[voiceId] = mappedName;
            }
        });
        s.characterVoices = mappings;
        saveSettingsDebounced();
        toastr.success("角色映射已保存", "GSVI TTS");
        closeModal();
    });
}

// ═══════════════════════════════════════════════════════════════
// Persistent Audio Storage (IndexedDB)
// ═══════════════════════════════════════════════════════════════

const IDB_NAME = "gsvi_tts_cache";
const IDB_STORE = "audio";
let _idb = null;

async function openIDB() {
    if (_idb) return _idb;
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = (e) => {
            e.target.result.createObjectStore(IDB_STORE);
        };
        req.onsuccess = (e) => { _idb = e.target.result; resolve(_idb); };
        req.onerror = (e) => reject(e.target.error);
    });
}

async function idbGet(key) {
    try {
        const db = await openIDB();
        return new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, "readonly");
            const req = tx.objectStore(IDB_STORE).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
    } catch { return null; }
}

async function idbSet(key, blob) {
    try {
        const db = await openIDB();
        return new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, "readwrite");
            tx.objectStore(IDB_STORE).put(blob, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    } catch { }
}

async function idbDelete(key) {
    try {
        const db = await openIDB();
        return new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, "readwrite");
            tx.objectStore(IDB_STORE).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    } catch { }
}

/**
 * Warm the in-memory audio cache from IndexedDB for a given set of keys.
 * Called after messages are rendered to pre-load previously generated audio.
 */
async function warmCacheFromIDB(keys) {
    for (const key of keys) {
        if (audioCache.has(key)) continue;
        const blob = await idbGet(key);
        if (blob) {
            const url = URL.createObjectURL(blob);
            audioCache.set(key, { blob, url });
            console.debug(`${LOG} Loaded from IDB: ${key}`);
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// Prompt Injection — via generate_interceptor
// ═══════════════════════════════════════════════════════════════

/**
 * Called by SillyTavern before each generation.
 * Injects the enabled prompt list into the chat array.
 */
globalThis.gsviTtsPromptInterceptor = async function (chat, contextSize, abort, type) {
    const s = getSettings();
    if (!s.injectEnabled || !s.promptList || s.promptList.length === 0) return;

    const combinedContent = s.promptList
        .map(p => p.content.trim())
        .filter(Boolean)
        .join("\n\n");

    if (!combinedContent) return;

    const injectedMsg = {
        is_user: false,
        is_system: true,
        name: "GSVI TTS",
        send_date: Date.now(),
        mes: combinedContent,
    };

    if (s.injectPosition === 0) {
        // System Prompt — prepend before any AI messages
        chat.unshift(injectedMsg);
    } else if (s.injectPosition === 1) {
        // Before Chat (Depth 0) — just before the last user message
        chat.splice(chat.length - 1, 0, injectedMsg);
    } else if (s.injectPosition === 2) {
        // In Chat at specified depth D
        const depth = Math.max(1, s.injectDepth || 3);
        const insertAt = Math.max(0, chat.length - depth);
        chat.splice(insertAt, 0, injectedMsg);
    }

    console.debug(`${LOG} Injected TTS prompt [position=${s.injectPosition}]`);
};

// Keep applyPromptInjection as a no-op stub for compatibility
// (called from the modal save button — injection now happens via interceptor)
function applyPromptInjection() {
    // No-op: injection handled by gsviTtsPromptInterceptor
}
