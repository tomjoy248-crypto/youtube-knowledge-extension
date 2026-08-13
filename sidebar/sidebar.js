/* ============================================================
 * 知视 KnowledgeView 侧边栏 JavaScript
 *
 * 此脚本通过 manifest 注入并由 content.js 提供 Shadow Root，
 * shadowRoot 通过 window.__KV_SHADOW_ROOT__ 全局变量传入。
 *
 * 通信机制：
 * - 监听 document 上的 'kv-state-update' 事件（由 content.js 派发）
 * - 按钮操作时派发 document 上的 'kv-action' 事件（供 content.js 监听）
 * ============================================================ */

(function () {
  'use strict';

  // ========== 获取 Shadow Root ==========
  // content.js 在执行本脚本前设置了 window.__KV_SHADOW_ROOT__
  var shadowRoot = null;

  function getShadowRoot() {
    if (shadowRoot && typeof shadowRoot.querySelector === 'function') {
      return shadowRoot;
    }

    if (typeof window.__KV_SHADOW_ROOT__ !== 'undefined' && window.__KV_SHADOW_ROOT__ && typeof window.__KV_SHADOW_ROOT__.querySelector === 'function') {
      return window.__KV_SHADOW_ROOT__;
    }

    return null;
  }

  // 从 content.js 获取 Shadow Root
  function $(sel) {
    var root = getShadowRoot();
    return root ? root.querySelector(sel) : null;
  }

  function $$(sel) {
    var root = getShadowRoot();
    return root ? root.querySelectorAll(sel) : [];
  }

  // ========== 页面状态 ==========
  var currentTab = 'summary';  // 当前激活的 Tab
  var currentResult = null;    // 当前结果数据
  var isInitialized = false;   // 是否已初始化

  // ========== 事件通信 ==========

  /**
   * 派发 action 事件到 document，供 content.js 监听
   * @param {string} action - 动作名称
   * @param {object} data - 附加数据
   */
  function dispatchAction(action, data) {
    var detail = { action: action, data: data || {} };
    var event = new CustomEvent('kv-action', {
      detail: detail,
      bubbles: true,
      composed: true  // 允许事件穿越 Shadow DOM 边界
    });
    document.dispatchEvent(event);
  }

  // ========== 视图切换 ==========

  /**
   * 切换显示不同的视图
   * @param {string} viewName - 视图名称：initial/processing/error/result/no-subtitle
   */
  function showView(viewName) {
    var views = $$('.kv-view');
    for (var i = 0; i < views.length; i++) {
      views[i].style.display = 'none';
    }

    var viewMap = {
      'initial': '#kv-view-initial',
      'processing': '#kv-view-processing',
      'error': '#kv-view-error',
      'result': '#kv-view-result',
      'no-subtitle': '#kv-view-no-subtitle'
    };

    var selector = viewMap[viewName];
    if (selector) {
      var target = $(selector);
      if (target) {
        target.style.display = 'block';
      }
    }
  }

  // ========== 视频信息展示 ==========

  /**
   * 填充视频信息到初始视图
   * @param {object} info - 视频信息
   */
  function updateVideoInfo(info) {
    var container = $('#kv-video-info');
    if (!container || !info) return;

    var subtitleBadge = info.hasSubtitles
      ? '<span class="kv-quality-badge high">有字幕</span>'
      : '<span class="kv-quality-badge low">无字幕</span>';

    container.innerHTML =
      '<h3 class="kv-video-title">' + escapeHtml(info.title || '未知视频') + '</h3>' +
      '<div class="kv-video-meta">' +
        '<div class="kv-meta-item">' +
          '<span class="kv-meta-label">字幕:</span>' +
          subtitleBadge +
        '</div>' +
      '</div>';
  }

  // ========== 处理进度 ==========

  /**
   * 更新处理进度显示
   * @param {number} progress - 进度 0-100
   * @param {string} message - 进度消息
   */
  function updateProgress(progress, message) {
    var statusBar = $('.kv-status-bar');
    if (statusBar) {
      statusBar.textContent = message || '处理中...';
    }

    var steps = $$('.kv-step');
    // 根据进度百分比映射到 5 个步骤
    var activeStep = 0;
    if (progress >= 90) activeStep = 4;
    else if (progress >= 85) activeStep = 3;
    else if (progress >= 20) activeStep = 2;
    else if (progress >= 10) activeStep = 1;
    else activeStep = 0;

    var stepTitles = [
      '获取视频信息',
      '提取字幕内容',
      '分析视频内容',
      '生成知识资料',
      '整理完成'
    ];

    for (var i = 0; i < 5; i++) {
      if (!steps[i]) {
        // 动态创建步骤元素
        var stepContainer = $('#kv-steps');
        if (stepContainer) {
          var step = document.createElement('div');
          step.className = 'kv-step';
          step.innerHTML =
            '<div class="kv-step-icon">' + (i + 1) + '</div>' +
            '<div class="kv-step-content">' +
              '<div class="kv-step-title">' + stepTitles[i] + '</div>' +
              '<div class="kv-step-detail"></div>' +
            '</div>';
          stepContainer.appendChild(step);
        }
      }
    }

    // 重新获取步骤元素
    steps = $$('.kv-step');
    for (var j = 0; j < steps.length; j++) {
      var icon = steps[j].querySelector('.kv-step-icon');
      var detail = steps[j].querySelector('.kv-step-detail');

      if (j < activeStep) {
        steps[j].className = 'kv-step done';
        if (icon) icon.textContent = '✓';
      } else if (j === activeStep) {
        steps[j].className = 'kv-step active';
        if (icon) icon.innerHTML = '<div class="kv-step-spinner"></div>';
        if (detail) detail.textContent = message || '';
      } else {
        steps[j].className = 'kv-step pending';
        if (icon) icon.textContent = String(j + 1);
        if (detail) detail.textContent = '';
      }
    }
  }

  // ========== 结果展示 ==========

  /**
   * 展示生成完成的知识资料
   * @param {object} record - 视频记录数据
   *   record.summary   摘要（markdown 字符串）
   *   record.cards     知识卡片数组 [{type, title, definition, englishOriginal, timestamp}]
   *   record.notes     笔记（markdown 字符串）
   *   record.timeline  时间轴数组 [{time, seconds, chapterIndex, summary}]
   *   record.transcript 逐句转写数组 [{start, dur, text}]
   */
  function showResult(record) {
    currentResult = record || {};

    // 更新统计信息
    var stats = $('#kv-result-stats');
    if (stats) {
      var parts = [];
      if (currentResult.summary) parts.push('摘要');
      if (currentResult.cards && currentResult.cards.length) parts.push(currentResult.cards.length + '张卡片');
      if (currentResult.notes) parts.push('笔记');
      if (currentResult.timeline && currentResult.timeline.length) parts.push(currentResult.timeline.length + '个节点');
      if (currentResult.transcript && currentResult.transcript.length) parts.push(currentResult.transcript.length + '条文稿');
      stats.textContent = parts.join(' · ') || '无数据';
    }

    // 重置 Tab 为默认
    currentTab = 'summary';
    var tabs = $$('.kv-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.remove('active');
      if (tabs[i].dataset.tab === 'summary') {
        tabs[i].classList.add('active');
      }
    }

    // 初始化 Tab 切换功能
    initTabs();

    // 渲染默认 Tab 内容
    renderTab(currentTab);

    // 切换到结果视图
    showView('result');
  }

  /**
   * 初始化 Tab 切换功能
   */
  function initTabs() {
    var tabs = $$('.kv-tab');
    for (var i = 0; i < tabs.length; i++) {
      // 移除旧的事件监听器（通过克隆节点实现）
      var newTab = tabs[i].cloneNode(true);
      tabs[i].parentNode.replaceChild(newTab, tabs[i]);
    }

    // 重新获取并绑定事件
    var freshTabs = $$('.kv-tab');
    for (var j = 0; j < freshTabs.length; j++) {
      freshTabs[j].addEventListener('click', function (e) {
        var tabName = e.currentTarget.dataset.tab;

        // 更新 active 状态
        var allTabs = $$('.kv-tab');
        for (var k = 0; k < allTabs.length; k++) {
          allTabs[k].classList.remove('active');
        }
        e.currentTarget.classList.add('active');

        currentTab = tabName;
        renderTab(tabName);
      });
    }
  }

  /**
   * 根据 Tab 名称渲染对应内容
   */
  function renderTab(tabName) {
    if (!currentResult) return;
    switch (tabName) {
      case 'summary':
        renderSummary(currentResult.summary);
        break;
      case 'cards':
        renderCards(currentResult.cards || []);
        break;
      case 'notes':
        renderNotes(currentResult.notes);
        break;
      case 'timeline':
        renderTimeline(currentResult.timeline || []);
        break;
      case 'transcript':
        renderTranscript(currentResult.transcript || []);
        break;
    }
  }

  /**
   * 渲染摘要视图
   * @param {string} summaryText - 摘要 markdown 文本
   */
  function renderSummary(summaryText) {
    var container = $('#kv-tab-content');
    if (!container) return;

    if (!summaryText) {
      container.innerHTML = '<div class="kv-empty">暂无摘要数据</div>';
      return;
    }

    // 将 markdown 摘要转为简易 HTML
    var html = '<div class="kv-summary">';
    var lines = summaryText.split('\n');
    var inList = false;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) {
        if (inList) {
          html += '</ul>';
          inList = false;
        }
        continue;
      }

      // ### 章节标题
      if (line.indexOf('### ') === 0) {
        if (inList) { html += '</ul>'; inList = false; }
        html += '<div class="kv-summary-section"><div class="kv-summary-section-title">' +
          escapeHtml(line.substring(4)) + '</div>';
      }
      // ## 标题
      else if (line.indexOf('## ') === 0) {
        if (inList) { html += '</ul>'; inList = false; }
        html += '<div class="kv-summary-section"><div class="kv-summary-section-title">' +
          escapeHtml(line.substring(3)) + '</div>';
      }
      // 列表项
      else if (line.indexOf('- ') === 0 || line.indexOf('* ') === 0) {
        if (!inList) {
          html += '<ul class="note-list">';
          inList = true;
        }
        html += '<li>' + renderInlineTimestamps(line.substring(2)) + '</li>';
      }
      // 普通段落
      else {
        if (inList) { html += '</ul>'; inList = false; }
        html += '<div class="kv-summary-text">' + renderInlineTimestamps(line) + '</div>';
      }
    }

    if (inList) html += '</ul>';
    html += '</div>';
    container.innerHTML = html;
    bindTimestampClicks(container);
  }

  /**
   * 渲染知识卡片列表
   * @param {array} cards - 知识卡片数组
   *   card.type         类型：concept/process/compare/qa
   *   card.title        标题
   *   card.definition   定义/内容
   *   card.englishOriginal 英文原文
   *   card.timestamp    时间戳（MM:SS 格式字符串）
   */
  function renderCards(cards) {
    var container = $('#kv-tab-content');
    if (!container) return;

    if (!cards || !cards.length) {
      container.innerHTML = '<div class="kv-empty">暂无知识卡片</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var type = card.type || 'concept';
      var typeLabel = getTypeLabel(type);
      var cardId = String(i);

      // 解析时间戳为秒数（用于跳转）
      var tsSeconds = null;
      if (card.timestamp) {
        tsSeconds = parseTimestampToSeconds(card.timestamp);
      }

      html +=
        '<div class="kc-card" data-card-id="' + escapeHtml(cardId) + '">' +
          '<div class="kc-header">' +
            '<span class="kc-type ' + escapeHtml(type) + '">' + typeLabel + '</span>' +
            '<span class="kc-title">' + escapeHtml(card.title || '') + '</span>';

      // 时间戳跳转
      if (tsSeconds !== null) {
        html += '<span class="kc-time" data-time="' + tsSeconds + '">' + escapeHtml(card.timestamp) + '</span>';
      }

      html +=
            '<span class="kc-toggle">▶</span>' +
          '</div>' +
          '<div class="kc-body">';

      // 卡片定义/内容
      if (card.definition) {
        html += '<div class="kc-body-section"><div class="kc-body-label">内容</div>' +
          escapeHtml(card.definition) + '</div>';
      }

      // 英文原文
      if (card.englishOriginal) {
        html += '<div class="kc-body-section"><div class="kc-body-label">原文</div>' +
          '<div class="kc-english">' + escapeHtml(card.englishOriginal) + '</div></div>';
      }

      html += '</div></div>';
    }

    container.innerHTML = html;

    // 使用事件委托绑定卡片交互事件
    bindCardEvents(container);
  }

  /**
   * 绑定知识卡片的交互事件（使用事件委托）
   */
  function bindCardEvents(container) {
    container.addEventListener('click', function (e) {
      // 时间戳点击 - 跳转视频
      var timeEl = e.target.closest('.kc-time');
      if (timeEl) {
        e.stopPropagation();
        var time = parseFloat(timeEl.dataset.time);
        if (!isNaN(time)) {
          dispatchAction('seek', { time: time });
        }
        return;
      }

      // 卡片头部点击 - 展开/折叠
      var header = e.target.closest('.kc-header');
      if (header) {
        var card = header.closest('.kc-card');
        if (card) {
          card.classList.toggle('expanded');
          var toggle = header.querySelector('.kc-toggle');
          if (toggle) {
            toggle.textContent = card.classList.contains('expanded') ? '▼' : '▶';
          }
        }
      }
    });
  }

  /**
   * 渲染笔记视图
   * @param {string} notesText - 笔记 markdown 文本
   */
  function renderNotes(notesText) {
    var container = $('#kv-tab-content');
    if (!container) return;

    if (!notesText) {
      container.innerHTML = '<div class="kv-empty">暂无笔记</div>';
      return;
    }

    // 将 markdown 笔记转为简易 HTML
    var html = '<div class="kv-notes">';
    var lines = notesText.split('\n');
    var inList = false;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      if (line.trim() === '') {
        if (inList) { html += '</ul>'; inList = false; }
        continue;
      }

      // #### 四级标题
      if (line.indexOf('#### ') === 0) {
        if (inList) { html += '</ul>'; inList = false; }
        html += '<h4 class="note-h2">' + escapeHtml(line.substring(5)) + '</h4>';
      }
      // ### 三级标题
      else if (line.indexOf('### ') === 0) {
        if (inList) { html += '</ul>'; inList = false; }
        html += '<h3 class="note-h2">' + escapeHtml(line.substring(4)) + '</h3>';
      }
      // ## 二级标题
      else if (line.indexOf('## ') === 0) {
        if (inList) { html += '</ul>'; inList = false; }
        html += '<h2 class="note-h1">' + escapeHtml(line.substring(3)) + '</h2>';
      }
      // # 一级标题
      else if (line.indexOf('# ') === 0) {
        if (inList) { html += '</ul>'; inList = false; }
        html += '<h1 class="note-h1">' + escapeHtml(line.substring(2)) + '</h1>';
      }
      // > 引用
      else if (line.indexOf('> ') === 0) {
        if (inList) { html += '</ul>'; inList = false; }
        html += '<blockquote class="note-quote">' + renderInlineTimestamps(line.substring(2)) + '</blockquote>';
      }
      // 列表项
      else if (line.indexOf('- ') === 0 || line.indexOf('* ') === 0) {
        if (!inList) {
          html += '<ul class="note-list">';
          inList = true;
        }
        html += '<li>' + renderInlineTimestamps(line.substring(2)) + '</li>';
      }
      // 普通段落
      else {
        if (inList) { html += '</ul>'; inList = false; }
        html += '<p class="note-p">' + renderInlineTimestamps(line) + '</p>';
      }
    }

    if (inList) html += '</ul>';
    html += '</div>';
    container.innerHTML = html;

    // 绑定时间戳点击事件
    bindTimestampClicks(container);
  }

  /**
   * 将文本中的 [MM:SS] 格式时间戳转换为可点击标签
   */
  function renderInlineTimestamps(text) {
    var html = escapeHtml(text);
    // 匹配 [MM:SS] 或 [H:MM:SS] 格式
    html = html.replace(/\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g, function (match, p1, p2, p3) {
      var totalSec;
      if (p3 !== undefined) {
        totalSec = parseInt(p1, 10) * 3600 + parseInt(p2, 10) * 60 + parseInt(p3, 10);
        return '<span class="note-timestamp" data-time="' + totalSec + '">' + p1 + ':' + p2 + ':' + p3 + '</span>';
      } else {
        totalSec = parseInt(p1, 10) * 60 + parseInt(p2, 10);
        return '<span class="note-timestamp" data-time="' + totalSec + '">' + p1 + ':' + p2 + '</span>';
      }
    });
    // 也支持 **[MM:SS]** 加粗时间戳格式
    html = html.replace(/\*\*\[(\d{1,2}:\d{2}(?::\d{2})?)\]\*\*/g, function (match, ts) {
      var secs = parseTimestampToSeconds(ts);
      if (secs !== null) {
        return '<span class="note-timestamp" data-time="' + secs + '">[' + ts + ']</span>';
      }
      return match;
    });
    return html;
  }

  /**
   * 绑定容器内所有时间戳的点击事件（事件委托）
   */
  function bindTimestampClicks(container) {
    container.addEventListener('click', function (e) {
      var ts = e.target.closest('.note-timestamp');
      if (ts) {
        var time = parseFloat(ts.dataset.time);
        if (!isNaN(time)) {
          dispatchAction('seek', { time: time });
        }
      }
    });
  }

  /**
   * 渲染时间轴视图
   * @param {array} timeline - 时间轴数组
   *   item.time        时间戳字符串（MM:SS）
   *   item.seconds     时间（秒）
   *   item.chapterIndex 章节索引
   *   item.summary     摘要
   */
  function renderTimeline(timeline) {
    var container = $('#kv-tab-content');
    if (!container) return;

    if (!timeline || !timeline.length) {
      container.innerHTML = '<div class="kv-empty">暂无时间轴数据</div>';
      return;
    }

    var html = '<div class="kv-timeline">';
    for (var i = 0; i < timeline.length; i++) {
      var item = timeline[i];
      // 优先使用 seconds 字段，其次从 time 字段解析
      var seconds = (typeof item.seconds === 'number') ? item.seconds : parseTimestampToSeconds(item.time);
      var timeLabel = item.time || formatTime(seconds);

      html +=
        '<div class="tl-item">' +
          '<span class="tl-time" data-time="' + (seconds || 0) + '">' + escapeHtml(timeLabel) + '</span>' +
          '<div class="tl-content">' +
            '<div class="tl-title">第 ' + (item.chapterIndex || (i + 1)) + ' 部分</div>';
      if (item.summary) {
        html += '<div class="tl-desc">' + escapeHtml(item.summary) + '</div>';
      }
      html += '</div></div>';
    }
    html += '</div>';

    container.innerHTML = html;

    // 绑定时间戳点击事件（事件委托）
    container.addEventListener('click', function (e) {
      var timeEl = e.target.closest('.tl-time');
      if (timeEl) {
        var time = parseFloat(timeEl.dataset.time);
        if (!isNaN(time)) {
          dispatchAction('seek', { time: time });
        }
      }
    });
  }

  function renderTranscript(transcript) {
    var container = $('#kv-tab-content');
    if (!container) return;

    if (!transcript || !transcript.length) {
      container.innerHTML = '<div class="kv-empty">暂无转写文稿，请重新生成当前视频</div>';
      return;
    }

    var html = '<div class="kv-transcript">';
    for (var i = 0; i < transcript.length; i++) {
      var item = transcript[i] || {};
      var seconds = Number(item.start) || 0;
      html +=
        '<div class="tr-item">' +
          '<button class="tr-time" data-time="' + seconds + '">' + escapeHtml(formatTime(seconds)) + '</button>' +
          '<div class="tr-text">' + escapeHtml(item.text || '') + '</div>' +
        '</div>';
    }
    html += '</div>';
    container.innerHTML = html;

    container.addEventListener('click', function (event) {
      var timeButton = event.target.closest('.tr-time');
      if (!timeButton) return;
      var time = parseFloat(timeButton.dataset.time);
      if (!isNaN(time)) {
        dispatchAction('seek', { time: time });
      }
    });
  }

  // ========== 辅助函数 ==========

  /**
   * 将秒数格式化为 MM:SS 或 H:MM:SS
   */
  function formatTime(seconds) {
    seconds = Math.floor(seconds || 0);
    var hours = Math.floor(seconds / 3600);
    var min = Math.floor((seconds % 3600) / 60);
    var sec = seconds % 60;

    if (hours > 0) {
      return hours + ':' + padZero(min) + ':' + padZero(sec);
    }
    return min + ':' + padZero(sec);
  }

  /**
   * 数字补零
   */
  function padZero(num) {
    return num < 10 ? '0' + num : String(num);
  }

  /**
   * 将 MM:SS 或 H:MM:SS 时间戳解析为秒数
   */
  function parseTimestampToSeconds(ts) {
    if (!ts) return null;
    var parts = String(ts).split(':');
    if (parts.length === 2) {
      var m = parseInt(parts[0], 10);
      var s = parseInt(parts[1], 10);
      if (!isNaN(m) && !isNaN(s)) return m * 60 + s;
    } else if (parts.length === 3) {
      var h = parseInt(parts[0], 10);
      var mm = parseInt(parts[1], 10);
      var ss = parseInt(parts[2], 10);
      if (!isNaN(h) && !isNaN(mm) && !isNaN(ss)) return h * 3600 + mm * 60 + ss;
    }
    return null;
  }

  /**
   * 获取卡片类型的中文标签
   */
  function getTypeLabel(type) {
    var labels = {
      'concept': '概念',
      'process': '流程',
      'compare': '对比',
      'qa': '问答'
    };
    return labels[type] || '概念';
  }

  /**
   * HTML 转义，防止 XSS
   */
  function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    var div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  }

  // ========== 导出菜单 ==========

  /**
   * 显示导出格式选择菜单
   */
  function showExportMenu() {
    // 检查是否已有菜单
    var existing = $('#kv-export-menu');
    if (existing) {
      existing.remove();
      return;
    }

    var menu = document.createElement('div');
    menu.id = 'kv-export-menu';
    menu.className = 'kv-export-menu';
    menu.innerHTML =
      '<div class="kv-export-item" data-format="markdown">📝 Markdown</div>' +
      '<div class="kv-export-item" data-format="json">📄 JSON</div>' +
      '<div class="kv-export-item" data-format="text">📃 纯文本</div>';

    // 添加到结果头部
    var header = $('.kv-result-header');
    if (header) {
      header.style.position = 'relative';
      header.appendChild(menu);
    }

    // 绑定菜单项点击
    menu.addEventListener('click', function (e) {
      var item = e.target.closest('.kv-export-item');
      if (item) {
        var format = item.dataset.format;
        dispatchAction('export', { format: format });
        menu.remove();
      }
    });

    // 点击外部关闭菜单
    setTimeout(function () {
      document.addEventListener('click', function closeMenu(e) {
        if (!menu.contains(e.target)) {
          menu.remove();
          document.removeEventListener('click', closeMenu);
        }
      });
    }, 0);
  }

  // ========== 事件绑定 ==========

  /**
   * 绑定所有按钮事件
   */
  function bindEvents() {
    var urlInput = $('#kv-url-input');
    var parseUrlBtn = $('#kv-parse-url-btn');

    function submitUrl() {
      var url = urlInput ? urlInput.value.trim() : '';
      dispatchAction('parseUrl', { url: url });
    }

    if (parseUrlBtn) {
      parseUrlBtn.addEventListener('click', submitUrl);
    }

    if (urlInput) {
      urlInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          submitUrl();
        }
      });
    }

    // 生成按钮
    var generateBtn = $('#kv-generate-btn');
    if (generateBtn) {
      generateBtn.addEventListener('click', function () {
        dispatchAction('generate');
      });
    }

    // 取消按钮
    var cancelBtn = $('#kv-cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        dispatchAction('cancel');
      });
    }

    // 重试按钮
    var retryBtn = $('#kv-retry-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', function () {
        dispatchAction('generate');
      });
    }

    var openSettingsBtn = $('#kv-open-settings-btn');
    if (openSettingsBtn) {
      openSettingsBtn.addEventListener('click', function () {
        dispatchAction('openSettings');
      });
    }

    // 重新生成按钮
    var regenerateBtn = $('#kv-regenerate-btn');
    if (regenerateBtn) {
      regenerateBtn.addEventListener('click', function () {
        dispatchAction('generate');
      });
    }

    // 导出按钮 - 显示格式选择菜单
    var exportBtn = $('#kv-export-btn');
    if (exportBtn) {
      exportBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        showExportMenu();
      });
    }

    // 折叠按钮
    var collapseBtn = $('.kv-collapse-btn');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', function () {
        var app = $('.kv-app');
        if (app) {
          app.classList.toggle('collapsed');
        }
        dispatchAction('toggleCollapse');
      });
    }
  }

  // ========== 状态更新处理 ==========

  /**
   * 处理来自 content.js 的状态更新
   * @param {object} data - 状态数据
   *   data.state    状态名称
   *   data           对于不同状态，data 本身包含对应的数据
   *
   * 支持的状态：
   *   'initialized'  - 侧边栏初始化完成，data: {videoId, title}
   *   'videoInfo'    - 视频信息已加载，data: {videoId, title, url, hasSubtitles, captionTracks}
   *   'cached'       - 缓存命中，data: videoRecord
   *   'processing'   - 处理中，data: {progress, message}
   *   'completed'    - 处理完成，data: videoRecord
   *   'error'        - 错误，data: {message}
   *   'exported'     - 导出完成，data: {filename, format}
   *   'collapseChanged' - 折叠状态变化，data: {collapsed}
   */
  function handleStateUpdate(eventDetail) {
    if (!eventDetail || !eventDetail.state) return;

    // content.js 发送的事件格式为 { state, data }
    // 内层 data 包含实际数据
    var stateName = eventDetail.state;
    var payload = eventDetail.data || {};

    switch (stateName) {
      case 'initialized':
        // 侧边栏初始化完成
        showView('initial');
        break;

      case 'videoInfo':
        // 视频信息已加载，更新初始视图
        showView('initial');
        updateVideoInfo(payload);
        break;

      case 'cached':
        // 缓存命中，直接展示结果
        showResult(payload);
        break;

      case 'processing':
        // 处理中
        showView('processing');
        updateProgress(payload.progress || 0, payload.message);
        break;

      case 'completed':
        // 处理完成，展示结果
        showResult(payload);
        break;

      case 'error':
        // 错误
        var errorMsg = $('#kv-error-msg');
        if (errorMsg) {
          errorMsg.textContent = payload.message || '处理失败，请重试';
        }
        showView('error');
        break;

      case 'parseError':
        var parseErrorMsg = $('#kv-error-msg');
        if (parseErrorMsg) {
          parseErrorMsg.textContent = payload.message || '请输入有效的 YouTube 视频地址';
        }
        showView('error');
        break;

      case 'exported':
        // 导出完成，显示简要提示
        var statsEl = $('#kv-result-stats');
        if (statsEl) {
          statsEl.textContent = '已导出: ' + (payload.filename || '文件');
        }
        break;

      case 'collapseChanged':
        // 折叠状态变化
        var app = $('.kv-app');
        if (app) {
          if (payload.collapsed) {
            app.classList.add('collapsed');
          } else {
            app.classList.remove('collapsed');
          }
        }
        break;

      case 'no-subtitle':
        showView('no-subtitle');
        break;

      default:
        console.warn('[知视 Sidebar] 未知状态:', stateName);
    }
  }

  // ========== 初始化 ==========

  function init() {
    if (isInitialized) return false;

    var readyRoot = getShadowRoot();
    if (!readyRoot) {
      return false;
    }

    shadowRoot = readyRoot;
    isInitialized = true;

    // 绑定交互事件
    bindEvents();

    // 监听 content.js 派发的状态更新
    document.addEventListener('kv-state-update', function (e) {
      var data = e.detail || {};
      handleStateUpdate(data);
    });

    // 默认展示初始页
    showView('initial');

    window.__KV_SIDEBAR_READY__ = true;
    window.dispatchEvent(new CustomEvent('kv-sidebar-ready'));

    console.log('[知视 Sidebar] 初始化完成');
    return true;
  }

  function bootstrapSidebar() {
    window.addEventListener('kv-shadow-root-ready', function (event) {
      var detail = event && event.detail ? event.detail : {};
      if (detail.shadowRoot) {
        shadowRoot = detail.shadowRoot;
        window.__KV_SHADOW_ROOT__ = detail.shadowRoot;
      }

      init();
    });

    if (getShadowRoot()) {
      init();
    }
  }

  bootstrapSidebar();

  // ========== 启动侧边栏 ==========
  window.__KV_SIDEBAR__ = {
    showView: showView,
    updateVideoInfo: updateVideoInfo,
    updateProgress: updateProgress,
    showResult: showResult,
    renderSummary: renderSummary,
    renderCards: renderCards,
    renderNotes: renderNotes,
    renderTimeline: renderTimeline,
    dispatchAction: dispatchAction
  };

})();
