/**
 * GSVI Inline TTS Extension Constants and Default Settings
 */

export const EXT_NAME = "GSVI-Extension";
export const SETTINGS_KEY = "gsvi_inline_tts";
export const LOG = "[GSVI-TTS]";

export const TTS_TAG_REGEX = /<tts\s+char="([^"]+)"\s+emotion="([^"]*?)"(?:\s+lang="([^"]*?)")?\s*>([\s\S]*?)<\/tts>/gi;
export const DEFAULT_PREVIEW_TEXT = "你好呀，这是一段试听文本。今天天气真好！";

export const defaultSettings = {
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
