/**
 * GSVI Inline TTS Extension for SillyTavern
 * Detects <tts char="..." emotion="..."> tags in chat messages,
 * generates audio via GPT-SoVITS API, and renders inline play buttons.
 */

import { getContext } from "../../../extensions.js";
import { eventSource, event_types } from "../../../../script.js";

import { LOG, SETTINGS_KEY } from "./modules/constants.js";
import { resolveUrl } from "./modules/utils.js";
import { getSettings } from "./modules/settings.js";
import { setFetchedVoices } from "./modules/api.js";
import { audioCache } from "./modules/cache.js";
import { stopCurrentPlayback, processMessageElement } from "./modules/renderer.js";
import { buildSettingsHtml, bindSettingsEvents, applyThemeColor } from "./modules/ui.js";

// ═══════════════════════════════════════════════════════════════
// Runtime State (Moved to modules/cache.js, api.js, renderer.js)
// ═══════════════════════════════════════════════════════════════

/*
const audioCache = new Map();

/** @type {Map<string, Promise>} hash → pending generation promise */
/*const pendingGenerations = new Map();
let currentGenerations = 0;
let fetchedVoices = [];
let currentAudio = null;
let currentPlayingBtnId = null;*/


// ═══════════════════════════════════════════════════════════════
// Settings Management (Moved to modules/settings.js)
// ═══════════════════════════════════════════════════════════════

/*
function getSettings() { ... }
function saveSettings() { ... }
*/

// ═══════════════════════════════════════════════════════════════
// API Format Detection (Moved to modules/utils.js)
// ═══════════════════════════════════════════════════════════════

/*
function detectFormat(endpoint, override) { ... }
function resolveUrl(url) { ... }
*/

// ═══════════════════════════════════════════════════════════════
// TTS API (Moved to modules/api.js)
// ═══════════════════════════════════════════════════════════════

/*
async function fetchVoicesAdapter(endpoint) { ... }
async function fetchVoicesGSVI(endpoint) { ... }
async function fetchVoiceList() { ... }
async function synthesizeAdapter(text, endpoint, settings) { ... }
async function synthesizeGSVI(text, endpoint, settings) { ... }
async function generateAudio(text, voiceId, emotion, langOverride) { ... }
*/

// ═══════════════════════════════════════════════════════════════
// Audio Cache & Generation (Moved to modules/cache.js)
// ═══════════════════════════════════════════════════════════════

/*
function hashKey(text, voiceId, emotion) { ... }
async function generateWithCache(text, voiceId, emotion, langOverride) { ... }
*/

// ═══════════════════════════════════════════════════════════════
// Server Upload (Moved to modules/utils.js)
// ═══════════════════════════════════════════════════════════════

/*
async function uploadAudioToST(blob, text, voiceId, emotion) { ... }
*/

// ═══════════════════════════════════════════════════════════════
// Audio Playback (Moved to modules/renderer.js)
// ═══════════════════════════════════════════════════════════════

/*
function stopCurrentPlayback() { ... }
function playAudioBlob(blobUrl, playBtnId) { ... }
*/

// ═══════════════════════════════════════════════════════════════
// Message Parsing & DOM Rendering (Moved to modules/renderer.js)
// ═══════════════════════════════════════════════════════════════

/*
let lineCounter = 0;
function resolveVoiceForChar(charName) { ... }
async function processMessageElement(mesElement, chatMsg) { ... }
function bindLineEvents(gen, chatMsg) { ... }
async function triggerGeneration(gen, chatMsg) { ... }
*/

// ═══════════════════════════════════════════════════════════════
// Settings Panel UI & Modals (Moved to modules/ui.js)
// ═══════════════════════════════════════════════════════════════

/*
function buildSettingsHtml() { ... }
function bindSettingsEvents() { ... }
function readSettingsFromUI() { ... }
function applyThemeColor() { ... }
function updatePromptLangDropdown(voiceId) { ... }
function updateEmotionSelect(voiceId, selectId, settingKey) { ... }
function buildVoiceSelects() { ... }
function openPromptManagerModal() { ... }
function openCharacterMappingModal() { ... }
*/

// ═══════════════════════════════════════════════════════════════
// Persistent Audio Storage (Moved to modules/cache.js)
// ═══════════════════════════════════════════════════════════════

/*
async function openIDB() { ... }
async function idbGet(key) { ... }
async function idbSet(key, blob) { ... }
async function idbDelete(key) { ... }
async function warmCacheFromIDB(keys) { ... }
*/

// ═══════════════════════════════════════════════════════════════
// Event Handlers
// ═══════════════════════════════════════════════════════════════

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
    const s = getSettings();
    applyThemeColor();
    
    // Set cached voices into API state if they exist
    if (s.cachedVoices) {
        setFetchedVoices(s.cachedVoices);
    }

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
            console.log(`${LOG} Default prompt loaded from file.`);
        }
    } catch (err) {
        console.warn(`${LOG} Failed to load default_prompt.txt:`, err);
    }
}

// ═══════════════════════════════════════════════════════════════
// Prompt Injection — via generate_interceptor
// ═══════════════════════════════════════════════════════════════

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
        chat.unshift(injectedMsg);
    } else if (s.injectPosition === 1) {
        chat.splice(chat.length - 1, 0, injectedMsg);
    } else if (s.injectPosition === 2) {
        const depth = Math.max(1, s.injectDepth || 3);
        const insertAt = Math.max(0, chat.length - depth);
        chat.splice(insertAt, 0, injectedMsg);
    }

    console.debug(`${LOG} Injected TTS prompt [position=${s.injectPosition}]`);
};
