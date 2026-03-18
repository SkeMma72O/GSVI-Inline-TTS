/**
 * GSVI Inline TTS Extension Message Parsing and DOM Rendering
 */

import { saveChatDebounced } from "../../../../../script.js";
import { LOG, TTS_TAG_REGEX } from "./constants.js";
import { getSettings } from "./settings.js";
import { resolveUrl, hashKey } from "./utils.js";
import { fetchedVoices } from "./api.js";
import { audioCache, idbGet, idbDelete, warmCacheFromIDB, generateWithCache } from "./cache.js";

/** @type {Audio|null} */
export let currentAudio = null;
export let currentPlayingBtnId = null;

let lineCounter = 0;

export function stopCurrentPlayback() {
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
            btn.innerHTML = '<i class="fa-solid fa-play"></i>';
            btn.title = "播放";
        }
        currentPlayingBtnId = null;
    }
}

export function playAudioBlob(blobUrl, playBtnId) {
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

export async function processMessageElement(mesElement, chatMsg) {
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
                        const resp = await fetch(resolveUrl(data.url));
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
