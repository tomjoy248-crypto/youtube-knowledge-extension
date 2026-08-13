/* ============================================================
 * 知视 KnowledgeView 设置页面 JavaScript
 *
 * 功能：
 * 1. 页面加载时从 chrome.storage.sync 读取 kv_settings 设置，填充表单
 * 2. 表单变化时自动保存到 chrome.storage.sync 的 kv_settings 键
 * 3. 显示"已保存"提示
 * 4. 清理缓存：清空 chrome.storage.local 中的 kv_records 键
 * 5. 更新已缓存视频数量
 *
 * 存储结构与 storage.js 保持一致：
 * - 设置存储在 chrome.storage.sync 的 kv_settings 键下
 * - 字段名：apiKey, model, translateStyle, bilingualSubtitles,
 *           autoGenerate, sidebarDefaultOpen
 * ============================================================ */

(function () {
  'use strict';

  // ========== 存储键名（与 storage.js 一致） ==========
  var SETTINGS_KEY = 'kv_settings';
  var RECORDS_KEY = 'kv_records';

  // ========== 默认设置（与 storage.js getDefaultSettings 一致） ==========
  var DEFAULT_SETTINGS = {
    apiKey: '',
    model: 'gpt-4o-mini',
    apiBaseUrl: '',                   // 自定义 API 中转地址（可选）
    translateStyle: 'readable',      // readable=通俗易读 / academic=学术严谨 / casual=口语化
    bilingualSubtitles: true,
    autoGenerate: false,
    sidebarDefaultOpen: true
  };

  // 保存提示定时器
  var toastTimer = null;

  var MODEL_PRESETS = [
    { label: '选择一个示例...', value: '' },
    { label: 'gpt-5.4-mini', value: 'gpt-5.4-mini' },
    { label: 'gpt-5.6-luna', value: 'gpt-5.6-luna' },
    { label: 'gpt-5.4', value: 'gpt-5.4' },
    { label: 'gpt-5.5', value: 'gpt-5.5' },
    { label: 'gpt-4o-mini', value: 'gpt-4o-mini' },
    { label: 'gpt-4o', value: 'gpt-4o' },
    { label: 'o3-mini', value: 'o3-mini' },
    { label: 'o4-mini', value: 'o4-mini' },
    { label: 'claude-haiku-4-5', value: 'claude-haiku-4-5' },
    { label: 'claude-haiku-4-5-20251001', value: 'claude-haiku-4-5-20251001' },
    { label: 'claude-sonnet-5', value: 'claude-sonnet-5' },
    { label: 'claude-sonnet-4-6', value: 'claude-sonnet-4-6' },
    { label: 'claude-opus-5', value: 'claude-opus-5' }
  ];

  var API_BASE_URL_PRESETS = [
    { label: '选择一个模板...', value: '' },
    { label: 'OpenAI 兼容根地址（https://api.xxx.com）', value: 'https://api.xxx.com' },
    { label: 'OpenAI 兼容 /v1（https://api.xxx.com/v1）', value: 'https://api.xxx.com/v1' },
    { label: 'OpenAI 兼容完整接口（https://api.xxx.com/v1/chat/completions）', value: 'https://api.xxx.com/v1/chat/completions' }
  ];

  // ========== 初始化 ==========

  function init() {
    initModelPresetOptions();
    initApiBaseUrlPresetOptions();
    loadSettings();
    bindEvents();
    updateCacheCount();
  }

  function initModelPresetOptions() {
    var presetSelect = document.getElementById('llm-model-preset');
    if (!presetSelect) {
      return;
    }

    presetSelect.innerHTML = '';

    for (var i = 0; i < MODEL_PRESETS.length; i++) {
      var preset = MODEL_PRESETS[i];
      var option = document.createElement('option');
      option.value = preset.value;
      option.textContent = preset.label;
      presetSelect.appendChild(option);
    }
  }

  function initApiBaseUrlPresetOptions() {
    var presetSelect = document.getElementById('api-base-url-preset');
    if (!presetSelect) {
      return;
    }

    presetSelect.innerHTML = '';

    for (var i = 0; i < API_BASE_URL_PRESETS.length; i++) {
      var preset = API_BASE_URL_PRESETS[i];
      var option = document.createElement('option');
      option.value = preset.value;
      option.textContent = preset.label;
      presetSelect.appendChild(option);
    }
  }

  // ========== 加载设置 ==========

  /**
   * 从 chrome.storage.sync 的 kv_settings 键读取设置，填充表单
   */
  function loadSettings() {
    chrome.storage.sync.get(SETTINGS_KEY, function (result) {
      var stored = result[SETTINGS_KEY] || {};
      var settings = Object.assign({}, DEFAULT_SETTINGS, stored);

      // LLM 模型选择
      setVal('llm-model', settings.model);
      syncPresetSelect(settings.model);

      // API Key
      setVal('api-key', settings.apiKey || '');

      // API Base URL
      setVal('api-base-url', settings.apiBaseUrl || '');
      syncApiBaseUrlPreset(settings.apiBaseUrl);

      // 翻译风格
      setVal('translate-style', settings.translateStyle);

      // 双语字幕开关
      setChecked('bilingual-subtitles', settings.bilingualSubtitles);

      // 自动生成开关
      setChecked('auto-generate', settings.autoGenerate);

      // 侧边栏默认展开开关
      setChecked('sidebar-default-open', settings.sidebarDefaultOpen);
    });
  }

  // ========== 保存设置 ==========

  /**
   * 收集表单数据并保存到 chrome.storage.sync 的 kv_settings 键
   * @param {boolean} showToast - 是否显示"已保存"提示
   */
  function saveSettings(showToast) {
    var settings = {
      apiKey: (getVal('api-key', '') || '').trim(),
      model: (getVal('llm-model', DEFAULT_SETTINGS.model) || '').trim(),
      apiBaseUrl: (getVal('api-base-url', '') || '').trim(),
      translateStyle: getVal('translate-style', DEFAULT_SETTINGS.translateStyle),
      bilingualSubtitles: getChecked('bilingual-subtitles', true),
      autoGenerate: getChecked('auto-generate', false),
      sidebarDefaultOpen: getChecked('sidebar-default-open', true)
    };

    var payload = {};
    payload[SETTINGS_KEY] = settings;

    chrome.storage.sync.set(payload, function () {
      if (showToast !== false) {
        showSaveToast();
      }
    });
  }

  // ========== 显示"已保存"提示 ==========

  function showSaveToast() {
    var toast = document.getElementById('save-toast');
    if (!toast) return;

    toast.textContent = '已保存';
    toast.classList.add('show');

    if (toastTimer) {
      clearTimeout(toastTimer);
    }

    toastTimer = setTimeout(function () {
      toast.classList.remove('show');
    }, 2000);
  }

  // ========== 更新已缓存视频数量 ==========

  /**
   * 从 chrome.storage.local 的 kv_records 键读取记录数量
   */
  function updateCacheCount() {
    chrome.storage.local.get(RECORDS_KEY, function (items) {
      var records = items[RECORDS_KEY] || {};
      var count = Object.keys(records).length;

      var countEl = document.getElementById('cache-count');
      if (countEl) {
        countEl.textContent = String(count);
      }
    });
  }

  // ========== 清理缓存 ==========

  /**
   * 清理 chrome.storage.local 中的 kv_records 缓存数据
   */
  function clearCache() {
    if (!confirm('确定要清理所有缓存数据吗？此操作不可撤销。')) {
      return;
    }

    var payload = {};
    payload[RECORDS_KEY] = {};
    chrome.storage.local.set(payload, function () {
      updateCacheCount();
      showCacheClearedToast();
    });
  }

  /**
   * 显示缓存清理完成提示
   */
  function showCacheClearedToast() {
    var toast = document.getElementById('save-toast');
    if (!toast) return;

    toast.textContent = '缓存已清理';
    toast.classList.add('show');

    if (toastTimer) {
      clearTimeout(toastTimer);
    }

    toastTimer = setTimeout(function () {
      toast.classList.remove('show');
    }, 2000);
  }

  // ========== 事件绑定 ==========

  function bindEvents() {
    var videoUrlInput = document.getElementById('video-url');
    var openVideoBtn = document.getElementById('open-video-btn');

    if (openVideoBtn) {
      openVideoBtn.addEventListener('click', openVideoForParsing);
    }

    if (videoUrlInput) {
      videoUrlInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          openVideoForParsing();
        }
      });
    }

    // 表单元素 ID 列表
    var formElementIds = [
      'llm-model',
      'api-key',
      'api-base-url',
      'translate-style',
      'bilingual-subtitles',
      'auto-generate',
      'sidebar-default-open'
    ];

    // 所有表单元素变化时自动保存（change 事件）
    for (var i = 0; i < formElementIds.length; i++) {
      var el = document.getElementById(formElementIds[i]);
      if (el) {
        el.addEventListener('change', function () {
          saveSettings(true);
        });
      }
    }

    // API Key 输入框 - 使用 input 事件实现实时保存（防抖处理）
    var apiKeyInput = document.getElementById('api-key');
    if (apiKeyInput) {
      var apiKeyTimer = null;
      apiKeyInput.addEventListener('input', function () {
        if (apiKeyTimer) {
          clearTimeout(apiKeyTimer);
        }
        apiKeyTimer = setTimeout(function () {
          saveSettings(true);
        }, 800);
      });
    }

    // API Base URL 输入框 - 同样实时保存
    var apiUrlInput = document.getElementById('api-base-url');
    if (apiUrlInput) {
      var apiUrlTimer = null;
      apiUrlInput.addEventListener('input', function () {
        syncApiBaseUrlPreset(apiUrlInput.value);
        if (apiUrlTimer) {
          clearTimeout(apiUrlTimer);
        }
        apiUrlTimer = setTimeout(function () {
          saveSettings(true);
        }, 800);
      });
    }

    var apiBasePreset = document.getElementById('api-base-url-preset');
    if (apiBasePreset) {
      apiBasePreset.addEventListener('change', function () {
        var selectedUrl = apiBasePreset.value;
        setVal('api-base-url', selectedUrl);
        syncApiBaseUrlPreset(selectedUrl);
        saveSettings(true);
      });
    }

    // 测试连接按钮
    var testBtn = document.getElementById('test-connection-btn');
    if (testBtn) {
      testBtn.addEventListener('click', testConnection);
    }

    // 保存按钮
    var saveBtn = document.getElementById('save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        saveSettings(true);
      });
    }

    // 清理缓存按钮
    var clearBtn = document.getElementById('clear-cache-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', clearCache);
    }

    var modelInput = document.getElementById('llm-model');
    if (modelInput) {
      var modelTimer = null;
      modelInput.addEventListener('input', function () {
        syncPresetSelect(modelInput.value);
        if (modelTimer) {
          clearTimeout(modelTimer);
        }
        modelTimer = setTimeout(function () {
          saveSettings(true);
        }, 800);
      });
    }

    var presetSelect = document.getElementById('llm-model-preset');
    if (presetSelect) {
      presetSelect.addEventListener('change', function () {
        var selectedModel = presetSelect.value;
        if (!selectedModel) {
          return;
        }
        setVal('llm-model', selectedModel);
        saveSettings(true);
      });
    }
  }

  function openVideoForParsing() {
    var resultEl = document.getElementById('open-video-result');
    var button = document.getElementById('open-video-btn');
    var input = document.getElementById('video-url');
    var value = input ? input.value.trim() : '';

    if (!value) {
      if (resultEl) {
        resultEl.textContent = '请先输入 YouTube 视频地址';
        resultEl.style.color = '#e74c3c';
      }
      return;
    }

    if (button) {
      button.disabled = true;
      button.textContent = '正在打开...';
    }

    chrome.runtime.sendMessage({ action: 'openVideo', data: { url: value } }, function (response) {
      if (button) {
        button.disabled = false;
        button.textContent = '打开并解析';
      }

      if (chrome.runtime.lastError) {
        if (resultEl) {
          resultEl.textContent = '打开失败：' + chrome.runtime.lastError.message;
          resultEl.style.color = '#e74c3c';
        }
        return;
      }

      if (!response || !response.success) {
        if (resultEl) {
          resultEl.textContent = response && response.error ? response.error : '视频地址无效';
          resultEl.style.color = '#e74c3c';
        }
        return;
      }

      if (resultEl) {
        resultEl.textContent = '已打开视频，扩展会自动开始解析';
        resultEl.style.color = '#27ae60';
      }
    });
  }

  function buildOpenAIUrl(baseUrl) {
    var fallbackUrl = 'https://api.openai.com/v1/chat/completions';

    if (!baseUrl) {
      return fallbackUrl;
    }

    var trimmed = baseUrl.replace(/\/+$/, '');
    if (!trimmed) {
      return fallbackUrl;
    }

    if (trimmed.indexOf('/chat/completions') !== -1) {
      return trimmed;
    }

    if (trimmed.indexOf('/v1') === trimmed.length - 3) {
      return trimmed + '/chat/completions';
    }

    return trimmed + '/v1/chat/completions';
  }

  function buildAnthropicUrl(baseUrl) {
    var fallbackUrl = 'https://api.anthropic.com/v1/messages';

    if (!baseUrl) {
      return fallbackUrl;
    }

    var trimmed = baseUrl.replace(/\/+$/, '');
    if (!trimmed) {
      return fallbackUrl;
    }

    if (trimmed.indexOf('/v1/messages') !== -1) {
      return trimmed;
    }

    if (trimmed.indexOf('/v1') === trimmed.length - 3) {
      return trimmed + '/messages';
    }

    return trimmed + '/v1/messages';
  }

  // ========== 测试连接 ==========

  function testConnection() {
    var resultEl = document.getElementById('test-result');
    var btn = document.getElementById('test-connection-btn');
    var apiKey = (getVal('api-key', '') || '').trim();
    var model = (getVal('llm-model', 'gpt-4o-mini') || '').trim();
    var baseUrl = getVal('api-base-url', '').trim();

    if (!apiKey) {
      if (resultEl) {
        resultEl.textContent = '请先填写 API Key';
        resultEl.style.color = '#e74c3c';
      }
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = '测试中...';
    }
    if (resultEl) {
      resultEl.textContent = '正在连接...';
      resultEl.style.color = '#666';
    }

    // 构建测试请求
    var isClaude = model.toLowerCase().indexOf('claude') === 0;
    var useProxy = !!baseUrl;
    var testUrl, headers, body;

    body = JSON.stringify({
      model: model,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Hi' }]
    });

    if (useProxy) {
      testUrl = buildOpenAIUrl(baseUrl);
      headers = {
        'Authorization': 'Bearer ' + apiKey,
        'content-type': 'application/json'
      };
    } else if (isClaude) {
      testUrl = buildAnthropicUrl(null);
      headers = {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      };
    } else {
      testUrl = buildOpenAIUrl(null);
      headers = {
        'Authorization': 'Bearer ' + apiKey,
        'content-type': 'application/json'
      };
    }

    fetch(testUrl, {
      method: 'POST',
      headers: headers,
      body: body
    }).then(function (resp) {
      return resp.text().then(function (text) {
        if (resp.ok) {
          if (resultEl) {
            resultEl.textContent = '连接成功！模型 ' + model + ' 可正常使用';
            resultEl.style.color = '#27ae60';
          }
        } else {
          var msg = '';
          try {
            var parsed = JSON.parse(text);
            if (parsed.error && parsed.error.message) {
              msg = parsed.error.message;
            }
          } catch (e) {
            msg = text.slice(0, 200);
          }
          if (resultEl) {
            resultEl.textContent = '连接失败（' + resp.status + '）：' + msg;
            resultEl.style.color = '#e74c3c';
          }
        }
      });
    }).catch(function (err) {
      if (resultEl) {
        resultEl.textContent = '网络错误：' + (err.message || '无法连接') + '。请检查 API 地址是否正确。';
        resultEl.style.color = '#e74c3c';
      }
    }).finally(function () {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '测试连接';
      }
    });
  }

  // ========== 辅助函数 ==========

  function getVal(id, defaultValue) {
    var el = document.getElementById(id);
    return el ? el.value : defaultValue;
  }

  function setVal(id, value) {
    var el = document.getElementById(id);
    if (el) {
      el.value = value;
    }
  }

  function getChecked(id, defaultValue) {
    var el = document.getElementById(id);
    return el ? el.checked : defaultValue;
  }

  function setChecked(id, value) {
    var el = document.getElementById(id);
    if (el) {
      el.checked = value !== false;
    }
  }

  function syncPresetSelect(modelValue) {
    var presetSelect = document.getElementById('llm-model-preset');
    if (!presetSelect) {
      return;
    }

    var normalizedValue = (modelValue || '').trim();
    var hasMatch = false;

    for (var i = 0; i < presetSelect.options.length; i++) {
      var option = presetSelect.options[i];
      if (option.value === normalizedValue) {
        hasMatch = true;
        break;
      }
    }

    presetSelect.value = hasMatch ? normalizedValue : '';
  }

  function syncApiBaseUrlPreset(apiBaseUrl) {
    var presetSelect = document.getElementById('api-base-url-preset');
    if (!presetSelect) {
      return;
    }

    var normalizedValue = normalizeUrlValue(apiBaseUrl);
    var hasMatch = false;

    for (var i = 0; i < presetSelect.options.length; i++) {
      var option = presetSelect.options[i];
      if (normalizeUrlValue(option.value) === normalizedValue) {
        hasMatch = true;
        break;
      }
    }

    presetSelect.value = hasMatch ? normalizedValue : '';
  }

  function normalizeUrlValue(value) {
    return (value || '').trim().replace(/\/+$/, '');
  }

  // ========== 启动 ==========

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
