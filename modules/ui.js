/**
 * GSVI Inline TTS Extension UI and Interactivity
 */

import { saveSettingsDebounced } from '../../../../../script.js';
import { LOG, DEFAULT_PREVIEW_TEXT } from './constants.js';
import { getSettings, saveSettings } from './settings.js';
import { fetchedVoices, fetchVoiceList } from './api.js';
import { generateAudio } from './api.js';
import { audioCache, pendingGenerations } from './cache.js';
import { playAudioBlob, stopCurrentPlayback } from './renderer.js';

export function buildSettingsHtml() {
  const s = getSettings();
  return `
    <div class="gsvi-settings-section">
        <div class="gsvi-toggle-row" style="margin-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 12px;">
            <label style="font-size: 14px; font-weight: bold;">启用 GSVI 插件</label>
            <input id="gsvi_enabled" type="checkbox" ${s.enabled ? 'checked' : ''} />
        </div>

        <div class="gsvi-settings-row">
            <label>API 端点</label>
            <input id="gsvi_endpoint" type="text" class="text_pole" value="${s.endpoint}" placeholder="http://localhost:8001" />
        </div>

        <div class="gsvi-settings-row">
            <label>API 格式</label>
            <select id="gsvi_api_format" class="text_pole">
                <option value="auto" ${s.apiFormat === 'auto' ? 'selected' : ''}>自动检测 (按端口)</option>
                <option value="adapter" ${s.apiFormat === 'adapter' ? 'selected' : ''}>Adapter (9881)</option>
                <option value="gsvi" ${s.apiFormat === 'gsvi' ? 'selected' : ''}>GSVI Inference (8000)</option>
            </select>
        </div>
        <div class="gsvi-settings-note">Adapter: 端口 9881，POST /(暂未适配)。GSVI: 端口 8000，POST /v1/audio/speech。</div>

        <div class="gsvi-settings-row">
            <label>默认角色</label>
            <select id="gsvi_default_voice" class="text_pole" style="flex:1;min-width:0;">
                <option value="">${s.voiceId ? s.voiceId + ' (上次保存)' : '点击获取按钮加载模型列表'}</option>
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
                ${[
      '中文',
      '英语',
      '日语',
      '粤语',
      '韩语',
      '中英混合',
      '日英混合',
      '粤英混合',
      '韩英混合',
      '多语种混合',
      '多语种混合(粤语)',
    ]
      .map(l => `<option value="${l}" ${s.textLang === l ? 'selected' : ''}>${l}</option>`)
      .join('')}
            </select>
        </div>

        <div class="gsvi-settings-row">
            <label>参考语言</label>
            <select id="gsvi_prompt_lang" class="text_pole">
                <option value="">${s.promptLang ? s.promptLang + ' (上次保存)' : '(请先获取声音列表)'}</option>
            </select>
        </div>

        <div class="gsvi-settings-row">
            <label>默认情绪</label>
            <select id="gsvi_emotion" class="text_pole">
                <option value="">${s.emotion ? s.emotion + ' (上次保存)' : '(请先获取声音列表)'}</option>
            </select>
        </div>

        <div class="gsvi-settings-row">
            <label>文本切分</label>
            <select id="gsvi_split_method" class="text_pole">
                ${['不切', '凑四句一切', '凑50字一切', '按中文句号。切', '按英文句号.切', '按标点符号切']
      .map(m => `<option value="${m}" ${(s.textSplitMethod || '') === m ? 'selected' : ''}>${m}</option>`)
      .join('')}
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
        <div class="gsvi-settings-row">
            <label>单独提取时引号风格</label>
            <select id="gsvi_quote_style" class="text_pole">
                <option value="double" ${(s.quoteStyle || 'double') === 'double' ? 'selected' : ''}>双引号 ""/""</option>
                <option value="cjk" ${s.quoteStyle === 'cjk' ? 'selected' : ''}>方括引号 「」</option>
                <option value="all" ${s.quoteStyle === 'all' ? 'selected' : ''}>全部匹配</option>
            </select>
        </div>
        <div class="gsvi-toggle-row">
            <label>保存音频到服务器</label>
            <input id="gsvi_save_to_server" type="checkbox" ${s.saveToServer ? 'checked' : ''} />
        </div>

        <hr />
        
        <div class="gsvi-settings-row">
            <span style="font-size:13px; font-weight:bold;">提示词注入</span>
        </div>
        <div class="gsvi-toggle-row">
            <label>开启提示词注入</label>
            <input id="gsvi_inject_enabled" type="checkbox" ${s.injectEnabled ? 'checked' : ''} />
        </div>
        <div class="gsvi-settings-row">
            <label>注入位置</label>
            <select id="gsvi_inject_position" class="text_pole">
                <option value="1" ${s.injectPosition == 1 ? 'selected' : ''}>D0</option>
                <option value="2" ${s.injectPosition == 2 ? 'selected' : ''}>指定深度</option>
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
                <option value="">${s.testVoiceId ? s.testVoiceId + ' (上次保存)' : '(请先获取模型)'}</option>
            </select>
        </div>
        <div class="gsvi-settings-row">
            <label>试听情绪</label>
            <select id="gsvi_test_emotion" class="text_pole">
                <option value="">${s.testEmotion ? s.testEmotion + ' (上次保存)' : '(无可用情绪)'}</option>
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

export function bindSettingsEvents() {
  const s = getSettings();

  // Global Enabled
  $('#gsvi_enabled').on('change', function () {
    s.enabled = $(this).prop('checked');
    saveSettings();
    toastr.info(s.enabled ? 'GSVI TTS 已启用' : 'GSVI TTS 已禁用 (刷新页面生效)');
  });

  // Endpoint
  $('#gsvi_endpoint').on('change', function () {
    s.endpoint = $(this).val().trim();
    saveSettings();
  });

  // API format
  $('#gsvi_api_format').on('change', function () {
    s.apiFormat = $(this).val();
    saveSettings();
  });

  // Default Voice
  $('#gsvi_default_voice').on('change', function () {
    s.voiceId = $(this).val();
    const voice = fetchedVoices.find(v => v.id === s.voiceId) || s.cachedVoices.find(v => v.id === s.voiceId);
    if (voice && voice.version) {
      s.voiceVersion = voice.version;
    }
    saveSettings();
    updatePromptLangDropdown(s.voiceId);
    updateEmotionSelect(s.voiceId, 'gsvi_emotion', 'emotion');
  });

  // Test Voice
  $('#gsvi_test_voice').on('change', function () {
    s.testVoiceId = $(this).val();
    saveSettings();
    updateEmotionSelect(s.testVoiceId, 'gsvi_test_emotion', 'testEmotion');
  });

  // Fetch voices
  $('#gsvi_fetch_voices').on('click', async function () {
    const btn = $(this);
    btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> 获取中...');
    try {
      const voices = await fetchVoiceList();
      console.log(`${LOG} Fetched ${voices.length} voices.`);

      // Cache voices in settings so they persist across reloads
      const s = getSettings();
      s.cachedVoices = voices;
      saveSettingsDebounced();

      toastr.success(`成功获取 ${voices.length} 个模型`, 'GSVI TTS');

      // Rebuild setting UI for voices
      buildVoiceSelects();
    } catch (err) {
      console.error(`${LOG} fetchVoices error:`, err);
      toastr.error(err.message, 'GSVI TTS');
    } finally {
      btn.prop('disabled', false).html('<i class="fa-solid fa-rotate"></i> 获取');
    }
  });

  // Speed slider
  $('#gsvi_speed').on('input', function () {
    const val = parseFloat($(this).val());
    s.speed = val;
    $('#gsvi_speed_val').text(`${val.toFixed(1)}x`);
    saveSettings();
  });

  // Text lang
  $('#gsvi_text_lang').on('change', function () {
    s.textLang = $(this).val();
    saveSettings();
  });

  // Prompt lang
  $('#gsvi_prompt_lang').on('change', function () {
    s.promptLang = $(this).val();
    updateEmotionSelect(s.voiceId, 'gsvi_emotion', 'emotion');
    saveSettings();
  });

  // Emotion
  $('#gsvi_emotion').on('change', function () {
    s.emotion = $(this).val();
    saveSettings();
  });

  // Test Emotion
  $('#gsvi_test_emotion').on('change', function () {
    s.testEmotion = $(this).val();
    saveSettings();
  });

  // Split method
  $('#gsvi_split_method').on('change', function () {
    s.textSplitMethod = $(this).val();
    saveSettings();
  });

  // Batch size slider
  $('#gsvi_batch_size').on('input', function () {
    const val = parseInt($(this).val(), 10);
    s.batchSize = val;
    $('#gsvi_batch_size_val').text(val);
    saveSettings();
  });

  // Save locally toggle
  $('#gsvi_save_to_server').on('change', function () {
    s.saveToServer = $(this).prop('checked');
    saveSettings();
  });

  // Quote style
  $('#gsvi_quote_style').on('change', function () {
    s.quoteStyle = $(this).val();
    saveSettings();
  });

  // Test button
  $('#gsvi_test_btn').on('click', async function () {
    const btn = $(this);
    if (!s.voiceId) {
      toastr.warning('请先选择一个角色', 'GSVI TTS');
      return;
    }
    btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> 生成中...');
    try {
      const result = await generateAudio(DEFAULT_PREVIEW_TEXT, s.voiceId, s.emotion || '默认');
      playAudioBlob(result.url, 'gsvi_test_btn');
      toastr.success('试听播放中', 'GSVI TTS');
    } catch (err) {
      console.error(`${LOG} Test playback error:`, err);
      toastr.error(err.message, 'GSVI TTS');
    } finally {
      btn.prop('disabled', false).html('<i class="fa-solid fa-play"></i> 试听');
    }
  });

  // Inject position — toggle depth row visibility
  $('#gsvi_inject_position').on('change', function () {
    const pos = parseInt($(this).val(), 10);
    $('#gsvi_depth_row').toggle(pos === 2);
  });

  // Save button — read all current UI values
  $('#gsvi_save_settings').on('click', function () {
    readSettingsFromUI();
    toastr.success('设置已保存', 'GSVI TTS');
  });

  // Color picker realtime update
  $('#gsvi_theme_color').on('input', function () {
    document.documentElement.style.setProperty('--gsvi-theme-color', $(this).val());
  });

  // Prompt Manager Modal
  $('#gsvi_open_prompt_modal').on('click', function () {
    openPromptManagerModal();
  });

  // Character Mapping Modal
  $('#gsvi_open_char_mapping_modal').on('click', function () {
    openCharacterMappingModal();
  });

  $('#gsvi_clear_cache').on('click', function () {
    // Revoke all blob URLs
    for (const [, data] of audioCache) {
      if (data.url && data.url.startsWith('blob:')) URL.revokeObjectURL(data.url);
    }
    audioCache.clear();
    pendingGenerations.clear();
    stopCurrentPlayback();
    toastr.success(`缓存已清理`, 'GSVI TTS');
  });
}

export function readSettingsFromUI() {
  const s = getSettings();
  s.endpoint = ($('#gsvi_endpoint').val() || '').trim();
  s.apiFormat = $('#gsvi_api_format').val() || 'auto';
  s.voiceId = $('#gsvi_voice').val() || '';
  s.speed = parseFloat($('#gsvi_speed').val()) || 1.0;
  s.textLang = $('#gsvi_text_lang').val() || '多语种混合';
  s.promptLang = $('#gsvi_prompt_lang').val() || '';
  s.emotion = $('#gsvi_emotion').val() || '';
  s.textSplitMethod = $('#gsvi_split_method').val() || '按标点符号切';
  s.batchSize = parseInt($('#gsvi_batch_size').val(), 10) || 1;
  s.saveToServer = $('#gsvi_save_to_server').prop('checked');
  s.themeColor = $('#gsvi_theme_color').val() || '#52a9af';
  s.injectEnabled = $('#gsvi_inject_enabled').prop('checked');
  s.injectPosition = parseInt($('#gsvi_inject_position').val(), 10) || 0;
  s.injectDepth = parseInt($('#gsvi_inject_depth').val(), 10) || 3;

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

export function applyThemeColor() {
  const s = getSettings();
  if (s.themeColor) {
    document.documentElement.style.setProperty('--gsvi-theme-color', s.themeColor);
  }
}

function updatePromptLangDropdown(voiceId) {
  const s = getSettings();
  const sourceVoices = fetchedVoices.length > 0 ? fetchedVoices : s.cachedVoices || [];
  const voice = sourceVoices.find(v => v.id === voiceId);
  if (!voice) return;

  // Update prompt lang dropdown
  const promptLangSelect = $('#gsvi_prompt_lang');
  promptLangSelect.empty();
  if (voice.promptLangs && voice.promptLangs.length > 0) {
    for (const lang of voice.promptLangs) {
      promptLangSelect.append(`<option value="${lang}" ${s.promptLang === lang ? 'selected' : ''}>${lang}</option>`);
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
  const allVoices = fetchedVoices.length > 0 ? fetchedVoices : s.cachedVoices || [];
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
      emotionSelect.append(`<option value="${em}" ${s[settingKey] === em ? 'selected' : ''}>${em}</option>`);
    }
  } else {
    emotionSelect.append('<option value="">(无可用情绪)</option>');
  }
}

export function buildVoiceSelects() {
  const s = getSettings();
  const voices = fetchedVoices.length > 0 ? fetchedVoices : s.cachedVoices || [];

  const defaultVoiceSelect = $('#gsvi_default_voice');
  const testVoiceSelect = $('#gsvi_test_voice');

  if (!defaultVoiceSelect.length) return; // Not on settings page

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
    const displayName = v.name;

    defaultVoiceSelect.append(
      `<option value="${v.id}" ${s.voiceId === v.id ? 'selected' : ''}>${displayName}</option>`,
    );
    testVoiceSelect.append(
      `<option value="${v.id}" ${s.testVoiceId === v.id ? 'selected' : ''}>${displayName}</option>`,
    );
  }

  if (!s.voiceId || !voices.find(v => v.id === s.voiceId)) {
    s.voiceId = voices[0].id;
    s.voiceVersion = voices[0].version;
    defaultVoiceSelect.val(s.voiceId);
    saveSettings();
  }

  updatePromptLangDropdown(s.voiceId);
  updateEmotionSelect(s.voiceId, 'gsvi_emotion', 'emotion');
  updateEmotionSelect(s.testVoiceId, 'gsvi_test_emotion', 'testEmotion');
}

function openPromptManagerModal() {
  const s = getSettings();

  // Remove old if exists
  $('#gsvi-custom-modal').remove();

  let listHtml = '';
  s.promptList.forEach(p => {
    listHtml += createPromptItemHtml(p.id, p.name, p.content, p.enabled);
  });

  // Build Reference Panel Data
  const voices = fetchedVoices.length > 0 ? fetchedVoices : s.cachedVoices || [];

  // Build per-character + per-emotion grouped HTML for the generator panel
  let genPanelHtml = '';

  if (voices.length === 0) {
    genPanelHtml = "<div style='opacity:0.5; font-size:11px;'>尚未获取模型，请先点击「获取」按钮</div>";
  } else {
    for (const v of voices) {
      // Use mapped character name if available, otherwise strip bracketed strings like "[v4]" from the character name for display and selection
      let charName =
        (s.characterVoices && s.characterVoices[v.id]) || (v.name || v.id).replace(/\s*\[.*?\]/g, '').trim();

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

      const emoChips =
        emoList.length > 0
          ? emoList
            .map(e => `<div class="gsvi-chip emo-chip" data-char="${charName}" data-val="${e}">${e}</div>`)
            .join('')
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

  $('body').append(modalHtml);

  // Chip selection
  $('#gsvi-custom-modal .char-chip').on('click', function () {
    $(this).toggleClass('selected');
    $(this).css({
      background: $(this).hasClass('selected') ? 'var(--gsvi-theme-color)' : 'rgba(255,255,255,0.05)',
      color: $(this).hasClass('selected') ? '#fff' : '',
    });
  });

  $('#gsvi-custom-modal .emo-chip').on('click', function () {
    $(this).toggleClass('selected');
    $(this).css({
      background: $(this).hasClass('selected') ? 'rgba(245,158,11,0.8)' : 'rgba(255,255,255,0.05)',
      color: $(this).hasClass('selected') ? '#000' : '',
    });
  });

  // Auto-Generate logic
  $('#gsvi-prompt-generate').on('click', function () {
    const selectedChars = [];
    $('#gsvi-generator-panel .char-chip.selected').each((_, el) => selectedChars.push($(el).data('val')));

    if (selectedChars.length === 0) {
      toastr.warning('请至少选择一个角色（点击角色名标签）', 'GSVI TTS');
      return;
    }

    const charEmoMap = {};
    selectedChars.forEach(c => {
      charEmoMap[c] = [];
    });

    $('#gsvi-generator-panel .emo-chip.selected').each((_, el) => {
      const charAttr = $(el).data('char');
      const emoVal = $(el).data('val');
      if (charAttr && charEmoMap[charAttr] !== undefined) {
        charEmoMap[charAttr].push(emoVal);
      }
    });

    let genContent = 'Voice character availability:\n';
    for (const [char, emos] of Object.entries(charEmoMap)) {
      if (emos.length > 0) {
        genContent += `- ${char}: ${emos.join(', ')}\n`;
      } else {
        genContent += `- ${char}\n`;
      }
    }
    genContent += 'Only use characters and emotions listed above.';

    const newId = Date.now().toString();
    $('#gsvi-prompt-list').append(createPromptItemHtml(newId, '可用角色情感映射', genContent));
    initDragAndDrop();

    const listDiv = document.getElementById('gsvi-prompt-list');
    listDiv.scrollTop = listDiv.scrollHeight;
  });

  const closeModal = () => {
    const modal = $('#gsvi-custom-modal');
    modal
      .find('.gsvi-modal-container')
      .css('animation', 'gsvi-slide-up 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275) reverse');
    modal.css('animation', 'gsvi-fade-in 0.2s ease-out reverse');
    setTimeout(() => modal.remove(), 180);
  };

  $('#gsvi-modal-close-btn, #gsvi-modal-cancel').on('click', closeModal);
  $('#gsvi-custom-modal').on('click', function (e) {
    if (e.target === this) closeModal();
  });

  $('#gsvi-modal-save').on('click', function () {
    const newList = [];
    $('#gsvi-prompt-list .gsvi-prompt-item').each((_, el) => {
      const id = $(el).data('id') || Date.now().toString();
      const name = $(el).find('.gsvi-prompt-name').val() || 'Untitled';
      const content = $(el).find('.gsvi-prompt-content').val() || '';
      const enabled = $(el).find('.gsvi-prompt-enabled').prop('checked');
      if (content.trim()) {
        newList.push({ id, name, content, enabled });
      }
    });
    s.promptList = newList;
    saveSettingsDebounced();
    toastr.success('提示词已保存生效', 'GSVI TTS');
  });

  $('#gsvi-prompt-add').on('click', function () {
    const newId = Date.now().toString();
    $('#gsvi-prompt-list').append(createPromptItemHtml(newId, 'New Prompt', ''));
    initDragAndDrop();
  });

  $('#gsvi-prompt-insert-default').on('click', async function () {
    try {
      const scriptUrl = import.meta.url;
      const extDir = scriptUrl.substring(0, scriptUrl.lastIndexOf('/'));
      const url = `${extDir.replace('/modules', '')}/default_prompt.txt`;
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) {
        toastr.error('读取默认提示词文件失败', 'GSVI');
        return;
      }
      const content = await resp.text();
      const newId = Date.now().toString();
      $('#gsvi-prompt-list').append(createPromptItemHtml(newId, 'Default Formatting', content.trim()));
      initDragAndDrop();
    } catch (err) {
      console.error(`${LOG} Failed to load default_prompt.txt:`, err);
    }
  });

  $('#gsvi-prompt-list').on('click', '.gsvi-prompt-del', function () {
    $(this).closest('.gsvi-prompt-item').remove();
  });

  initDragAndDrop();
}

function createPromptItemHtml(id, name, content, enabled = true) {
  return `
        <div class="gsvi-glass-item gsvi-prompt-item" data-id="${id}">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <i class="fa-solid fa-grip-vertical gsvi-drag-handle" style="cursor: grab; color: rgba(255,255,255,0.4); font-size: 16px;"></i>
                    <input type="checkbox" class="gsvi-prompt-enabled" ${enabled ? 'checked' : ''} title="启用/禁用此条目" />
                    <input type="text" class="gsvi-glass-input gsvi-prompt-name" value="${name.replace(/"/g, '&quot;')}" placeholder="Name" style="font-weight: bold; width: 160px;" />
                </div>
                <button class="menu_button gsvi-prompt-del" title="删除" style="padding: 6px 10px; min-width: auto; background: rgba(220, 38, 38, 0.2); border: 1px solid rgba(220,38,38,0.4); border-radius: 6px; color: #fca5a5;"><i class="fa-solid fa-trash"></i></button>
            </div>
            <textarea class="gsvi-glass-input gsvi-prompt-content" placeholder="输入提示词内容..." style="width: 100%; height: 85px; resize: vertical;">${content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
        </div>
    `;
}

function initDragAndDrop() {
  const list = document.getElementById('gsvi-prompt-list');
  if (!list) return;

  if (typeof Sortable !== 'undefined') {
    Sortable.create(list, {
      handle: '.gsvi-drag-handle',
      animation: 150,
    });
  }
}

function openCharacterMappingModal() {
  const s = getSettings();
  const voices = fetchedVoices.length > 0 ? fetchedVoices : s.cachedVoices || [];

  if (voices.length === 0) {
    toastr.warning('尚未获取模型，请先点击「获取」按钮', 'GSVI TTS');
    return;
  }

  $('#gsvi-mapping-modal').remove();

  let listHtml = '';
  voices
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach(v => {
      const mappedName = (s.characterVoices && s.characterVoices[v.id]) || '';
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

  $('body').append(modalHtml);

  const closeModal = () => $('#gsvi-mapping-modal').remove();
  $('#gsvi-mapping-close-btn, #gsvi-mapping-cancel').on('click', closeModal);
  $('#gsvi-mapping-modal').on('click', function (e) {
    if (e.target === this) closeModal();
  });

  $('#gsvi-mapping-save').on('click', function () {
    const mappings = {};
    $('#gsvi-mapping-list .gsvi-mapping-name').each((_, el) => {
      const voiceId = $(el).data('voice-id');
      const mappedName = $(el).val().trim();
      if (mappedName) {
        mappings[voiceId] = mappedName;
      }
    });
    s.characterVoices = mappings;
    saveSettingsDebounced();
    toastr.success('角色映射已保存', 'GSVI TTS');
    closeModal();
  });
}
