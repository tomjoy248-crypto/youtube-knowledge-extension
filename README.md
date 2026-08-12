# 知视 KnowledgeView

> 将 YouTube 英文长视频自动转化为结构化中文知识卡片、笔记和时间轴摘要的 Chrome 浏览器扩展。

## 功能概览

- **自动字幕提取**：通过 YouTube 播放器 API 获取英文字幕（支持手动字幕和自动生成字幕）
- **AI 驱动翻译**：调用 Claude / GPT 等 LLM 将英文字幕翻译为中文，支持 3 种翻译风格
- **知识卡片生成**：自动抽取 4 种类型的知识卡片（概念、流程、对比、问答），含中英对照
- **结构化笔记**：生成 Markdown 格式的完整学习笔记，按类型分组
- **时间轴摘要**：将视频内容按时间分章节，每个节点可点击跳转到视频对应位置
- **本地缓存**：已处理的视频记录保存在本地，再次打开时秒加载
- **多格式导出**：支持 Markdown、JSON、纯文本三种导出格式

## 安装方法

1. 下载或克隆本项目到本地
2. 打开 Chrome，地址栏输入 `chrome://extensions/`
3. 右上角开启「开发者模式」
4. 点击「加载已解压的扩展程序」，选择本项目根目录
5. 首次安装会自动打开设置页，配置 API Key 和模型

## 使用方法

1. 打开任意有英文字幕的 YouTube 视频
2. 页面右侧自动出现知视侧边栏
3. 点击「生成中文知识资料」按钮
4. 等待处理完成后，通过 4 个 Tab 浏览结果：
   - **摘要**：结构化中文摘要，分章节列出核心要点
   - **知识卡片**：4 种类型的知识卡片，可展开查看详情和英文原文
   - **笔记**：完整 Markdown 学习笔记
   - **时间轴**：视频内容分章节时间轴，点击跳转
5. 点击导出按钮可将结果保存为 Markdown / JSON / 纯文本

## 支持的 LLM 模型

| 平台 | 模型 |
|------|------|
| Anthropic | Claude 3.5 Sonnet / Haiku |
| OpenAI | GPT-4o / GPT-4o mini / GPT-4 Turbo / GPT-3.5 Turbo |

## 项目结构

```
youtube-knowledge-extension/
├── manifest.json              # Chrome 扩展配置 (Manifest V3)
├── background.js              # Service Worker
├── content/
│   ├── main-world.js          # MAIN World 脚本 (YouTube API 桥接)
│   ├── content.js             # 主 Content Script (页面检测/侧边栏/处理流程)
│   └── content.css            # 侧边栏宿主样式
├── lib/
│   ├── storage.js             # 数据存储管理 (chrome.storage)
│   ├── llm.js                 # LLM API 调用 (Claude/GPT)
│   ├── subtitle.js            # 字幕获取与解析
│   └── processor.js           # 文本处理/分块/聚合
├── sidebar/
│   ├── sidebar.html           # 侧边栏 HTML
│   ├── sidebar.css            # 侧边栏样式 (Shadow DOM)
│   └── sidebar.js             # 侧边栏交互逻辑
├── settings/
│   ├── settings.html          # 设置页面
│   ├── settings.css           # 设置页面样式
│   └── settings.js            # 设置页面逻辑
└── icons/                     # 扩展图标
```

## 技术架构

- **Manifest V3**：使用最新版 Chrome 扩展规范
- **双 World 注入**：MAIN World 脚本直接访问 YouTube 播放器 API，ISOLATED World 脚本处理扩展逻辑
- **Shadow DOM**：侧边栏 UI 完全隔离，不影响 YouTube 页面样式
- **Promise.allSettled**：多分块并行 LLM 调用，单个分块失败不影响整体
- **语义分块**：按时间间隔、句子数量、字符数三维度智能切分字幕

## 配置说明

在设置页面可配置：

- **API Key**：Anthropic 或 OpenAI 的 API 密钥
- **LLM 模型**：选择使用的模型
- **翻译风格**：通俗易读 / 学术严谨 / 口语化
- **双语字幕**：是否同时显示原文和中文翻译
- **自动生成**：打开视频时自动生成知识资料
- **侧边栏默认展开**：页面加载时自动展开侧边栏

## License

MIT
