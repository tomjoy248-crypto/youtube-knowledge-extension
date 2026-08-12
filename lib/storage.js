/**
 * storage.js - Chrome 扩展数据存储管理
 *
 * 全局对象：KVStore
 * 负责管理用户设置（chrome.storage.sync）和视频处理记录（chrome.storage.local）
 * 所有记录以单个键 kv_records 存储为一个 { videoId: record } 的映射对象，便于批量读取、计数与排序
 */

/* global chrome */

// 使用全局对象暴露 API（不使用 ES 模块）
window.KVStore = (function () {
  'use strict';

  // 设置存储在 chrome.storage.sync 中的键名
  var SETTINGS_KEY = 'kv_settings';
  // 视频记录存储在 chrome.storage.local 中的键名
  var RECORDS_KEY = 'kv_records';

  /**
   * 返回默认设置对象
   * @returns {Object} 默认设置
   */
  function getDefaultSettings() {
    return {
      apiKey: '',
      model: 'claude-3-5-sonnet',
      translateStyle: 'readable',      // 翻译风格：readable=通俗易读 / academic=学术严谨 / casual=口语化
      bilingualSubtitles: true,        // 是否显示双语字幕
      autoGenerate: false,             // 是否自动生成笔记
      sidebarDefaultOpen: true         // 侧边栏默认是否展开
    };
  }

  /**
   * 从 chrome.storage.sync 读取设置，并与默认值合并
   * 确保新增的默认字段在旧数据中也能获得默认值
   * @returns {Promise<Object>} 合并后的设置对象
   */
  function getSettings() {
    return new Promise(function (resolve) {
      // chrome.storage 在某些非扩展环境（如单元测试）下可能不存在，做容错处理
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync) {
        return resolve(getDefaultSettings());
      }
      chrome.storage.sync.get(SETTINGS_KEY, function (result) {
        var stored = result[SETTINGS_KEY] || {};
        var merged = Object.assign({}, getDefaultSettings(), stored);
        resolve(merged);
      });
    });
  }

  /**
   * 保存设置到 chrome.storage.sync
   * @param {Object} settings - 要保存的设置对象
   * @returns {Promise<void>}
   */
  function saveSettings(settings) {
    return new Promise(function (resolve, reject) {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync) {
        return resolve();
      }
      if (!settings || typeof settings !== 'object') {
        return reject(new Error('保存设置失败：settings 参数无效'));
      }
      var payload = {};
      payload[SETTINGS_KEY] = settings;
      chrome.storage.sync.set(payload, function () {
        if (chrome.runtime.lastError) {
          reject(new Error('保存设置失败：' + chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * 内部方法：读取所有记录映射
   * @returns {Promise<Object>} { videoId: record }
   */
  function _readAllRecords() {
    return new Promise(function (resolve) {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        return resolve({});
      }
      chrome.storage.local.get(RECORDS_KEY, function (result) {
        var records = result[RECORDS_KEY] || {};
        resolve(records);
      });
    });
  }

  /**
   * 内部方法：写入所有记录映射
   * @param {Object} records - { videoId: record }
   * @returns {Promise<void>}
   */
  function _writeAllRecords(records) {
    return new Promise(function (resolve, reject) {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        return resolve();
      }
      var payload = {};
      payload[RECORDS_KEY] = records;
      chrome.storage.local.set(payload, function () {
        if (chrome.runtime.lastError) {
          reject(new Error('写入记录失败：' + chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * 保存视频处理记录到 chrome.storage.local
   * 若已存在相同 videoId 的记录则覆盖更新
   * @param {Object} record - 视频记录
   * @param {string} record.videoId - 视频 ID
   * @param {string} record.title - 视频标题
   * @param {string} record.channel - 频道名
   * @param {string} record.duration - 时长
   * @param {string} record.processDate - 处理日期（ISO 字符串）
   * @param {Array}  record.tags - 标签数组
   * @param {Array}  record.cards - 知识卡片数组
   * @param {string} record.notes - 笔记
   * @param {string} record.summary - 摘要
   * @param {string} record.subtitleQuality - 字幕质量
   * @returns {Promise<void>}
   */
  function saveVideoRecord(record) {
    return new Promise(function (resolve, reject) {
      if (!record || !record.videoId) {
        return reject(new Error('保存记录失败：record 或 record.videoId 缺失'));
      }
      // 补全默认字段，避免脏数据，同时保留传入的额外字段
      var normalized = {
        videoId: record.videoId,
        title: record.title || '',
        channel: record.channel || '',
        duration: record.duration || '',
        processDate: record.processDate || new Date().toISOString(),
        tags: Array.isArray(record.tags) ? record.tags : [],
        cards: Array.isArray(record.cards) ? record.cards : [],
        notes: record.notes || '',
        summary: record.summary || '',
        timeline: Array.isArray(record.timeline) ? record.timeline : [],
        subtitleQuality: record.subtitleQuality || '',
        url: record.url || '',
        createdAt: record.createdAt || Date.now()
      };

      _readAllRecords().then(function (records) {
        records[normalized.videoId] = normalized;
        return _writeAllRecords(records);
      }).then(function () {
        resolve();
      }).catch(function (err) {
        reject(err);
      });
    });
  }

  /**
   * 按 videoId 获取单条记录
   * @param {string} videoId - 视频 ID
   * @returns {Promise<Object|null>} 记录对象，不存在则返回 null
   */
  function getVideoRecord(videoId) {
    return new Promise(function (resolve, reject) {
      if (!videoId) {
        return reject(new Error('获取记录失败：videoId 缺失'));
      }
      _readAllRecords().then(function (records) {
        resolve(records[videoId] || null);
      }).catch(function (err) {
        reject(err);
      });
    });
  }

  /**
   * 获取所有记录，按 processDate 降序排列（最新的在前）
   * @returns {Promise<Array<Object>>} 记录数组
   */
  function getAllRecords() {
    return new Promise(function (resolve, reject) {
      _readAllRecords().then(function (records) {
        var list = Object.keys(records).map(function (id) {
          return records[id];
        });
        list.sort(function (a, b) {
          var da = a.processDate || '';
          var db = b.processDate || '';
          // 降序：b 在前则 b-a，字符串比较用 localeCompare 取反
          if (da < db) return 1;
          if (da > db) return -1;
          return 0;
        });
        resolve(list);
      }).catch(function (err) {
        reject(err);
      });
    });
  }

  /**
   * 删除单条记录
   * @param {string} videoId - 视频 ID
   * @returns {Promise<void>}
   */
  function deleteRecord(videoId) {
    return new Promise(function (resolve, reject) {
      if (!videoId) {
        return reject(new Error('删除记录失败：videoId 缺失'));
      }
      _readAllRecords().then(function (records) {
        if (!records[videoId]) {
          // 不存在也视为成功，幂等操作
          return resolve();
        }
        delete records[videoId];
        return _writeAllRecords(records);
      }).then(function () {
        resolve();
      }).catch(function (err) {
        reject(err);
      });
    });
  }

  /**
   * 清空所有记录
   * @returns {Promise<void>}
   */
  function clearAllRecords() {
    return _writeAllRecords({});
  }

  /**
   * 返回记录数量
   * @returns {Promise<number>}
   */
  function getRecordCount() {
    return new Promise(function (resolve, reject) {
      _readAllRecords().then(function (records) {
        resolve(Object.keys(records).length);
      }).catch(function (err) {
        reject(err);
      });
    });
  }

  return {
    getDefaultSettings: getDefaultSettings,
    getSettings: getSettings,
    saveSettings: saveSettings,
    saveVideoRecord: saveVideoRecord,
    getVideoRecord: getVideoRecord,
    getAllRecords: getAllRecords,
    deleteRecord: deleteRecord,
    clearAllRecords: clearAllRecords,
    getRecordCount: getRecordCount
  };
})();
