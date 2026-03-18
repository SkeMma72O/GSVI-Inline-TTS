/**
 * GSVI Inline TTS Extension Settings Management
 */

import { extension_settings } from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";
import { SETTINGS_KEY, defaultSettings } from "./constants.js";

/**
 * Get extension settings.
 * @returns {object}
 */
export function getSettings() {
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

/**
 * Save extension settings.
 */
export function saveSettings() {
    saveSettingsDebounced();
}
