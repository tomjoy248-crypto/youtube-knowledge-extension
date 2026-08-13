/**
 * 知视 KnowledgeView - 主 Content Script
 *
 * 运行在 ISOLATED world，负责：
 * - 检测 YouTube 视频页面（SPA 导航监听）
 * - 注入侧边栏（Shadow DOM 隔离样式）
 * - 管理侧边栏折叠/展开
 * - 获取视频信息和字幕
 * - 执行知识资料生成流程（字幕获取 → 清洗分块 → LLM处理 → 聚合 → 保存）
 * - 缓存检测
 * - 与 sidebar.js 通过自定义 DOM 事件通信
 * - 与 main-world.js 通过 window.postMessage 通信
 *
 * 依赖全局对象（在其他 lib 文件中定义，按 manifest 顺序先加载）：
 * - KVStore：存储管理
 * - LLM：LLM 调用
 * - SubtitleFetcher：字幕获取
 * - Processor：文本处理
 */

(function () {
  'use strict';

  // ============ 状态管理 ============

  var state = {
    currentVideoId: null,       // 当前视频 ID
    sidebarHost: null,          // 侧边栏宿主元素 (#kv-sidebar-host)
    shadowRoot: null,           // Shadow DOM 根节点
    sidebarReady: false,        // 侧边栏是否已就绪
    sidebarInitPromise: null,   // 侧边栏异步初始化 Promise
    loadedVideoId: null,        // 已完成初始化的视频 ID
    pendingAutoParseVideoId: null, // 等待自动解析的视频 ID
    isProcessing: false,        // 是否正在生成知识资料
    processingProgress: 0,      // 处理进度（0-100）
    isCollapsed: false,         // 侧边栏是否折叠
    lastVideoRecord: null,      // 最近一次的视频记录
    initRetryCount: 0           // 初始化重试计数
  };

  // ============ 常量 ============

  var SIDEBAR_WIDTH = 340;                    // 侧边栏展开宽度
  var SIDEBAR_COLLAPSED_WIDTH = 48;           // 侧边栏折叠宽度
  var VIDEO_URL_PATTERN = /youtube\.com\/watch/; // 视频页 URL 匹配
  var MAX_INIT_RETRY = 10;                    // 最大初始化重试次数
  var NAVIGATION_DELAY = 500;                 // 导航检测延迟（毫秒）
  var RECORD_SCHEMA_VERSION = 3;              // 缓存结构版本
  var PENDING_AUTO_PARSE_KEY = 'kv_pending_auto_parse';
  var AUTO_PARSE_MAX_AGE = 10 * 60 * 1000;

  var navigationObserver = null;              // MutationObserver 实例
  var initCheckTimer = null;                  // 初始化检查定时器

  function sanitizeErrorMessage(message) {
    return String(message || '未知错误')
      .replace(/sk-ant-[A-Za-z0-9_-]{8,}/gi, 'sk-ant-***')
      .replace(/sk-[A-Za-z0-9_-]{8,}/gi, 'sk-***')
      .replace(/(Bearer\s+)[A-Za-z0-9._~-]{8,}/gi, '$1***')
      .slice(0, 600);
  }

  function buildChunkFailureMessage(chunkResults, settings) {
    var messages = [];
    for (var i = 0; i < chunkResults.length; i++) {
      if (chunkResults[i].status !== 'rejected') {
        continue;
      }
      var reason = chunkResults[i].reason;
      var message = sanitizeErrorMessage(reason && reason.message ? reason.message : reason);
      if (messages.indexOf(message) === -1) {
        messages.push(message);
      }
      if (messages.length >= 3) {
        break;
      }
    }

    var requestInfo = LLM.getRequestInfo(settings.model, settings.apiBaseUrl, settings.apiProtocol);
    return [
      '全部 ' + chunkResults.length + ' 个分块处理失败。',
      '模型：' + (settings.model || '未填写'),
      '协议：' + requestInfo.protocol,
      '请求地址：' + requestInfo.url,
      '失败原因：' + (messages.length ? messages.join('；') : '接口未返回具体错误')
    ].join('\n');
  }

  // ============ 页面检测 ============

  /**
   * 检测当前是否在 YouTube 视频观看页
   * @returns {boolean}
   */
  function isVideoPage() {
    return VIDEO_URL_PATTERN.test(window.location.href);
  }

  /**
   * 从 URL 中提取视频 ID
   * @returns {string|null}
   */
  function getVideoId() {
    var parsed = SubtitleFetcher.parseYouTubeUrl(window.location.href);
    return parsed ? parsed.videoId : null;
  }

  function captureAutoParseFlag(videoId) {
    try {
      var currentUrl = new URL(window.location.href);
      if (currentUrl.searchParams.get('kv_autorun') !== '1') {
        return;
      }

      state.pendingAutoParseVideoId = videoId;
      currentUrl.searchParams.delete('kv_autorun');
      window.history.replaceState(window.history.state, '', currentUrl.toString());
    } catch (error) {
      console.warn('[知视] 自动解析参数读取失败:', error);
    }
  }

  async function takeAutoParseFlag(videoId) {
    if (state.pendingAutoParseVideoId !== videoId) {
      try {
        var stored = await chrome.storage.local.get(PENDING_AUTO_PARSE_KEY);
        var pending = stored[PENDING_AUTO_PARSE_KEY];
        var isCurrent = pending && pending.videoId === videoId;
        var isFresh = isCurrent && Date.now() - Number(pending.createdAt || 0) <= AUTO_PARSE_MAX_AGE;
        if (!isFresh) {
          return false;
        }
        await chrome.storage.local.remove(PENDING_AUTO_PARSE_KEY);
        return true;
      } catch (error) {
        console.warn('[知视] 自动解析任务读取失败:', error);
        return false;
      }
    }

    state.pendingAutoParseVideoId = null;
    return true;
  }

  async function openAndParseUrl(input) {
    var parsed = SubtitleFetcher.parseYouTubeUrl(input);
    if (!parsed) {
      notifySidebar('kv-state-update', {
        state: 'parseError',
        data: { message: '地址无效。请粘贴完整的 YouTube 视频链接或 11 位视频 ID。' }
      });
      return;
    }

    try {
      var pendingPayload = {};
      pendingPayload[PENDING_AUTO_PARSE_KEY] = {
        videoId: parsed.videoId,
        createdAt: Date.now()
      };
      await chrome.storage.local.set(pendingPayload);
      window.location.assign(parsed.url);
    } catch (error) {
      notifySidebar('kv-state-update', {
        state: 'parseError',
        data: { message: '无法启动解析：' + (error.message || '扩展存储不可用') }
      });
    }
  }

  /**
   * 获取视频标题
   * @returns {string}
   */
  function getVideoTitle() {
    try {
      // 尝试多种选择器获取标题
      var selectors = [
        'h1.ytd-watch-metadata yt-formatted-string',
        'h1.title yt-formatted-string',
        'ytd-watch-metadata h1',
        'meta[property="og:title"]'
      ];

      for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i]);
        if (el) {
          var text = el.textContent || el.getAttribute('content') || '';
          if (text.trim()) {
            return text.trim();
          }
        }
      }
    } catch (e) {
      console.warn('[知视] 获取视频标题失败:', e);
    }
    return '未知视频';
  }

  // ============ 导航监听 ============

  /**
   * 初始化页面导航监听
   * YouTube 是 SPA 应用，content script 只注入一次，
   * 需要监听导航事件来检测页面切换。
   */
  function initNavigationListener() {
    // YouTube SPA 导航完成事件
    document.addEventListener('yt-navigate-finish', handleNavigation);

    // popstate 事件（浏览器前进/后退）
    window.addEventListener('popstate', handleNavigation);

    // hashchange 事件（后备）
    window.addEventListener('hashchange', handleNavigation);

    // MutationObserver 作为后备检测机制
    initMutationObserver();

    console.log('[知视] 导航监听已初始化');
  }

  /**
   * 处理导航事件
   * 延迟检测，确保 YouTube 页面内容已更新
   */
  function handleNavigation() {
    clearTimeout(initCheckTimer);
    initCheckTimer = setTimeout(function () {
      checkAndInitSidebar();
    }, NAVIGATION_DELAY);
  }

  /**
   * 使用 MutationObserver 检测页面变化
   * 当 YouTube 动态更新 DOM 时触发检测
   */
  function initMutationObserver() {
    navigationObserver = new MutationObserver(function (mutations) {
      // 只在视频页检测
      if (!isVideoPage()) return;

      // 检查是否有视频播放器出现
      var player = document.getElementById('movie_player');
      if (!player) return;

      var videoId = getVideoId();
      if (videoId && videoId !== state.currentVideoId) {
        // 视频ID变化，触发导航处理
        handleNavigation();
      }
    });

    // 观察 body 的子元素变化
    navigationObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // ============ 侧边栏注入 ============

  /**
   * 检查并初始化侧边栏
   * 当检测到视频页时创建/更新侧边栏
   */
  async function checkAndInitSidebar() {
    if (!isVideoPage()) {
      // 非视频页，不处理
      return;
    }

    var videoId = getVideoId();
    if (!videoId) {
      // 视频ID无效，可能页面尚未完全加载，稍后重试
      if (state.initRetryCount < MAX_INIT_RETRY) {
        state.initRetryCount++;
        console.log('[知视] 视频ID未找到，重试 ' + state.initRetryCount + '/' + MAX_INIT_RETRY);
        clearTimeout(initCheckTimer);
        initCheckTimer = setTimeout(function () {
          checkAndInitSidebar();
        }, 500);
      }
      return;
    }

    // 重置重试计数
    state.initRetryCount = 0;
    captureAutoParseFlag(videoId);

    // 如果视频ID变化，重置状态
    if (videoId !== state.currentVideoId) {
      console.log('[知视] 检测到新视频:', videoId);
      state.currentVideoId = videoId;
      state.loadedVideoId = null;
      state.lastVideoRecord = null;
      state.isProcessing = false;
    }

    // 如果侧边栏不存在，创建它
    if (!state.sidebarHost) {
      if (!state.sidebarInitPromise) {
        state.sidebarInitPromise = createSidebar().finally(function () {
          state.sidebarInitPromise = null;
        });
      }
      await state.sidebarInitPromise;
    } else if (state.sidebarInitPromise) {
      await state.sidebarInitPromise;
    }

    if (state.loadedVideoId === videoId) {
      if (await takeAutoParseFlag(videoId) && !state.isProcessing) {
        await loadVideoInfo(videoId, true);
      }
      return;
    }

    state.loadedVideoId = videoId;
    try {
      await loadVideoInfo(videoId, await takeAutoParseFlag(videoId));
    } catch (error) {
      state.loadedVideoId = null;
      throw error;
    }
  }

  /**
   * 创建侧边栏
   * 使用 Shadow DOM 隔离样式，通过 fetch 加载 HTML/CSS/JS 资源
   */
  async function createSidebar() {
    try {
      console.log('[知视] 开始创建侧边栏...');

      // 创建宿主元素
      var host = document.createElement('div');
      host.id = 'kv-sidebar-host';
      (document.body || document.documentElement).appendChild(host);

      state.sidebarHost = host;

      // 附加 Shadow DOM（open 模式，允许外部访问）
      var shadowRoot = host.attachShadow({ mode: 'open' });
      state.shadowRoot = shadowRoot;

      // 加载侧边栏 CSS
      try {
        var cssResponse = await fetch(chrome.runtime.getURL('sidebar/sidebar.css'));
        var cssText = await cssResponse.text();
        var styleEl = document.createElement('style');
        styleEl.textContent = cssText;
        shadowRoot.appendChild(styleEl);
      } catch (err) {
        console.error('[知视] 加载 sidebar.css 失败:', err);
      }

      // 加载侧边栏 HTML
      try {
        var htmlResponse = await fetch(chrome.runtime.getURL('sidebar/sidebar.html'));
        var htmlText = await htmlResponse.text();

        // 将 HTML 注入 Shadow DOM
        var container = document.createElement('div');
        container.className = 'kv-sidebar-container';
        container.innerHTML = htmlText;
        shadowRoot.appendChild(container);
      } catch (err) {
        console.error('[知视] 加载 sidebar.html 失败:', err);
        // 显示加载失败提示
        var errorDiv = document.createElement('div');
        errorDiv.style.cssText = 'padding:20px;color:#d32f2f;font-size:14px;';
        errorDiv.textContent = '侧边栏加载失败，请刷新 YouTube 页面后重试。';
        shadowRoot.appendChild(errorDiv);
      }

      window.__KV_SHADOW_ROOT__ = shadowRoot;
      window.dispatchEvent(new CustomEvent('kv-shadow-root-ready', {
        detail: { shadowRoot: shadowRoot }
      }));

      await new Promise(function (resolve) {
        if (window.__KV_SIDEBAR_READY__) {
          resolve();
          return;
        }

        var timeoutId = setTimeout(function () {
          window.removeEventListener('kv-sidebar-ready', onSidebarReady);
          resolve();
        }, 5000);

        function onSidebarReady() {
          clearTimeout(timeoutId);
          window.removeEventListener('kv-sidebar-ready', onSidebarReady);
          resolve();
        }

        window.addEventListener('kv-sidebar-ready', onSidebarReady);
      });

      state.sidebarReady = !!window.__KV_SIDEBAR_READY__;

      // 初始化事件通信
      initSidebarCommunication();

      // 通知侧边栏初始化完成
      notifySidebar('kv-state-update', {
        state: 'initialized',
        data: {
          videoId: state.currentVideoId,
          title: getVideoTitle()
        }
      });

      console.log('[知视] 侧边栏创建完成');
    } catch (err) {
      console.error('[知视] 创建侧边栏失败:', err);
    }
  }

  // ============ 侧边栏通信 ============

  /**
   * 初始化与侧边栏的事件通信
   * content.js 监听来自 sidebar.js 的 'kv-action' 事件
   */
  function initSidebarCommunication() {
    document.addEventListener('kv-action', handleSidebarAction);
    console.log('[知视] 侧边栏通信已初始化');
  }

  /**
   * 向侧边栏发送状态更新事件
   * sidebar.js 监听 'kv-state-update' 事件
   * @param {string} eventName - 事件名称
   * @param {Object} detail - 事件详情 { state, data }
   */
  function notifySidebar(eventName, detail) {
    try {
      document.dispatchEvent(new CustomEvent(eventName, { detail: detail }));
    } catch (err) {
      console.error('[知视] 通知侧边栏失败:', err);
    }
  }

  /**
   * 处理来自侧边栏的动作
   * @param {CustomEvent} event - kv-action 事件
   */
  function handleSidebarAction(event) {
    var detail = event.detail;
    if (!detail || !detail.action) return;

    var action = detail.action;
    var data = detail.data || {};

    console.log('[知视] 收到侧边栏动作:', action);

    switch (action) {
      case 'generate':
        // 开始生成知识资料
        startGenerate();
        break;

      case 'parseUrl':
        openAndParseUrl(data.url);
        break;

      case 'seek':
        // 跳转视频到指定时间
        seekVideo(data.time);
        break;

      case 'export':
        // 导出结果
        exportResult(data.format);
        break;

      case 'openSettings':
        // 打开设置页
        chrome.runtime.sendMessage({ action: 'openSettings' }, function (response) {
          if (chrome.runtime.lastError) {
            console.error('[知视] 打开设置页失败:', chrome.runtime.lastError);
          }
        });
        break;

      case 'toggleCollapse':
        // 切换折叠/展开
        toggleCollapse();
        break;

      default:
        console.warn('[知视] 未知侧边栏动作:', action);
    }
  }

  // ============ 侧边栏折叠 ============

  /**
   * 切换侧边栏折叠/展开状态
   * 折叠时宽度变为 48px，展开时恢复 340px
   */
  function toggleCollapse() {
    state.isCollapsed = !state.isCollapsed;

    if (state.isCollapsed) {
      state.sidebarHost.classList.add('kv-collapsed');
    } else {
      state.sidebarHost.classList.remove('kv-collapsed');
    }

    // 通知侧边栏更新内部 UI（显示/隐藏内容）
    notifySidebar('kv-state-update', {
      state: 'collapseChanged',
      data: { collapsed: state.isCollapsed }
    });

    console.log('[知视] 侧边栏折叠状态:', state.isCollapsed);
  }

  // ============ 视频信息加载 ============

  /**
   * 加载视频信息
   * 包括缓存检测、字幕轨道获取、自动生成检查
   * @param {string} videoId - 视频 ID
   * @param {boolean} autoParse - 是否由地址输入触发自动生成
   */
  async function loadVideoInfo(videoId, autoParse) {
    try {
      // ---- 1. 缓存检测 ----
      var cachedRecord = null;
      try {
        cachedRecord = await KVStore.getVideoRecord(videoId);
      } catch (e) {
        console.warn('[知视] 缓存读取失败:', e);
      }

      var hasValidTimeline = cachedRecord && Array.isArray(cachedRecord.timeline) && (
        cachedRecord.timeline.length <= 1 || cachedRecord.timeline.some(function (item, index) {
          return index > 0 && item && Number(item.seconds) > 0;
        })
      );
      var cacheIsCurrent = cachedRecord && cachedRecord.schemaVersion === RECORD_SCHEMA_VERSION && hasValidTimeline;

      if (cacheIsCurrent) {
        // 已有缓存，直接展示
        console.log('[知视] 发现缓存记录，直接展示');
        state.lastVideoRecord = cachedRecord;
        notifySidebar('kv-state-update', {
          state: 'cached',
          data: cachedRecord
        });
        return;
      }

      if (cachedRecord) {
        console.log('[知视] 检测到旧版时间轴缓存，将重新生成');
      }

      // ---- 2. 获取设置并判断是否自动生成 ----
      var settings = null;
      try {
        settings = await KVStore.getSettings();
      } catch (e) {
        console.warn('[知视] 获取设置失败:', e);
      }

      var shouldAutoGenerate = autoParse || (settings && settings.autoGenerate);
      if (shouldAutoGenerate) {
        notifySidebar('kv-state-update', {
          state: 'videoInfo',
          data: {
            videoId: videoId,
            title: getVideoTitle(),
            url: window.location.href,
            captionTracks: [],
            hasSubtitles: true
          }
        });
        console.log('[知视] 自动生成已开启，开始生成...');
        await startGenerate();
        return;
      }

      // ---- 3. 获取字幕轨道信息 ----
      var tracks = [];
      try {
        tracks = await SubtitleFetcher.requestCaptionTracks();
      } catch (e) {
        console.warn('[知视] 获取字幕轨道失败:', e);
      }

      // ---- 4. 在侧边栏展示视频信息卡 ----
      notifySidebar('kv-state-update', {
        state: 'videoInfo',
        data: {
          videoId: videoId,
          title: getVideoTitle(),
          url: window.location.href,
          captionTracks: tracks,
          hasSubtitles: tracks.length > 0
        }
      });

    } catch (err) {
      console.error('[知视] 加载视频信息失败:', err);
      notifySidebar('kv-state-update', {
        state: 'error',
        data: { message: '加载视频信息失败: ' + (err.message || '未知错误') }
      });
    }
  }

  // ============ 生成知识资料流程 ============

  /**
   * 开始生成知识资料
   * 完整流程：
   * a. 获取设置（KVStore.getSettings）
   * b. 获取字幕（SubtitleFetcher.fetchSubtitles）
   * c. 清洗和分块（Processor.cleanSubtitles + Processor.semanticChunk）
   * d. 对每个分块并行调用 LLM.processChunk（使用 Promise.allSettled）
   * e. 聚合结果（Processor.aggregateResults）
   * f. 保存记录（KVStore.saveVideoRecord）
   * g. 在侧边栏展示结果
   */
  async function startGenerate() {
    // 防止重复处理
    if (state.isProcessing) {
      console.warn('[知视] 正在处理中，请勿重复操作');
      return;
    }

    if (!state.currentVideoId) {
      console.error('[知视] 未检测到视频ID');
      notifySidebar('kv-state-update', {
        state: 'error',
        data: { message: '未检测到视频ID，请确保在视频页面操作' }
      });
      return;
    }

    state.isProcessing = true;
    state.processingProgress = 0;

    try {
      // ---- 步骤 a：获取设置 ----
      notifySidebar('kv-state-update', {
        state: 'processing',
        data: { progress: 0, message: '正在读取配置...' }
      });

      var settings = await KVStore.getSettings();
      if (!settings.apiKey) {
        throw new Error('请先在设置中配置 API 密钥');
      }

      // ---- 步骤 b：获取字幕 ----
      notifySidebar('kv-state-update', {
        state: 'processing',
        data: { progress: 10, message: '正在获取字幕...' }
      });

      // 获取字幕轨道列表
      var tracks = [];
      try {
        tracks = await SubtitleFetcher.requestCaptionTracks();
      } catch (trackError) {
        console.warn('[知视] 字幕轨道暂不可用，将改用转写文稿:', trackError);
      }

      // 选择英文字幕轨道（优先手动字幕，其次自动字幕）
      var englishTrack = tracks.find(function (t) {
        return t.languageCode && t.languageCode.startsWith('en') && !t.isAutoGenerated;
      }) || tracks.find(function (t) {
        return t.languageCode && t.languageCode.startsWith('en');
      }) || tracks[0] || null;

      if (englishTrack) {
        console.log('[知视] 选择字幕轨道:', englishTrack.languageCode, englishTrack.isAutoGenerated ? '(自动生成)' : '(手动)');
      } else {
        console.log('[知视] 未取得字幕轨道，直接读取转写文稿');
      }

      // 获取字幕内容
      var subtitles = await SubtitleFetcher.fetchSubtitles(englishTrack);
      if (!subtitles || subtitles.length === 0) {
        throw new Error('字幕内容为空，该视频可能没有有效字幕');
      }

      console.log('[知视] 获取到字幕条目:', subtitles.length);

      // ---- 步骤 c：清洗和分块 ----
      notifySidebar('kv-state-update', {
        state: 'processing',
        data: { progress: 20, message: '正在处理字幕文本...' }
      });

      var cleaned = Processor.cleanSubtitles(subtitles);
      var chunks = Processor.semanticChunk(cleaned);

      console.log('[知视] 字幕已分为', chunks.length, '个分块');

      // ---- 步骤 d：并行调用 LLM 处理每个分块 ----
      notifySidebar('kv-state-update', {
        state: 'processing',
        data: {
          progress: 30,
          message: '正在生成知识资料（共 ' + chunks.length + ' 个分块）...'
        }
      });

      var completedCount = 0;
      var totalChunks = chunks.length;

      // 为每个分块创建 LLM 处理 Promise
      var chunkPromises = chunks.map(function (chunk, index) {
        return LLM.processChunk(settings.apiKey, settings.model, chunk.text, settings.translateStyle, settings.apiBaseUrl, settings.apiProtocol).then(
          function (result) {
            // 处理成功，更新进度
            completedCount++;
            state.processingProgress = 30 + Math.floor((completedCount / totalChunks) * 50);
            notifySidebar('kv-state-update', {
              state: 'processing',
              data: {
                progress: state.processingProgress,
                message: '正在处理分块 ' + completedCount + '/' + totalChunks + '...'
              }
            });
            return Object.assign({}, result, {
              startTime: typeof chunk.startTime === 'number' ? chunk.startTime : 0,
              chunkIndex: index
            });
          },
          function (error) {
            // 处理失败，也计入完成数（Promise.allSettled 不会因失败而中断）
            completedCount++;
            state.processingProgress = 30 + Math.floor((completedCount / totalChunks) * 50);
            notifySidebar('kv-state-update', {
              state: 'processing',
              data: {
                progress: state.processingProgress,
                message: '分块 ' + completedCount + '/' + totalChunks + ' 处理失败，继续...'
              }
            });
            throw error; // 重新抛出，让 Promise.allSettled 捕获为 rejected
          }
        );
      });

      // 使用 Promise.allSettled 等待所有分块处理完成（无论成功或失败）
      var chunkResults = await Promise.allSettled(chunkPromises);

      // 统计成功和失败数量
      var successCount = chunkResults.filter(function (r) {
        return r.status === 'fulfilled';
      }).length;
      var failCount = chunkResults.filter(function (r) {
        return r.status === 'rejected';
      }).length;

      console.log('[知视] LLM 处理完成: 成功 ' + successCount + ' / 失败 ' + failCount);

      if (successCount === 0) {
        throw new Error(buildChunkFailureMessage(chunkResults, settings));
      }

      // ---- 步骤 e：聚合结果 ----
      notifySidebar('kv-state-update', {
        state: 'processing',
        data: { progress: 85, message: '正在汇总知识资料...' }
      });

      // 从 Promise.allSettled 结果中提取成功的分块结果
      var fulfilledResults = chunkResults
        .filter(function (r) { return r.status === 'fulfilled'; })
        .map(function (r) { return r.value; });

      var aggregatedResult = Processor.aggregateResults(fulfilledResults, {
        videoId: state.currentVideoId,
        title: getVideoTitle(),
        url: window.location.href
      });

      // ---- 步骤 f：保存记录 ----
      notifySidebar('kv-state-update', {
        state: 'processing',
        data: { progress: 90, message: '正在保存记录...' }
      });

      var videoRecord = {
        videoId: state.currentVideoId,
        title: getVideoTitle(),
        channel: '',
        duration: '',
        processDate: new Date().toISOString(),
        tags: [],
        cards: aggregatedResult.cards || [],
        notes: aggregatedResult.notes || '',
        summary: aggregatedResult.summary || '',
        timeline: aggregatedResult.timeline || [],
        transcript: subtitles.map(function (line) {
          return {
            start: Number(line.start) || 0,
            dur: Number(line.dur) || 0,
            text: String(line.text || '').trim()
          };
        }).filter(function (line) {
          return !!line.text;
        }),
        subtitleQuality: englishTrack ? (englishTrack.isAutoGenerated ? 'auto' : 'manual') : 'transcript',
        url: window.location.href,
        createdAt: Date.now(),
        chunkCount: chunks.length,
        successCount: successCount,
        failCount: failCount,
        schemaVersion: RECORD_SCHEMA_VERSION
      };

      try {
        await KVStore.saveVideoRecord(videoRecord);
        console.log('[知视] 视频记录已保存');
      } catch (e) {
        console.warn('[知视] 保存记录失败（不影响展示）:', e);
      }

      state.lastVideoRecord = videoRecord;

      // ---- 步骤 g：在侧边栏展示结果 ----
      notifySidebar('kv-state-update', {
        state: 'completed',
        data: videoRecord
      });

      console.log('[知视] 知识资料生成完成');
    } catch (err) {
      console.error('[知视] 生成知识资料失败:', err);
      notifySidebar('kv-state-update', {
        state: 'error',
        data: { message: err.message || '生成知识资料失败，请重试' }
      });
    } finally {
      state.isProcessing = false;
    }
  }

  // ============ 视频跳转 ============

  /**
   * 跳转视频到指定时间
   * 通过 postMessage 向 main-world.js 发送跳转指令
   * @param {number} time - 跳转时间（秒）
   */
  function seekVideo(time) {
    try {
      if (typeof time !== 'number' || time < 0) {
        console.warn('[知视] 无效的跳转时间:', time);
        return;
      }

      // 通过 window.postMessage 向 main-world.js 发送跳转指令
      window.postMessage(
        {
          type: 'KV_SEEK_VIDEO',
          time: time
        },
        '*'
      );

      console.log('[知视] 已发送视频跳转指令:', time, '秒');
    } catch (err) {
      console.error('[知视] 视频跳转失败:', err);
    }
  }

  // ============ 导出 ============

  /**
   * 导出知识资料
   * 支持 JSON、Markdown、纯文本格式
   * @param {string} format - 导出格式：'json' | 'markdown' | 'md' | 'text' | 'txt'
   */
  async function exportResult(format) {
    try {
      if (!state.lastVideoRecord) {
        console.warn('[知视] 没有可导出的结果');
        notifySidebar('kv-state-update', {
          state: 'error',
          data: { message: '没有可导出的结果，请先生成知识资料' }
        });
        return;
      }

      var content = '';
      var filename = '';
      var mimeType = '';

      if (format === 'json') {
        // JSON 格式
        content = JSON.stringify(state.lastVideoRecord, null, 2);
        filename = '知视_' + state.currentVideoId + '_' + Date.now() + '.json';
        mimeType = 'application/json';
      } else if (format === 'markdown' || format === 'md') {
        // Markdown 格式
        if (typeof Processor.generateMarkdown === 'function') {
          content = Processor.generateMarkdown(state.lastVideoRecord, {
            videoId: state.currentVideoId,
            title: state.lastVideoRecord.title,
            url: state.lastVideoRecord.url
          });
        } else {
          // 后备：简单 Markdown 格式
          content = formatAsMarkdown(state.lastVideoRecord);
        }
        filename = '知视_' + state.currentVideoId + '_' + Date.now() + '.md';
        mimeType = 'text/markdown';
      } else {
        // 纯文本格式
        if (typeof Processor.toText === 'function') {
          content = Processor.toText(state.lastVideoRecord);
        } else {
          // 后备：简单文本格式
          content = formatAsText(state.lastVideoRecord);
        }
        filename = '知视_' + state.currentVideoId + '_' + Date.now() + '.txt';
        mimeType = 'text/plain';
      }

      // 发送下载请求给 background service worker
      chrome.runtime.sendMessage(
        {
          action: 'download',
          data: {
            filename: filename,
            content: content,
            mimeType: mimeType
          }
        },
        function (response) {
          if (chrome.runtime.lastError) {
            console.error('[知视] 下载消息发送失败:', chrome.runtime.lastError);
            notifySidebar('kv-state-update', {
              state: 'error',
              data: { message: '导出失败: ' + chrome.runtime.lastError.message }
            });
            return;
          }

          if (response && response.success) {
            console.log('[知视] 导出成功:', filename);
            notifySidebar('kv-state-update', {
              state: 'exported',
              data: { filename: filename, format: format }
            });
          } else {
            var errMsg = response ? response.error : '未知错误';
            console.error('[知视] 导出失败:', errMsg);
            notifySidebar('kv-state-update', {
              state: 'error',
              data: { message: '导出失败: ' + errMsg }
            });
          }
        }
      );
    } catch (err) {
      console.error('[知视] 导出失败:', err);
      notifySidebar('kv-state-update', {
        state: 'error',
        data: { message: '导出失败: ' + (err.message || '未知错误') }
      });
    }
  }

  /**
   * 后备 Markdown 格式化（当 Processor.toMarkdown 不可用时使用）
   * @param {Object} record - 视频记录
   * @returns {string} Markdown 文本
   */
  function formatAsMarkdown(record) {
    var lines = [];
    lines.push('# ' + (record.title || '未知视频'));
    lines.push('');
    lines.push('> 由知视 KnowledgeView 生成');
    lines.push('');
    lines.push('**视频链接**: ' + (record.url || ''));
    lines.push('**生成时间**: ' + new Date(record.createdAt || Date.now()).toLocaleString('zh-CN'));
    lines.push('');

    if (record.summary) {
      lines.push('## 摘要');
      lines.push('');
      lines.push(record.summary);
      lines.push('');
    }

    if (record.cards && record.cards.length > 0) {
      lines.push('## 知识卡片');
      lines.push('');
      record.cards.forEach(function (card) {
        lines.push('### [' + (card.type || '') + '] ' + (card.title || ''));
        if (card.definition) lines.push(card.definition);
        if (card.englishOriginal) lines.push('> ' + card.englishOriginal);
        if (card.timestamp) lines.push('⏱ ' + card.timestamp);
        lines.push('');
      });
    }

    if (record.notes) {
      lines.push('## 笔记');
      lines.push('');
      lines.push(record.notes);
    }

    return lines.join('\n');
  }

  /**
   * 后备纯文本格式化（当 Processor.toText 不可用时使用）
   * @param {Object} record - 视频记录
   * @returns {string} 纯文本
   */
  function formatAsText(record) {
    var lines = [];
    lines.push('视频标题: ' + (record.title || '未知视频'));
    lines.push('视频链接: ' + (record.url || ''));
    lines.push('生成时间: ' + new Date(record.createdAt || Date.now()).toLocaleString('zh-CN'));
    lines.push('----------------------------------------');
    lines.push('');

    if (record.summary) {
      lines.push('【摘要】');
      lines.push(record.summary);
      lines.push('');
    }

    if (record.cards && record.cards.length > 0) {
      lines.push('【知识卡片】');
      record.cards.forEach(function (card) {
        lines.push('  [' + (card.type || '') + '] ' + (card.title || ''));
        if (card.definition) lines.push('  ' + card.definition);
        if (card.englishOriginal) lines.push('  原文: ' + card.englishOriginal);
        if (card.timestamp) lines.push('  时间: ' + card.timestamp);
        lines.push('');
      });
    }

    if (record.notes) {
      lines.push('【笔记】');
      lines.push(record.notes);
    }

    return lines.join('\n');
  }

  // ============ Main World 消息监听 ============

  /**
   * 监听来自 main-world.js 的消息
   * main-world.js 通过 window.postMessage 返回字幕轨道结果
   * 这些消息主要由 SubtitleFetcher 处理，此处作为后备监听
   */
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;

    var message = event.data;
    if (!message || !message.type) return;

    // 处理字幕轨道结果（由 SubtitleFetcher 内部处理，此处仅记录日志）
    if (message.type === 'KV_CAPTION_TRACKS_RESULT') {
      if (message.error) {
        console.warn('[知视] 字幕轨道获取错误:', message.error);
      } else {
        console.log('[知视] 字幕轨道结果已接收:', message.tracks.length, '个轨道');
      }
    }
  });

  // ============ Background 消息监听 ============

  /**
   * 监听来自 background service worker 的消息
   */
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.action) {
      sendResponse({ success: false, error: '无效的消息' });
      return false;
    }

    switch (message.action) {
      case 'toggleSidebar':
        // 切换侧边栏折叠/展开
        if (state.sidebarHost) {
          toggleCollapse();
          sendResponse({ success: true, collapsed: state.isCollapsed });
        } else {
          sendResponse({ success: false, error: '侧边栏未初始化' });
        }
        break;

      case 'checkPage':
        // 检查当前页面状态
        sendResponse({
          success: true,
          isVideoPage: isVideoPage(),
          videoId: getVideoId(),
          sidebarReady: state.sidebarReady
        });
        break;

      case 'generate':
        // 触发生成
        startGenerate();
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ success: false, error: '未知操作: ' + message.action });
    }

    return false;
  });

  // ============ 依赖检查 ============

  /**
   * 检查依赖的全局对象是否已加载
   * @returns {boolean} 依赖是否完整
   */
  function checkDependencies() {
    var missing = [];

    if (typeof KVStore === 'undefined') {
      missing.push('KVStore');
    }
    if (typeof LLM === 'undefined') {
      missing.push('LLM');
    }
    if (typeof SubtitleFetcher === 'undefined') {
      missing.push('SubtitleFetcher');
    }
    if (typeof Processor === 'undefined') {
      missing.push('Processor');
    }

    if (missing.length > 0) {
      console.error('[知视] 依赖对象缺失:', missing.join(', '));
      console.error('[知视] 请确保 manifest.json 中 lib 文件在 content.js 之前加载');
      return false;
    }

    return true;
  }

  // ============ 初始化 ============

  /**
   * 初始化 Content Script
   */
  function init() {
    console.log('[知视] Content Script 已加载');

    // 检查依赖
    if (!checkDependencies()) {
      // 依赖缺失，延迟重试
      setTimeout(function () {
        if (checkDependencies()) {
          startApp();
        }
      }, 1000);
      return;
    }

    startApp();
  }

  /**
   * 启动应用
   */
  function startApp() {
    // 初始化导航监听
    initNavigationListener();

    // 初始检查（页面可能已经加载完成）
    checkAndInitSidebar();

    // 定期检查（作为最终后备机制，确保不会遗漏）
    setInterval(function () {
      if (isVideoPage() && !state.sidebarHost) {
        checkAndInitSidebar();
      }
    }, 3000);
  }

  // ============ 启动 ============

  // 根据文档加载状态决定启动时机
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // 文档已加载完成（interactive 或 complete），直接初始化
    init();
  }
})();

