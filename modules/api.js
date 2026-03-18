/**
 * GSVI Inline TTS Extension API Communication
 */

import { LOG } from "./constants.js";
import { getSettings } from "./settings.js";
import { detectFormat, resolveUrl } from "./utils.js";

/** @type {Array<{ id: string, name: string, language: string, emotions?: string[], promptLangs?: string[], emotionsMap?: object, version?: string }>} */
export let fetchedVoices = [];

export function setFetchedVoices(voices) {
    fetchedVoices = voices;
}

async function fetchVoicesAdapter(endpoint) {
    const tryPaths = ["/speakers", "/speakers_list", "/character_list"];
    for (const path of tryPaths) {
        try {
            const resp = await fetch(resolveUrl(`${endpoint}${path}`));
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
            const resp = await fetch(resolveUrl(`${endpoint}/models/${version}`));
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

/**
 * Fetch list of available voices from the API.
 * @returns {Promise<Array>}
 */
export async function fetchVoiceList() {
    const s = getSettings();
    const endpoint = s.endpoint.replace(/\/$/, "");
    const format = detectFormat(endpoint, s.apiFormat);

    console.log(`${LOG} Fetching voices: format=${format}, endpoint=${endpoint}`);

    let voices = [];
    if (format === "adapter") {
        voices = await fetchVoicesAdapter(endpoint);
    } else {
        voices = await fetchVoicesGSVI(endpoint);
    }
    fetchedVoices = voices;
    return voices;
}

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

    const resp = await fetch(resolveUrl(`${endpoint}/`), {
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

    const resp = await fetch(resolveUrl(`${endpoint}/v1/audio/speech`), {
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
 * @param {string} [langOverride]
 * @returns {Promise<{ blob: Blob, url: string }>}
 */
export async function generateAudio(text, voiceId, emotion, langOverride) {
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
