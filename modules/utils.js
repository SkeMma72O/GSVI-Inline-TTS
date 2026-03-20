/**
 * GSVI Inline TTS Extension Utility Functions
 */

import { LOG } from './constants.js';

/**
 * Auto-detect API format based on endpoint port or explicit setting.
 * @param {string} endpoint 
 * @param {string} override 
 * @returns {string} 'adapter' | 'gsvi'
 */
export function detectFormat(endpoint, override) {
    if (override === "adapter" || override === "gsvi") return override;
    try {
        const url = new URL(endpoint);
        if (url.port === "8000") return "gsvi";
    } catch { /* ignore */ }
    return "adapter";
}

/**
 * 当 HTTPS 页面访问 HTTP 端点时（Mixed Content），走 ST 内置 CORS proxy。
 * @param {string} url - 原始 HTTP URL
 * @returns {string} 可能被改写为 /proxy/ 路径 of the URL
 */
export function resolveUrl(url) {
    if (window.location.protocol === "https:" && url.startsWith("http:")) {
        return `/proxy/${url}`;
    }
    return url;
}

/**
 * Generate a unique hash key for a given text, voice, and emotion.
 * @param {string} text 
 * @param {string} voiceId 
 * @param {string} emotion 
 * @returns {string}
 */
export function hashKey(text, voiceId, emotion) {
    const str = `${text}|${voiceId}|${emotion}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
}

/**
 * Upload an audio blob to SillyTavern's /api/files/upload endpoint.
 * @param {Blob} blob
 * @param {string} text
 * @param {string} voiceId
 * @param {string} emotion
 * @returns {Promise<string>} server-side web path
 */
export async function uploadAudioToST(blob, text, voiceId, emotion) {
    const base64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(',')[1]);
        reader.readAsDataURL(blob);
    });

    const ext = blob.type.includes('mp3') || blob.type.includes('mpeg') ? 'mp3' : 'wav';

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
