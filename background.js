/**
 * 知视 KnowledgeView - Background Service Worker (Manifest V3)
 *
 * 负责：
 * - 扩展安装时打开设置页
 * - 点击扩展图标时切换侧边栏或打开设置页
 * - 监听来自 content script 的消息（打开设置、下载文件）
 *
 * 注意：MV3 Service Worker 有 30 秒超时限制，避免长时间同步操作。
 */

// ============ 扩展安装/更新监听 ============

/**
 * 扩展安装或更新时触发
 */
chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason === 'install') {
    // 首次安装：打开设置页，引导用户配置 API 密钥
    console.log('[知视 Background] 首次安装，打开设置页');
    chrome.runtime.openOptionsPage();
  } else if (details.reason === 'update') {
    // 更新时可以做一些迁移工作（此处仅记录日志）
    console.log('[知视 Background] 扩展已更新到版本', chrome.runtime.getManifest().version);
  }
});

// ============ 扩展图标点击监听 ============

/**
 * 点击扩展图标时触发
 * - 如果当前是 YouTube 视频页，发送切换侧边栏消息
 * - 否则打开设置页
 */
chrome.action.onClicked.addListener(function (tab) {
  if (tab.url && tab.url.indexOf('youtube.com/watch') !== -1) {
    // 在 YouTube 视频页，发送切换侧边栏消息
    chrome.tabs.sendMessage(
      tab.id,
      { action: 'toggleSidebar' },
      function (response) {
        // 如果 content script 未响应（可能页面尚未注入），打开设置页
        if (chrome.runtime.lastError) {
          console.log('[知视 Background] Content script 未响应，打开设置页');
          chrome.runtime.openOptionsPage();
        }
      }
    );
  } else {
    // 非视频页，直接打开设置页
    chrome.runtime.openOptionsPage();
  }
});

// ============ 消息监听 ============

/**
 * 监听来自 content script 的消息
 * MV3 中 Service Worker 可能在消息处理期间被唤醒，所有处理应尽快完成
 */
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.action) {
    sendResponse({ success: false, error: '无效的消息格式' });
    return false;
  }

  switch (message.action) {
    case 'openSettings':
      // 打开扩展设置页
      handleOpenSettings()
        .then(function () {
          sendResponse({ success: true });
        })
        .catch(function (err) {
          sendResponse({ success: false, error: err.message });
        });
      return true; // 异步响应

    case 'download':
      // 下载文件
      handleDownload(message.data)
        .then(function (result) {
          sendResponse({ success: true, result: result });
        })
        .catch(function (err) {
          sendResponse({ success: false, error: err.message });
        });
      return true; // 异步响应

    default:
      sendResponse({ success: false, error: '未知操作: ' + message.action });
      return false;
  }
});

// ============ 处理函数 ============

/**
 * 打开设置页
 */
async function handleOpenSettings() {
  try {
    await chrome.runtime.openOptionsPage();
    console.log('[知视 Background] 设置页已打开');
  } catch (err) {
    console.error('[知视 Background] 打开设置页失败:', err);
    throw err;
  }
}

/**
 * 处理下载请求
 * 使用 Blob URL 和 chrome.downloads API 下载文件
 * @param {Object} data - 下载数据 { filename, content, mimeType }
 */
async function handleDownload(data) {
  try {
    if (!data || !data.filename || data.content === undefined) {
      throw new Error('下载参数不完整');
    }

    var filename = data.filename;
    var content = data.content;
    var mimeType = data.mimeType || 'text/plain';

    // 创建 Blob 对象
    var blob = new Blob([content], { type: mimeType });

    // 创建 Blob URL
    var blobUrl = URL.createObjectURL(blob);

    try {
      // 使用 chrome.downloads API 下载
      var downloadId = await new Promise(function (resolve, reject) {
        chrome.downloads.download(
          {
            url: blobUrl,
            filename: filename,
            saveAs: false // 不弹出"另存为"对话框，直接下载
          },
          function (id) {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(id);
            }
          }
        );
      });

      console.log('[知视 Background] 文件下载已开始，ID:', downloadId);
      return { downloadId: downloadId };
    } finally {
      // 释放 Blob URL（延迟释放，确保下载已启动）
      setTimeout(function () {
        URL.revokeObjectURL(blobUrl);
      }, 1000);
    }
  } catch (err) {
    console.error('[知视 Background] 下载失败:', err);
    throw err;
  }
}

// ============ Service Worker 生命周期 ============

/**
 * Service Worker 启动时触发
 */
chrome.runtime.onStartup.addListener(function () {
  console.log('[知视 Background] Service Worker 启动');
});

console.log('[知视 Background] Service Worker 已加载');
