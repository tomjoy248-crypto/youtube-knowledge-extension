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
    model: 'claude-3-5-sonnet',
    translateStyle: 'readable',      // readable=通俗易读 / academic=学术严谨 / casual=口语化
    bilingualSubtitles: true,
    autoGenerate: false,
    sidebarDefaultOpen: true
  };

  // 保存提示定时器
  var toastTimer = null;

  // ========== 初始化 ==========

  function init() {
    loadSettings();
    bindEvents();
    updateCacheCount();
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

      // API Key
      setVal('api-key', settings.apiKey || '');

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
      apiKey: getVal('api-key', ''),
      model: getVal('llm-model', DEFAULT_SETTINGS.model),
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
    // 表单元素 ID 列表
    var formElementIds = [
      'llm-model',
      'api-key',
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
        // 输入停止 800ms 后自动保存
        apiKeyTimer = setTimeout(function () {
          saveSettings(true);
        }, 800);
      });
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

  // ========== 启动 ==========

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
