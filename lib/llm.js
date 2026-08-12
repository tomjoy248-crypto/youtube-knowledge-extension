/**
 * llm.js - LLM API 调用封装（Anthropic Claude / OpenAI GPT）
 *
 * 全局对象：LLM
 * 负责调用大语言模型完成：字幕翻译、中文摘要、知识卡片抽取
 * 根据 model 前缀自动选择对应的 API：
 *   - claude-*  -> Anthropic Messages API
 *   - gpt-*     -> OpenAI Chat Completions API
 */

/* global fetch */

// 使用全局对象暴露 API（不使用 ES 模块）
window.LLM = (function () {
  'use strict';

  // API 端点
  var ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
  var OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
  var ANTHROPIC_VERSION = '2023-06-01';
  var MAX_TOKENS = 4096;

  // 各模型的费用表（美元 / 千 token），用于估算成本
  // 如需更新，可在此扩展。单位：每千 token 价格
  var PRICING = {
    'claude-3-5-sonnet': { input: 0.003, output: 0.015 },
    'claude-3-5-sonnet-latest': { input: 0.003, output: 0.015 },
    'claude-3-5-haiku': { input: 0.0008, output: 0.004 },
    'claude-3-5-haiku-latest': { input: 0.0008, output: 0.004 },
    'claude-3-opus': { input: 0.015, output: 0.075 },
    'claude-3-sonnet': { input: 0.003, output: 0.015 },
    'claude-3-haiku': { input: 0.00025, output: 0.00125 },
    'gpt-4o': { input: 0.005, output: 0.015 },
    'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
    'gpt-4-turbo': { input: 0.01, output: 0.03 },
    'gpt-4': { input: 0.03, output: 0.06 },
    'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 }
  };

  // 翻译风格描述映射
  var STYLE_MAP = {
    readable: '通俗易读：使用自然流畅、面向大众的中文表达，避免生硬的机翻腔，必要时可适当意译以提升可读性。',
    academic: '学术严谨：使用准确规范的学术语言，术语翻译统一，保留原文逻辑层次，必要时附上英文术语对照。',
    casual: '口语化：使用轻松、贴近日常交流的中文表达，可以适当使用口语词，适合播客/访谈类内容。'
  };

  /**
   * 判断模型是否走 Anthropic API
   * @param {string} model - 模型名
   * @returns {boolean}
   */
  function isAnthropicModel(model) {
    return typeof model === 'string' && model.toLowerCase().indexOf('claude') === 0;
  }

  /**
   * 判断模型是否走 OpenAI API
   * @param {string} model - 模型名
   * @returns {boolean}
   */
  function isOpenAIModel(model) {
    return typeof model === 'string' && model.toLowerCase().indexOf('gpt') === 0;
  }

  /**
   * 将 HTTP 响应状态码转换为带明确信息的 Error
   * @param {number} status - HTTP 状态码
   * @param {string} bodyText - 响应体文本
   * @returns {Error}
   */
  function buildHttpError(status, bodyText) {
    var msg = '';
    try {
      var parsed = JSON.parse(bodyText);
      // Anthropic: { error: { message } }  OpenAI: { error: { message } }
      if (parsed && parsed.error && parsed.error.message) {
        msg = parsed.error.message;
      }
    } catch (e) {
      // 非 JSON，使用原始文本（截断）
      msg = bodyText ? bodyText.slice(0, 300) : '';
    }

    switch (status) {
      case 401:
        return new Error('API 认证失败（401）：API Key 无效或已过期。' + (msg ? '详情：' + msg : ''));
      case 403:
        return new Error('API 访问被拒绝（403）：当前 Key 无权访问该模型或区域受限。' + (msg ? '详情：' + msg : ''));
      case 404:
        return new Error('API 资源不存在（404）：请检查模型名称是否正确。' + (msg ? '详情：' + msg : ''));
      case 429:
        return new Error('API 请求过于频繁（429）：已触发速率限制，请稍后重试或降低请求频率。' + (msg ? '详情：' + msg : ''));
      case 500:
      case 502:
      case 503:
      case 504:
        return new Error('API 服务端错误（' + status + '）：服务暂时不可用，请稍后重试。' + (msg ? '详情：' + msg : ''));
      default:
        return new Error('API 请求失败（HTTP ' + status + '）。' + (msg ? '详情：' + msg : ''));
    }
  }

  /**
   * 调用 Anthropic Messages API
   * @param {string} apiKey
   * @param {string} model
   * @param {string} systemPrompt
   * @param {string} userPrompt
   * @param {boolean} jsonMode - 是否要求返回 JSON（Anthropic 通过 prompt 约束）
   * @returns {Promise<string>} LLM 输出的文本
   */
  function callAnthropic(apiKey, model, systemPrompt, userPrompt, jsonMode) {
    var headers = {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json'
    };
    var body = {
      model: model,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt }
      ]
    };

    return fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
    }).then(function (resp) {
      return resp.text().then(function (text) {
        if (!resp.ok) {
          throw buildHttpError(resp.status, text);
        }
        var data = JSON.parse(text);
        // Anthropic 返回结构：{ content: [ { type: 'text', text: '...' } ] }
        if (!data.content || !Array.isArray(data.content) || data.content.length === 0) {
          throw new Error('Anthropic API 返回内容为空');
        }
        var output = '';
        for (var i = 0; i < data.content.length; i++) {
          if (data.content[i].type === 'text') {
            output += data.content[i].text;
          }
        }
        if (!output) {
          throw new Error('Anthropic API 未返回文本内容');
        }
        return output.trim();
      });
    });
  }

  /**
   * 调用 OpenAI Chat Completions API
   * @param {string} apiKey
   * @param {string} model
   * @param {string} systemPrompt
   * @param {string} userPrompt
   * @param {boolean} jsonMode - 是否使用 response_format 强制返回 JSON
   * @returns {Promise<string>} LLM 输出的文本
   */
  function callOpenAI(apiKey, model, systemPrompt, userPrompt, jsonMode) {
    var headers = {
      'Authorization': 'Bearer ' + apiKey,
      'content-type': 'application/json'
    };
    var body = {
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: MAX_TOKENS
    };
    if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    return fetch(OPENAI_URL, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
    }).then(function (resp) {
      return resp.text().then(function (text) {
        if (!resp.ok) {
          throw buildHttpError(resp.status, text);
        }
        var data = JSON.parse(text);
        // OpenAI 返回结构：{ choices: [ { message: { content: '...' } } ] }
        if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
          throw new Error('OpenAI API 返回 choices 为空');
        }
        var output = data.choices[0].message && data.choices[0].message.content;
        if (!output) {
          throw new Error('OpenAI API 未返回文本内容');
        }
        return String(output).trim();
      });
    });
  }

  /**
   * 核心 API：根据 model 前缀选择 API 调用 LLM，返回生成的文本
   * @param {string} apiKey - API 密钥
   * @param {string} model - 模型名（claude-* 或 gpt-*）
   * @param {string} systemPrompt - 系统提示词
   * @param {string} userPrompt - 用户提示词
   * @returns {Promise<string>} LLM 生成的文本
   */
  function process(apiKey, model, systemPrompt, userPrompt) {
    // 参数校验
    if (!apiKey) {
      return Promise.reject(new Error('LLM 调用失败：缺少 API Key'));
    }
    if (!model) {
      return Promise.reject(new Error('LLM 调用失败：缺少模型名称'));
    }
    if (typeof systemPrompt !== 'string') {
      systemPrompt = systemPrompt || '';
    }
    if (typeof userPrompt !== 'string' || userPrompt.length === 0) {
      return Promise.reject(new Error('LLM 调用失败：userPrompt 为空'));
    }

    var promise;
    if (isAnthropicModel(model)) {
      promise = callAnthropic(apiKey, model, systemPrompt, userPrompt, false);
    } else if (isOpenAIModel(model)) {
      promise = callOpenAI(apiKey, model, systemPrompt, userPrompt, false);
    } else {
      return Promise.reject(new Error('不支持的模型类型：' + model + '（仅支持 claude-* 或 gpt-* 前缀）'));
    }

    return promise.catch(function (err) {
      // 网络错误（fetch 抛出 TypeError）统一包装
      if (err && err.name === 'TypeError') {
        throw new Error('网络请求失败：无法连接到 API 服务，请检查网络连接。' + (err.message ? '（' + err.message + '）' : ''));
      }
      throw err;
    });
  }

  /**
   * 从 LLM 返回文本中提取并解析 JSON
   * 兼容模型在 JSON 外包裹 ```json 代码块或额外说明文字的情况
   * @param {string} text - LLM 原始输出
   * @returns {Object} 解析后的对象
   */
  function extractJSON(text) {
    if (!text) {
      throw new Error('LLM 返回内容为空，无法解析 JSON');
    }
    var cleaned = text.trim();

    // 去除 markdown 代码块包裹
    if (cleaned.indexOf('```') === 0) {
      // 去掉开头的 ```json 或 ```
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '');
      // 去掉结尾的 ```
      cleaned = cleaned.replace(/\s*```$/i, '');
      cleaned = cleaned.trim();
    }

    // 尝试直接解析
    try {
      return JSON.parse(cleaned);
    } catch (e) {
      // 失败则尝试提取第一个 { ... } 块
      var start = cleaned.indexOf('{');
      var end = cleaned.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        var slice = cleaned.slice(start, end + 1);
        try {
          return JSON.parse(slice);
        } catch (e2) {
          // 继续抛出
        }
      }
      throw new Error('LLM 返回内容无法解析为 JSON。原始内容片段：' + cleaned.slice(0, 200));
    }
  }

  /**
   * 处理单个文本分块：同时完成翻译、摘要、知识卡片抽取
   * @param {string} apiKey - API 密钥
   * @param {string} model - 模型名
   * @param {string} chunkText - 分块文本（英文字幕）
   * @param {string} style - 翻译风格：'readable' | 'academic' | 'casual'
   * @returns {Promise<Object>} { translation, summary, cards }
   */
  function processChunk(apiKey, model, chunkText, style) {
    if (!chunkText) {
      return Promise.reject(new Error('processChunk 失败：chunkText 为空'));
    }
    style = style || 'readable';
    var styleDesc = STYLE_MAP[style] || STYLE_MAP.readable;

    // 构建系统提示词：要求 LLM 同时完成三件事并返回严格 JSON
    var systemPrompt = [
      '你是一名专业的视频内容分析师和中英翻译专家。',
      '你的任务是处理一段英文字幕文本，同时完成以下三项工作：',
      '1. 将英文字幕翻译为中文。翻译风格要求：' + styleDesc,
      '2. 生成该段内容的中文摘要（2-4 句话，概括核心要点）。',
      '3. 从内容中提取知识点，生成知识卡片。每张卡片必须归类为以下 4 种类型之一：',
      '   - concept：概念定义类（解释某个概念是什么）',
      '   - process：流程步骤类（描述如何做某事、操作步骤）',
      '   - compare：对比分析类（比较两个或多个事物的异同）',
      '   - qa：问答类（重要的问题及其答案）',
      '',
      '你必须严格返回 JSON 格式，不要包含任何额外的解释文字或 markdown 标记。',
      'JSON 结构如下：',
      '{',
      '  "translation": "完整的中文翻译文本",',
      '  "summary": "中文摘要",',
      '  "cards": [',
      '    {',
      '      "type": "concept|process|compare|qa",',
      '      "title": "卡片标题（中文）",',
      '      "definition": "卡片内容说明（中文，qa 类型时为答案）",',
      '      "englishOriginal": "对应的英文原文片段"',
      '    }',
      '  ]',
      '}',
      '',
      '注意事项：',
      '- translation 必须是完整的中文翻译，保留原文的段落结构。',
      '- cards 数组可以为空，但不要编造原文中不存在的内容。',
      '- 每个 card 的 type 必须是 concept/process/compare/qa 之一。',
      '- 只输出 JSON 本身，不要输出其他任何字符。'
    ].join('\n');

    // 用户提示词：待处理的分块文本
    var userPrompt = [
      '请处理以下英文字幕文本，返回 JSON：',
      '',
      '"""',
      chunkText,
      '"""'
    ].join('\n');

    // 根据模型选择调用方式，并强制 JSON 模式
    var callPromise;
    if (isAnthropicModel(model)) {
      callPromise = callAnthropic(apiKey, model, systemPrompt, userPrompt, true);
    } else if (isOpenAIModel(model)) {
      callPromise = callOpenAI(apiKey, model, systemPrompt, userPrompt, true);
    } else {
      return Promise.reject(new Error('不支持的模型类型：' + model + '（仅支持 claude-* 或 gpt-* 前缀）'));
    }

    return callPromise.then(function (output) {
      var obj = extractJSON(output);
      // 规范化输出结构，补全缺失字段
      var result = {
        translation: typeof obj.translation === 'string' ? obj.translation : '',
        summary: typeof obj.summary === 'string' ? obj.summary : '',
        cards: Array.isArray(obj.cards) ? obj.cards : []
      };
      // 校验并规范化每张卡片
      var validTypes = { concept: true, process: true, compare: true, qa: true };
      result.cards = result.cards.filter(function (c) {
        return c && typeof c === 'object';
      }).map(function (c) {
        return {
          type: validTypes[c.type] ? c.type : 'concept',
          title: typeof c.title === 'string' ? c.title : '',
          definition: typeof c.definition === 'string' ? c.definition : '',
          englishOriginal: typeof c.englishOriginal === 'string' ? c.englishOriginal : '',
          timestamp: typeof c.timestamp === 'string' ? c.timestamp : ''
        };
      });
      return result;
    }).catch(function (err) {
      if (err && err.name === 'TypeError') {
        throw new Error('网络请求失败：无法连接到 API 服务，请检查网络连接。' + (err.message ? '（' + err.message + '）' : ''));
      }
      throw err;
    });
  }

  /**
   * 估算 API 调用费用（美元）
   * @param {string} model - 模型名
   * @param {number} inputTokens - 输入 token 数
   * @param {number} outputTokens - 输出 token 数
   * @returns {number} 预估费用（美元），未知模型返回 0
   */
  function estimateCost(model, inputTokens, outputTokens) {
    inputTokens = Number(inputTokens) || 0;
    outputTokens = Number(outputTokens) || 0;
    if (!model) {
      return 0;
    }
    var price = PRICING[model];
    if (!price) {
      // 尝试匹配前缀（如 claude-3-5-sonnet-20241022）
      var lower = model.toLowerCase();
      var keys = Object.keys(PRICING);
      for (var i = 0; i < keys.length; i++) {
        if (lower.indexOf(keys[i]) === 0) {
          price = PRICING[keys[i]];
          break;
        }
      }
    }
    if (!price) {
      return 0;
    }
    // 价格单位为 美元/千 token
    var cost = (inputTokens / 1000) * price.input + (outputTokens / 1000) * price.output;
    // 保留 6 位小数
    return Math.round(cost * 1000000) / 1000000;
  }

  return {
    process: process,
    processChunk: processChunk,
    estimateCost: estimateCost
  };
})();
