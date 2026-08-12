/**
 * processor.js - 文本预处理、语义分块、结果聚合与格式化输出
 *
 * 全局对象：Processor
 * 负责：
 *   - 清洗字幕（去重、修复断句、合并碎片）
 *   - 语义分块（按时间间隔与句子数量切分）
 *   - 构建 LLM 提示词
 *   - 聚合多分块结果为最终结构化笔记
 *   - 生成 Markdown 笔记与 Anki CSV
 *   - 时间戳格式化
 */

/* global window */

// 使用全局对象暴露 API（不使用 ES 模块）
window.Processor = (function () {
  'use strict';

  // 翻译风格映射（与 llm.js 中的 STYLE_MAP 保持一致语义）
  var STYLE_DESC = {
    readable: '通俗易读',
    academic: '学术严谨',
    casual: '口语化'
  };

  // 卡片类型中文名映射
  var CARD_TYPE_LABEL = {
    concept: '概念',
    process: '流程',
    compare: '对比',
    qa: '问答'
  };

  /**
   * 将秒数格式化为 MM:SS 或 H:MM:SS
   * @param {number} seconds - 秒数
   * @returns {string} 格式化后的时间戳
   */
  function formatTimestamp(seconds) {
    seconds = Number(seconds) || 0;
    if (seconds < 0) {
      seconds = 0;
    }
    // 取整
    var total = Math.floor(seconds);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    // 补零
    var mm = (m < 10 ? '0' : '') + m;
    var ss = (s < 10 ? '0' : '') + s;
    if (h > 0) {
      var hh = (h < 10 ? '0' : '') + h;
      return hh + ':' + mm + ':' + ss;
    }
    return mm + ':' + ss;
  }

  /**
   * 判断文本是否以句子结束标点结尾（中英文）
   * @param {string} text
   * @returns {boolean}
   */
  function endsWithSentencePunct(text) {
    if (!text) {
      return false;
    }
    var t = text.trim();
    if (!t) {
      return false;
    }
    return /[.!?。！？]$/.test(t);
  }

  /**
   * 清洗字幕：
   *   - 去除重复行（文本完全相同或高度相似）
   *   - 修复断句（合并被错误截断的句子：不以句号结尾且下一行小写开头等）
   *   - 合并碎片化段落（过短的行合并到相邻行）
   * @param {Array<{start:number, dur:number, text:string}>} lines - 原始字幕行
   * @returns {Array<{start:number, dur:number, text:string}>} 清洗后的字幕行
   */
  function cleanSubtitles(lines) {
    if (!Array.isArray(lines) || lines.length === 0) {
      return [];
    }

    // 第一步：去除完全相同的重复行（保留首次出现）
    var deduped = [];
    var seenTexts = {};
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line || !line.text) {
        continue;
      }
      var text = String(line.text).trim();
      if (!text) {
        continue;
      }
      // 标准化用于去重的 key：小写 + 去除多余空白
      var key = text.toLowerCase().replace(/\s+/g, ' ');
      if (seenTexts[key]) {
        // 跳过重复行
        continue;
      }
      seenTexts[key] = true;
      deduped.push({
        start: line.start || 0,
        dur: line.dur || 0,
        text: text
      });
    }

    if (deduped.length === 0) {
      return [];
    }

    // 第二步：修复断句 —— 合并被错误截断的句子
    // 规则：当前行不以句子结束标点结尾，且与下一行拼接后更完整，则合并
    var merged = [deduped[0]];
    for (var j = 1; j < deduped.length; j++) {
      var prev = merged[merged.length - 1];
      var curr = deduped[j];
      var prevText = prev.text;
      var currText = curr.text;

      // 判断是否应合并到上一行：
      // 1) 上一行不以句号结尾（被截断）
      // 2) 上一行词数较少（碎片化，< 6 词）
      // 3) 上一行不以省略号或冒号结尾（可能是列表/对话，不合并）
      var prevWords = prevText.split(/\s+/).filter(Boolean).length;
      var prevEndsWithListMark = /[:：…]$/.test(prevText.trim());
      var prevEndsSentence = endsWithSentencePunct(prevText);

      // 时间间隔判断：两行间隔超过 5 秒视为不同句，不合并
      var gap = Math.abs((curr.start || 0) - ((prev.start || 0) + (prev.dur || 0)));

      if (!prevEndsSentence && !prevEndsWithListMark && prevWords < 8 && gap < 5) {
        // 合并到上一行
        prev.text = prevText + ' ' + currText;
        // 持续时间延长到当前行结束
        prev.dur = ((curr.start || 0) + (curr.dur || 0)) - (prev.start || 0);
        if (prev.dur < 0) {
          prev.dur = curr.dur || 0;
        }
      } else {
        merged.push({
          start: curr.start || 0,
          dur: curr.dur || 0,
          text: currText
        });
      }
    }

    // 第三步：合并碎片化段落 —— 过短的行（词数 < 3）合并到相邻行
    var final = [];
    for (var k = 0; k < merged.length; k++) {
      var item = merged[k];
      var words = item.text.split(/\s+/).filter(Boolean).length;
      if (words < 3 && final.length > 0) {
        // 合并到前一行
        var prevItem = final[final.length - 1];
        prevItem.text = prevItem.text + ' ' + item.text;
        prevItem.dur = ((item.start || 0) + (item.dur || 0)) - (prevItem.start || 0);
        if (prevItem.dur < 0) {
          prevItem.dur = item.dur || 0;
        }
      } else {
        final.push(item);
      }
    }

    return final;
  }

  /**
   * 语义分块：按字幕行的时间戳和内容将字幕分为多个分块
   * 策略：
   *   - 时间间隔：超过 30 秒的间隔作为分界点
   *   - 句子数量：每块约 15-20 句
   *   - 字符数：不超过 targetSize 对应的字符数上限
   * 每个分块包含：{ text:'', startTime:0, lines:[] }
   * @param {Array<{start:number, dur:number, text:string}>} lines - 字幕行
   * @param {number} [targetSize=2000] - 目标 token 数（约 4 字符/token）
   * @returns {Array<{text:string, startTime:number, lines:Array}>} 分块数组
   */
  function semanticChunk(lines, targetSize) {
    if (!Array.isArray(lines) || lines.length === 0) {
      return [];
    }
    // 默认 2000 tokens，约 8000 字符（英文约 4 字符/token）
    targetSize = targetSize || 2000;
    var maxChars = targetSize * 4;
    // 每块最大句数
    var maxSentencesPerChunk = 20;
    var minSentencesPerChunk = 15;
    // 时间间隔阈值（秒）
    var gapThreshold = 30;

    var chunks = [];
    var currentLines = [];
    var currentTextParts = [];
    var currentChars = 0;
    var currentStart = 0;

    function pushChunk() {
      if (currentLines.length === 0) {
        return;
      }
      chunks.push({
        text: currentTextParts.join(' ').trim(),
        startTime: currentStart,
        lines: currentLines
      });
      currentLines = [];
      currentTextParts = [];
      currentChars = 0;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line || !line.text) {
        continue;
      }
      var text = String(line.text).trim();
      if (!text) {
        continue;
      }
      var lineChars = text.length + 1; // +1 空格

      // 判断是否应在此处分块
      var shouldSplit = false;

      // 条件1：当前块非空，且与上一行时间间隔超过阈值
      if (currentLines.length > 0) {
        var prevLine = currentLines[currentLines.length - 1];
        var prevEnd = (prevLine.start || 0) + (prevLine.dur || 0);
        var gap = (line.start || 0) - prevEnd;
        if (gap > gapThreshold) {
          shouldSplit = true;
        }
      }

      // 条件2：当前块句数已达上限
      if (currentLines.length >= maxSentencesPerChunk) {
        shouldSplit = true;
      }

      // 条件3：加入本行后字符数超过上限
      if (currentChars + lineChars > maxChars && currentLines.length >= minSentencesPerChunk) {
        shouldSplit = true;
      }

      if (shouldSplit) {
        pushChunk();
        currentStart = line.start || 0;
      } else if (currentLines.length === 0) {
        currentStart = line.start || 0;
      }

      currentLines.push({
        start: line.start || 0,
        dur: line.dur || 0,
        text: text
      });
      currentTextParts.push(text);
      currentChars += lineChars;
    }

    // 推送最后一个分块
    pushChunk();

    return chunks;
  }

  /**
   * 构建发送给 LLM 的 user prompt，要求 LLM 处理该分块并返回 JSON
   * 明确要求返回：translation、summary、cards（每个卡片含 type/title/definition/englishOriginal）
   * @param {string} chunkText - 分块文本
   * @param {string} style - 翻译风格：'readable' | 'academic' | 'casual'
   * @returns {string} user prompt
   */
  function buildChunkPrompt(chunkText, style) {
    style = style || 'readable';
    var styleDesc = STYLE_DESC[style] || STYLE_DESC.readable;

    var prompt = [
      '请处理以下英文字幕分块文本，完成翻译、摘要与知识卡片抽取。',
      '翻译风格要求：' + styleDesc + '。',
      '',
      '请严格返回如下 JSON 结构（不要输出任何其他内容、不要使用 markdown 代码块）：',
      '{',
      '  "translation": "将该分块英文完整翻译为中文，保留原文段落结构",',
      '  "summary": "用 2-4 句中文概括该分块的核心要点",',
      '  "cards": [',
      '    {',
      '      "type": "concept | process | compare | qa",',
      '      "title": "卡片标题（中文，简洁概括）",',
      '      "definition": "卡片内容说明（中文；qa 类型时为答案；compare 类型时为对比结论）",',
      '      "englishOriginal": "对应的英文原文片段（保留原文）"',
      '    }',
      '  ]',
      '}',
      '',
      '卡片类型说明：',
      '- concept：概念定义类，解释某个概念/术语是什么',
      '- process：流程步骤类，描述如何做某事或操作步骤',
      '- compare：对比分析类，比较两个或多个事物的异同',
      '- qa：问答类，重要的提问及其解答',
      '',
      '要求：',
      '- translation 必须完整覆盖原文内容，不要遗漏或自行删减',
      '- cards 数组可为空，但不要编造原文中不存在的内容',
      '- 只返回 JSON 本身，确保其可被 JSON.parse 直接解析',
      '',
      '待处理的字幕文本如下：',
      '"""',
      chunkText,
      '"""'
    ].join('\n');

    return prompt;
  }

  /**
   * 聚合多个分块的处理结果为最终结果
   *   - 合并所有摘要为全文摘要（分段，每段前加章节标题，如「第 1 部分 [MM:SS]」）
   *   - 合并所有卡片（去重：相同 title 的保留第一个）
   *   - 生成结构化笔记
   *   - 生成时间轴（每个分块的起始时间 + 摘要）
   * @param {Array<Object>} chunkResults - 各分块的处理结果，每个含 { translation, summary, cards, startTime }
   * @param {Object} videoInfo - 视频信息 { videoId, title, channel, duration }
   * @returns {{summary:string, cards:Array, notes:string, timeline:Array}}
   */
  function aggregateResults(chunkResults, videoInfo) {
    if (!Array.isArray(chunkResults)) {
      chunkResults = [];
    }
    videoInfo = videoInfo || {};

    // 过滤无效分块结果
    var validResults = chunkResults.filter(function (r) {
      return r && typeof r === 'object';
    });

    // 1. 合并摘要：每段前加章节标题
    var summaryParts = [];
    var timeline = [];
    for (var i = 0; i < validResults.length; i++) {
      var r = validResults[i];
      var startTime = (typeof r.startTime === 'number') ? r.startTime : 0;
      var ts = formatTimestamp(startTime);
      var chapterTitle = '第 ' + (i + 1) + ' 部分 [' + ts + ']';
      var summary = (typeof r.summary === 'string') ? r.summary.trim() : '';
      if (summary) {
        summaryParts.push('### ' + chapterTitle + '\n\n' + summary);
      }
      // 时间轴
      timeline.push({
        time: ts,
        seconds: startTime,
        chapterIndex: i + 1,
        summary: summary || '（本段无摘要）'
      });
    }
    var fullSummary = summaryParts.join('\n\n');

    // 2. 合并卡片：相同 title 的保留第一个
    var allCards = [];
    var seenCardTitles = {};
    for (var j = 0; j < validResults.length; j++) {
      var cards = validResults[j].cards;
      if (!Array.isArray(cards)) {
        continue;
      }
      for (var k = 0; k < cards.length; k++) {
        var card = cards[k];
        if (!card || typeof card !== 'object') {
          continue;
        }
        var title = (typeof card.title === 'string') ? card.title.trim() : '';
        if (!title) {
          continue;
        }
        // 去重 key：小写 + 去空白
        var key = title.toLowerCase().replace(/\s+/g, ' ');
        if (seenCardTitles[key]) {
          continue;
        }
        seenCardTitles[key] = true;
        allCards.push({
          type: card.type || 'concept',
          title: title,
          definition: card.definition || '',
          englishOriginal: card.englishOriginal || '',
          timestamp: card.timestamp || (validResults[j].startTime !== undefined ? formatTimestamp(validResults[j].startTime) : '')
        });
      }
    }

    // 3. 生成结构化笔记：按卡片类型分组
    var notesParts = [];
    var videoTitle = videoInfo.title || '未知视频';
    notesParts.push('# ' + videoTitle + ' - 学习笔记');
    if (videoInfo.channel) {
      notesParts.push('> 频道：' + videoInfo.channel);
    }
    notesParts.push('');

    // 全文摘要
    if (fullSummary) {
      notesParts.push('## 内容摘要');
      notesParts.push('');
      notesParts.push(fullSummary);
      notesParts.push('');
    }

    // 时间轴
    if (timeline.length > 0) {
      notesParts.push('## 时间轴');
      notesParts.push('');
      for (var t = 0; t < timeline.length; t++) {
        var tl = timeline[t];
        notesParts.push('- **[' + tl.time + ']** ' + tl.summary);
      }
      notesParts.push('');
    }

    // 知识卡片（按类型分组）
    if (allCards.length > 0) {
      notesParts.push('## 知识卡片');
      notesParts.push('');
      var grouped = { concept: [], process: [], compare: [], qa: [] };
      for (var c = 0; c < allCards.length; c++) {
        var tp = allCards[c].type;
        if (!grouped[tp]) {
          tp = 'concept';
        }
        grouped[tp].push(allCards[c]);
      }
      for (var typeKey in grouped) {
        if (!grouped.hasOwnProperty(typeKey)) {
          continue;
        }
        if (grouped[typeKey].length === 0) {
          continue;
        }
        notesParts.push('### ' + (CARD_TYPE_LABEL[typeKey] || typeKey) + '类');
        notesParts.push('');
        for (var ci = 0; ci < grouped[typeKey].length; ci++) {
          var cItem = grouped[typeKey][ci];
          var ts2 = cItem.timestamp ? ' [' + cItem.timestamp + ']' : '';
          notesParts.push('#### ' + cItem.title + ts2);
          if (cItem.definition) {
            notesParts.push(cItem.definition);
          }
          if (cItem.englishOriginal) {
            notesParts.push('> 原文：' + cItem.englishOriginal);
          }
          notesParts.push('');
        }
      }
    }

    var notes = notesParts.join('\n');

    return {
      summary: fullSummary,
      cards: allCards,
      notes: notes,
      timeline: timeline
    };
  }

  /**
   * 将结果转为 Markdown 格式笔记，时间戳格式为 [MM:SS]，可点击跳转
   * 跳转链接格式：https://www.youtube.com/watch?v=VIDEO_ID&t=Xs
   * @param {Object} result - aggregateResults 的返回值
   * @param {Object} videoInfo - { videoId, title, channel, duration }
   * @returns {string} Markdown 文本
   */
  function generateMarkdown(result, videoInfo) {
    result = result || {};
    videoInfo = videoInfo || {};
    var videoId = videoInfo.videoId || SubtitleFetcher_getVideoId();
    var parts = [];

    // 标题
    var title = videoInfo.title || 'YouTube 视频笔记';
    parts.push('# ' + title);
    parts.push('');

    // 元信息
    var meta = [];
    if (videoInfo.channel) {
      meta.push('**频道**：' + videoInfo.channel);
    }
    if (videoInfo.duration) {
      meta.push('**时长**：' + videoInfo.duration);
    }
    meta.push('**视频ID**：' + (videoId || '未知'));
    if (meta.length > 0) {
      parts.push(meta.join('  |  '));
      parts.push('');
    }

    // 视频链接
    if (videoId) {
      parts.push('> [观看原视频](https://www.youtube.com/watch?v=' + videoId + ')');
      parts.push('');
    }

    // 生成可点击时间戳的辅助函数
    function clickableTimestamp(seconds, label) {
      var ts = formatTimestamp(seconds);
      var secs = Math.floor(Number(seconds) || 0);
      if (videoId) {
        return '[[' + ts + ']](https://www.youtube.com/watch?v=' + videoId + '&t=' + secs + 's)';
      }
      return '[[' + ts + ']]';
    }

    // 内容摘要
    if (result.summary) {
      parts.push('## 内容摘要');
      parts.push('');
      // 将摘要中的 [MM:SS] 章节标题替换为可点击链接
      var summaryMd = result.summary;
      if (videoId) {
        // 匹配 [MM:SS] 或 [H:MM:SS] 并替换为可点击链接
        summaryMd = summaryMd.replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, function (match, ts) {
          var secs = parseTimestampToSeconds(ts);
          return '[[' + ts + ']](https://www.youtube.com/watch?v=' + videoId + '&t=' + secs + 's)';
        });
      }
      parts.push(summaryMd);
      parts.push('');
    }

    // 时间轴
    if (Array.isArray(result.timeline) && result.timeline.length > 0) {
      parts.push('## 时间轴');
      parts.push('');
      for (var i = 0; i < result.timeline.length; i++) {
        var tl = result.timeline[i];
        var tsLink = clickableTimestamp(tl.seconds, tl.time);
        parts.push('- ' + tsLink + ' ' + tl.summary);
      }
      parts.push('');
    }

    // 知识卡片
    if (Array.isArray(result.cards) && result.cards.length > 0) {
      parts.push('## 知识卡片');
      parts.push('');
      // 按类型分组展示
      var grouped = { concept: [], process: [], compare: [], qa: [] };
      for (var c = 0; c < result.cards.length; c++) {
        var tp = result.cards[c].type;
        if (!grouped[tp]) {
          tp = 'concept';
        }
        grouped[tp].push(result.cards[c]);
      }
      for (var typeKey in grouped) {
        if (!grouped.hasOwnProperty(typeKey)) {
          continue;
        }
        if (grouped[typeKey].length === 0) {
          continue;
        }
        parts.push('### ' + (CARD_TYPE_LABEL[typeKey] || typeKey) + ' (' + grouped[typeKey].length + ')');
        parts.push('');
        for (var ci = 0; ci < grouped[typeKey].length; ci++) {
          var card = grouped[typeKey][ci];
          var ts2 = '';
          if (card.timestamp) {
            var secs2 = parseTimestampToSeconds(card.timestamp);
            if (secs2 !== null) {
              ts2 = ' ' + clickableTimestamp(secs2, card.timestamp);
            } else {
              ts2 = ' [' + card.timestamp + ']';
            }
          }
          parts.push('#### ' + card.title + ts2);
          parts.push('');
          if (card.definition) {
            parts.push(card.definition);
            parts.push('');
          }
          if (card.englishOriginal) {
            parts.push('> **原文**：' + card.englishOriginal);
            parts.push('');
          }
        }
      }
    }

    // 笔记全文（如果 result.notes 存在则追加）
    if (result.notes && !result.summary) {
      parts.push('## 笔记');
      parts.push('');
      parts.push(result.notes);
      parts.push('');
    }

    return parts.join('\n');
  }

  /**
   * 将问答卡片和概念卡片转为 Anki CSV 格式（front, back, tags）
   *   - qa 卡片：front=问题(title)，back=答案(definition)，tags=qa;视频标题
   *   - concept 卡片：front=概念(title)，back=定义(definition)，tags=concept;视频标题
   *   - process/compare 卡片也一并导出，front=title，back=definition
   * 字段使用双引号包裹，内部双引号转义为两个双引号，以逗号分隔
   * @param {Object} result - aggregateResults 的返回值，需含 cards
   * @returns {string} CSV 文本（含表头）
   */
  function generateAnkiCSV(result) {
    result = result || {};
    var cards = Array.isArray(result.cards) ? result.cards : [];

    // CSV 转义：字段用双引号包裹，内部双引号转义为 ""
    function escapeField(value) {
      if (value === null || value === undefined) {
        return '""';
      }
      var s = String(value);
      s = s.replace(/"/g, '""');
      // 移除换行符，避免破坏 CSV 结构（Anki 支持换行，但为兼容性替换为 <br>）
      s = s.replace(/\r?\n/g, '<br>');
      return '"' + s + '"';
    }

    var rows = [];
    // 表头
    rows.push(escapeField('front') + ',' + escapeField('back') + ',' + escapeField('tags'));

    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      if (!card || !card.title) {
        continue;
      }
      var front = card.title;
      var back = card.definition || '';
      // 如果有英文原文，附加到 back
      if (card.englishOriginal) {
        back += (back ? '<br><br>' : '') + '原文：' + card.englishOriginal;
      }
      // 时间戳加入 front 末尾（便于定位）
      if (card.timestamp) {
        front += ' [' + card.timestamp + ']';
      }
      var tags = [card.type || 'concept'];
      rows.push(escapeField(front) + ',' + escapeField(back) + ',' + escapeField(tags.join(' ')));
    }

    return rows.join('\n');
  }

  /**
   * 辅助：将 MM:SS 或 H:MM:SS 时间戳解析为秒数
   * @param {string} ts
   * @returns {number|null}
   */
  function parseTimestampToSeconds(ts) {
    if (!ts) {
      return null;
    }
    var parts = String(ts).split(':');
    if (parts.length === 2) {
      var m = parseInt(parts[0], 10);
      var s = parseInt(parts[1], 10);
      if (!isNaN(m) && !isNaN(s)) {
        return m * 60 + s;
      }
    } else if (parts.length === 3) {
      var h = parseInt(parts[0], 10);
      var mm = parseInt(parts[1], 10);
      var ss = parseInt(parts[2], 10);
      if (!isNaN(h) && !isNaN(mm) && !isNaN(ss)) {
        return h * 3600 + mm * 60 + ss;
      }
    }
    return null;
  }

  /**
   * 辅助：安全获取当前视频 ID（避免对 SubtitleFetcher 的硬依赖循环）
   * 若 SubtitleFetcher 可用则调用其 getVideoId，否则返回空
   * @returns {string|null}
   */
  function SubtitleFetcher_getVideoId() {
    try {
      if (window.SubtitleFetcher && typeof window.SubtitleFetcher.getVideoId === 'function') {
        return window.SubtitleFetcher.getVideoId();
      }
    } catch (e) {
      // 忽略
    }
    return null;
  }

  return {
    cleanSubtitles: cleanSubtitles,
    semanticChunk: semanticChunk,
    buildChunkPrompt: buildChunkPrompt,
    aggregateResults: aggregateResults,
    generateMarkdown: generateMarkdown,
    generateAnkiCSV: generateAnkiCSV,
    formatTimestamp: formatTimestamp
  };
})();
