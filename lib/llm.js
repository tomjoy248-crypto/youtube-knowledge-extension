/**
 * llm.js - LLM API 调用封装（Anthropic Claude / OpenAI GPT）
 *
 * 全局对象：LLM
 * 负责调用大语言模型完成：字幕翻译、中文摘要、知识卡片抽取
 *
 * 路由逻辑：
 *   - 如果设置了自定义 API 地址（中转模式）：所有模型都走 OpenAI 兼容格式
 *     （国内中转平台如二狗 API 统一用 OpenAI /v1/chat/completions 接口）
 *   - 如果未设置自定义地址（直连模式）：
 *     - claude-* -> Anthropic Messages API
 *     - gpt-*    -> OpenAI Chat Completions API
 */

/* global fetch */

// 使用全局对象暴露 API（不使用 ES 模块）
window.LLM = (function () {
  'use strict';

  // API 端点
  var ANTHROPIC_URL = 'https://api.anthropic.com';
  var OPENAI_URL = 'https://api.openai.com';
  var ANTHROPIC_VERSION = '2023-06-01';
  var MAX_TOKENS = 4096;

  // 各模型的费用表（美元 / 千 token），用于估算成本
  var PRICING = {
    // Claude 系列
    'claude-fable-5': { input: 0.012, output: 0.060 },
    'claude-opus-5': { input: 0.010, output: 0.050 },
    'claude-sonnet-5': { input: 0.003, output: 0.015 },
    'claude-haiku-4-5': { input: 0.001, output: 0.005 },
    'claude-3-5-sonnet': { input: 0.003, output: 0.015 },
    'claude-3-5-haiku': { input: 0.0008, output: 0.004 },
    // OpenAI GPT 系列
    'gpt-4o': { input: 0.005, output: 0.015 },
    'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
    'gpt-4-turbo': { input: 0.01, output: 0.03 },
    'gpt-4': { input: 0.03, output: 0.06 },
    'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
    'o3-mini': { input: 0.0011, output: 0.0044 },
    'o4-mini': { input: 0.0011, output: 0.0044 }
  };

  // 翻译风格描述映射
  var STYLE_MAP = {
    readable: '通俗易读：使用自然流畅、面向大众的中文表达，避免生硬的机翻腔，必要时可适当意译以提升可读性。',
    academic: '学术严谨：使用准确规范的学术语言，术语翻译统一，保留原文逻辑层次，必要时附上英文术语对照。',
    casual: '口语化：使用轻松、贴近日常交流的中文表达，可以适当使用口语词，适合播客/访谈类内容。'
  };

  /**
   * 判断模型是否为 Claude 系列
   */
  function isClaudeModel(model) {
    return typeof model === 'string' && model.toLowerCase().indexOf('claude') === 0;
  }

  /**
   * 判断是否为 OpenAI 推理模型（o 系列）
   * o 系列模型不支持 max_tokens，需要用 max_completion_tokens
   */
  function isReasoningModel(model) {
    return typeof model === 'string' && model.toLowerCase().match(/^o\d/);
  }

  /**
   * 将 HTTP 响应状态码转换为带明确信息的 Error
   */
  function buildHttpError(status, bodyText) {
    var msg = '';
    try {
      var parsed = JSON.parse(bodyText);
      if (parsed && parsed.error && parsed.error.message) {
        msg = parsed.error.message;
      } else if (parsed && typeof parsed.error === 'string') {
        msg = parsed.error;
      } else if (parsed && typeof parsed.message === 'string') {
        msg = parsed.message;
      } else if (parsed && typeof parsed.detail === 'string') {
        msg = parsed.detail;
      }
    } catch (e) {
      msg = bodyText ? bodyText.slice(0, 300) : '';
    }

    switch (status) {
      case 401:
        return new Error('API 认证失败（401）：API Key 无效或已过期。' + (msg ? '详情：' + msg : ''));
      case 403:
        return new Error('API 访问被拒绝（403）：当前 Key 无权访问该模型或区域受限。' + (msg ? '详情：' + msg : ''));
      case 404:
        return new Error('API 资源不存在（404）：请检查模型名称和 API 地址是否正确。' + (msg ? '详情：' + msg : ''));
      case 429:
        return new Error('API 请求过于频繁（429）：已触发速率限制，请稍后重试。' + (msg ? '详情：' + msg : ''));
      case 500:
      case 502:
      case 503:
      case 504:
        return new Error('API 服务端错误（' + status + '）：服务暂时不可用，请稍后重试。' + (msg ? '详情：' + msg : ''));
      default:
        return new Error('API 请求失败（HTTP ' + status + '）。' + (msg ? '详情：' + msg : ''));
    }
  }

  function parseApiResponse(text, apiUrl) {
    var trimmed = String(text || '').trim();
    if (/^<!doctype\s+html|^<html[\s>]/i.test(trimmed)) {
      throw new Error(
        'API 返回了网页 HTML，而不是模型 JSON。当前请求地址：' + apiUrl +
        '。请不要填写控制台、登录页或密钥管理页地址；例如二狗 API 应填写 https://ergouapi.com/v1，不要填写包含 /keys 的地址。'
      );
    }

    try {
      return JSON.parse(trimmed);
    } catch (error) {
      throw new Error('API 返回内容不是有效 JSON。当前请求地址：' + apiUrl + '。返回片段：' + trimmed.slice(0, 200));
    }
  }

  /**
   * 构建完整的 OpenAI 兼容 API URL
   * 处理用户填入的各种格式：带/不带 /v1、带/不带尾斜杠
   * @param {string} baseUrl - 用户填入的 API 地址
   * @returns {string} 完整的 /v1/chat/completions URL
   */
  function buildOpenAIUrl(baseUrl) {
    if (!baseUrl) {
      return OPENAI_URL + '/v1/chat/completions';
    }
    var trimmed = baseUrl.replace(/\/+$/, ''); // 去掉尾斜杠
    // 如果已经包含 /v1
    if (trimmed.indexOf('/v1') === trimmed.length - 3) {
      return trimmed + '/chat/completions';
    }
    // 如果已经包含 /v1/chat/completions
    if (trimmed.indexOf('/chat/completions') !== -1) {
      return trimmed;
    }
    // 默认补全 /v1/chat/completions
    return trimmed + '/v1/chat/completions';
  }

  function buildResponsesUrl(baseUrl) {
    if (!baseUrl) return OPENAI_URL + '/v1/responses';
    var trimmed = baseUrl.replace(/\/+$/, '');
    if (trimmed.indexOf('/responses') !== -1) return trimmed;
    if (trimmed.indexOf('/chat/completions') !== -1) {
      return trimmed.replace(/\/chat\/completions.*$/, '/responses');
    }
    if (trimmed.indexOf('/v1') === trimmed.length - 3) return trimmed + '/responses';
    return trimmed + '/v1/responses';
  }

  function resolveApiProtocol(model, protocol) {
    if (protocol === 'responses' || protocol === 'chat') return protocol;
    return /^(gpt-5(?:\.|-|$)|codex)/i.test(model || '') ? 'responses' : 'chat';
  }

  function extractResponsesText(data) {
    if (data && typeof data.output_text === 'string' && data.output_text.trim()) {
      return data.output_text.trim();
    }
    var parts = [];
    var output = data && Array.isArray(data.output) ? data.output : [];
    for (var i = 0; i < output.length; i++) {
      var content = output[i] && Array.isArray(output[i].content) ? output[i].content : [];
      for (var j = 0; j < content.length; j++) {
        if (content[j] && typeof content[j].text === 'string') parts.push(content[j].text);
      }
    }
    if (parts.length) return parts.join('').trim();
    if (data && data.choices && data.choices[0] && data.choices[0].message) {
      return String(data.choices[0].message.content || '').trim();
    }
    return '';
  }

  function callResponses(apiKey, model, systemPrompt, userPrompt, jsonMode, baseUrl) {
    var apiUrl = buildResponsesUrl(baseUrl);
    var body = {
      model: model,
      instructions: systemPrompt,
      input: userPrompt,
      max_output_tokens: MAX_TOKENS
    };
    if (jsonMode) body.text = { format: { type: 'json_object' } };
    return fetch(apiUrl, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (resp) {
      return resp.text().then(function (text) {
        if (!resp.ok) throw buildHttpError(resp.status, text);
        var output = extractResponsesText(parseApiResponse(text, apiUrl));
        if (!output) throw new Error('Responses API 未返回文本内容');
        return output;
      });
    });
  }

  /**
   * 构建 Anthropic API URL
   * @param {string} baseUrl - 用户填入的 API 地址
   * @returns {string} 完整的 /v1/messages URL
   */
  function buildAnthropicUrl(baseUrl) {
    if (!baseUrl) {
      return ANTHROPIC_URL + '/v1/messages';
    }
    var trimmed = baseUrl.replace(/\/+$/, '');
    if (trimmed.indexOf('/v1') === trimmed.length - 3) {
      return trimmed + '/messages';
    }
    if (trimmed.indexOf('/v1/messages') !== -1) {
      return trimmed;
    }
    return trimmed + '/v1/messages';
  }

  /**
   * 调用 OpenAI Chat Completions API（也用于中转模式下的 Claude 模型）
   * @param {string} apiKey
   * @param {string} model
   * @param {string} systemPrompt
   * @param {string} userPrompt
   * @param {boolean} jsonMode - 是否尝试使用 response_format 强制返回 JSON
   * @param {string} [baseUrl] - 自定义 API 中转地址
   * @returns {Promise<string>} LLM 输出的文本
   */
  function callOpenAI(apiKey, model, systemPrompt, userPrompt, jsonMode, baseUrl) {
    var apiUrl = buildOpenAIUrl(baseUrl);
    var headers = {
      'Authorization': 'Bearer ' + apiKey,
      'content-type': 'application/json'
    };
    var body = {
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    };

    // o 系列推理模型用 max_completion_tokens，其他用 max_tokens
    if (isReasoningModel(model)) {
      body.max_completion_tokens = MAX_TOKENS;
    } else {
      body.max_tokens = MAX_TOKENS;
    }

    // JSON 模式：尝试用 response_format，但部分中转平台可能不支持
    // 如果带 response_format 的请求失败，会自动降级重试
    if (jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    return fetch(apiUrl, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
    }).then(function (resp) {
      return resp.text().then(function (text) {
        if (!resp.ok) {
          throw buildHttpError(resp.status, text);
        }
        var data = parseApiResponse(text, apiUrl);
        if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
          throw new Error('API 返回 choices 为空');
        }
        var output = data.choices[0].message && data.choices[0].message.content;
        if (!output) {
          throw new Error('API 未返回文本内容');
        }
        return String(output).trim();
      });
    });
  }

  /**
   * 调用 Anthropic Messages API（仅直连模式使用）
   * @param {string} apiKey
   * @param {string} model
   * @param {string} systemPrompt
   * @param {string} userPrompt
   * @returns {Promise<string>} LLM 输出的文本
   */
  function callAnthropic(apiKey, model, systemPrompt, userPrompt) {
    var apiUrl = buildAnthropicUrl(null); // 直连模式，不使用 baseUrl
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

    return fetch(apiUrl, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
    }).then(function (resp) {
      return resp.text().then(function (text) {
        if (!resp.ok) {
          throw buildHttpError(resp.status, text);
        }
        var data = parseApiResponse(text, apiUrl);
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
   * 决定调用方式：
   * - 有 baseUrl（中转模式）：所有模型走 OpenAI 格式
   * - 无 baseUrl（直连模式）：Claude 走 Anthropic 格式，其他走 OpenAI 格式
   */
  function callLLM(apiKey, model, systemPrompt, userPrompt, jsonMode, baseUrl, apiProtocol) {
    var useProxy = !!baseUrl;
    var protocol = resolveApiProtocol(model, apiProtocol);

    if (protocol === 'responses' && (useProxy || !isClaudeModel(model))) {
      return callResponses(apiKey, model, systemPrompt, userPrompt, jsonMode, baseUrl)
        .catch(function (err) {
          if (jsonMode && err && err.message && /text\.format|json_object|response_format/i.test(err.message)) {
            console.warn('[知视] Responses JSON 模式不支持，降级重试...');
            return callResponses(apiKey, model, systemPrompt, userPrompt, false, baseUrl);
          }
          throw err;
        });
    }

    if (useProxy) {
      // 中转模式：统一走 OpenAI 兼容格式
      return callOpenAI(apiKey, model, systemPrompt, userPrompt, jsonMode, baseUrl)
        .catch(function (err) {
          // 如果是 response_format 不支持导致的错误，降级重试
          if (jsonMode && err && err.message && err.message.indexOf('response_format') !== -1) {
            console.warn('[知视] response_format 不支持，降级重试...');
            return callOpenAI(apiKey, model, systemPrompt, userPrompt, false, baseUrl);
          }
          throw err;
        });
    }

    // 直连模式
    if (isClaudeModel(model)) {
      return callAnthropic(apiKey, model, systemPrompt, userPrompt);
    } else {
      return callOpenAI(apiKey, model, systemPrompt, userPrompt, jsonMode, null);
    }
  }

  function getRequestInfo(model, baseUrl, apiProtocol) {
    var protocol = resolveApiProtocol(model, apiProtocol);
    if (protocol === 'responses' && (baseUrl || !isClaudeModel(model))) {
      return {
        protocol: 'OpenAI Responses API',
        url: buildResponsesUrl(baseUrl)
      };
    }
    if (baseUrl || !isClaudeModel(model)) {
      return {
        protocol: 'OpenAI 兼容接口',
        url: buildOpenAIUrl(baseUrl)
      };
    }

    return {
      protocol: 'Anthropic Messages 接口',
      url: buildAnthropicUrl(null)
    };
  }

  /**
   * 从 LLM 返回文本中提取并解析 JSON
   * 兼容模型在 JSON 外包裹 ```json 代码块或额外说明文字的情况
   */
  function extractJSON(text) {
    if (!text) {
      throw new Error('LLM 返回内容为空，无法解析 JSON');
    }
    var cleaned = text.trim();

    // 去除 markdown 代码块包裹
    if (cleaned.indexOf('```') === 0) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '');
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
   * @param {string} style - 翻译风格
   * @param {string} [baseUrl] - 自定义 API 中转地址
   * @returns {Promise<Object>} { translation, summary, cards }
   */
  function processChunk(apiKey, model, chunkText, style, baseUrl, apiProtocol) {
    if (!chunkText) {
      return Promise.reject(new Error('processChunk 失败：chunkText 为空'));
    }
    style = style || 'readable';
    var styleDesc = STYLE_MAP[style] || STYLE_MAP.readable;

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

    var userPrompt = [
      '请处理以下英文字幕文本，返回 JSON：',
      '',
      '"""',
      chunkText,
      '"""'
    ].join('\n');

    return callLLM(apiKey, model, systemPrompt, userPrompt, true, baseUrl, apiProtocol)
      .then(function (output) {
        var obj = extractJSON(output);
        var result = {
          translation: typeof obj.translation === 'string' ? obj.translation : '',
          summary: typeof obj.summary === 'string' ? obj.summary : '',
          cards: Array.isArray(obj.cards) ? obj.cards : []
        };
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
      })
      .catch(function (err) {
        if (err && err.name === 'TypeError') {
          throw new Error('网络请求失败：无法连接到 API 服务，请检查 API 地址是否正确。' + (err.message ? '（' + err.message + '）' : ''));
        }
        throw err;
      });
  }

  /**
   * 估算 API 调用费用（美元）
   */
  function estimateCost(model, inputTokens, outputTokens) {
    inputTokens = Number(inputTokens) || 0;
    outputTokens = Number(outputTokens) || 0;
    if (!model) {
      return 0;
    }
    var price = PRICING[model];
    if (!price) {
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
    var cost = (inputTokens / 1000) * price.input + (outputTokens / 1000) * price.output;
    return Math.round(cost * 1000000) / 1000000;
  }

  return {
    process: function (apiKey, model, systemPrompt, userPrompt, baseUrl, apiProtocol) {
      return callLLM(apiKey, model, systemPrompt, userPrompt, false, baseUrl, apiProtocol);
    },
    processChunk: processChunk,
    getRequestInfo: getRequestInfo,
    estimateCost: estimateCost
  };
})();
