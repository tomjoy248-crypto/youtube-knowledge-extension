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
- **地址直接解析**：支持粘贴 watch、shorts、embed、live、youtu.be 链接或 11 位视频 ID，自动打开视频并开始解析

---

## 使用流程

### 第一步：下载安装包

进入 [Releases 发布页面](https://github.com/tomjoy248-crypto/youtube-knowledge-extension/releases)，下载最新的 `KnowledgeView-v1.0.4.zip`，然后解压到本地任意位置。

> 当前 GitHub Release 已更新为最新补丁包；如果你之前下载过旧包，请重新下载这一版。


### 第二步：加载扩展到 Chrome

1. 打开 Chrome 浏览器，地址栏输入 `chrome://extensions/` 回车
2. 页面**右上角**找到「开发者模式」开关，打开它
3. 页面**左上角**会出现三个按钮，点击「**加载已解压的扩展程序**」
4. 在弹出的文件夹选择框中，选中你解压出来的 `youtube-knowledge-extension` 文件夹（包含 `manifest.json` 的那个目录）
5. 如果在扩展列表中看到「知视 KnowledgeView」卡片（版本号 1.0.4），说明安装成功

> 注意：必须使用 Chrome 或 Edge 等基于 Chromium 的浏览器，Firefox 不支持。

### 第三步：配置 API Key（必须）

1. 首次安装会自动打开设置页面。如果没有自动打开，点击扩展列表中「知视」卡片的「**详情**」→「**扩展程序选项**」
2. 在设置页面中填写以下内容：

   | 配置项 | 说明 |
   |--------|------|
   | **LLM 模型** | 直接填写平台提供的模型 ID，例如 `gpt-5.4-mini` 或 `claude-sonnet-4-6` |
   | **API Key** | 填入你的 API 密钥（下方有获取方式） |
   | **API 地址** | 官方直连可留空；中转可填写根地址、`/v1` 或完整接口地址 |
   | **翻译风格** | 通俗易读 / 学术严谨 / 口语化，按需选择 |

3. 点击「保存设置」，看到「已保存」提示即可

**API Key 获取方式：**

| 平台 | 获取地址 | 说明 |
|------|---------|------|
| Anthropic Claude | https://console.anthropic.com/settings/keys | 注册后创建 API Key |
| OpenAI GPT | https://platform.openai.com/api-keys | 注册后创建 API Key |

> 没有 API Key 也可以先安装扩展浏览界面，但点击「生成」时会报错。`GPT-4o mini` 费用最低，适合测试。

### 第四步：粘贴地址并自动解析

1. 在设置页顶部的「YouTube 视频地址」输入框粘贴视频链接
2. 点击「打开并解析」，扩展会规范化链接、打开视频并自动开始生成
3. 也可以在任意 YouTube 视频右侧的知视侧边栏中粘贴另一个视频地址
4. 支持 `watch`、`shorts`、`embed`、`live`、`youtu.be` 链接，也可以直接输入 11 位视频 ID


### 第五步：使用扩展

1. 访问 [youtube.com](https://www.youtube.com)，打开任意一个**有英文字幕**的视频，或按上一步直接粘贴地址
2. 页面右侧会自动出现知视侧边栏
3. 确认视频有字幕：点击播放器右下角的「CC」按钮，有英文字幕选项就能用
4. 点击侧边栏中的「**生成中文知识资料**」蓝色按钮
5. 扩展会依次执行 5 个步骤：

   | 步骤 | 说明 |
   |------|------|
   | 获取视频信息 | 读取视频标题、时长等 |
   | 提取字幕内容 | 从 YouTube 获取英文字幕 |
   | 分析视频内容 | LLM 逐段翻译和分析 |
   | 生成知识资料 | 提取卡片、笔记、时间轴 |
   | 整理完成 | 聚合结果并保存 |

6. 处理时间取决于视频长度和模型速度，通常 **1-3 分钟**
7. 处理过程中不要关闭或刷新 YouTube 页面

### 第六步：浏览与导出

处理完成后，通过侧边栏顶部 4 个 Tab 浏览结果：

| Tab | 内容 |
|-----|------|
| **摘要** | 结构化中文摘要，分章节列出核心要点，内嵌可点击时间戳 |
| **知识卡片** | 4 种类型（概念/流程/对比/问答），每张卡片含中文释义 + 英文原文 + 时间戳，点击标题展开详情 |
| **笔记** | 完整 Markdown 格式学习笔记，支持标题/列表/引用块/时间戳跳转 |
| **时间轴** | 视频内容按时间分章节，每个节点点击可跳转到视频对应位置 |

**导出**：点击右上角 📥 按钮，选择导出格式：
- Markdown（推荐，可导入 Notion/Obsidian/Typora）
- JSON（结构化数据，适合程序处理）
- 纯文本（通用格式）

### 常见问题

**Q：侧边栏没有出现？**
刷新一下 YouTube 页面即可。如果仍不出现，检查扩展是否已启用。

**Q：点击生成后报错？**
检查 API Key 是否正确填写。如果使用 Claude 模型，确保 Key 以 `sk-ant-` 开头；如果使用 GPT 模型，确保 Key 以 `sk-` 开头。

**Q：粘贴地址后提示字幕为空？**
确认视频提供字幕，然后刷新视频页重试。`v1.0.4` 会同时尝试转写面板、JSON3、XML 和 WebVTT 字幕格式，兼容 YouTube 当前的延迟加载。

**Q：处理很慢？**
视频越长处理越慢。建议先用 5-15 分钟的短视频测试。`GPT-4o mini` 速度较快且费用最低。

**Q：如何确认视频有英文字幕？**
点击视频播放器右下角的「CC」按钮，如果有英文选项就能用。大部分 TED 演讲、技术教程都有英文字幕。

**Q：同一视频再次打开会重新生成吗？**
不会。已处理的视频会缓存在本地，再次打开直接加载结果，不消耗 API 额度。可以在设置页「数据管理」中清理缓存。

**Q：Chrome 提示「开发者模式扩展」？**
这是正常安全提示，点击「忽略」即可，不影响使用。

---

## 支持的 LLM 模型

模型名可以直接手填，支持你所接入平台提供的任意 OpenAI 兼容或 Anthropic 兼容模型 ID。设置页里保留了常见模型示例，方便快速选择/复制，例如：

- `gpt-5.4-mini`
- `gpt-5.6-luna`
- `gpt-5.4`
- `gpt-5.5`
- `gpt-4o-mini`
- `gpt-4o`
- `o3-mini`
- `o4-mini`
- `claude-haiku-4-5`
- `claude-haiku-4-5-20251001`
- `claude-sonnet-5`
- `claude-sonnet-4-6`
- `claude-opus-5`

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
- **LLM 模型**：可手填任意平台支持的模型 ID，也可从示例中快速填入
- **API 地址**：可选，留空直连官方；填写中转时支持根地址、`/v1` 或完整接口
- **翻译风格**：通俗易读 / 学术严谨 / 口语化
- **双语字幕**：是否同时显示原文和中文翻译
- **自动生成**：打开视频时自动生成知识资料
- **侧边栏默认展开**：页面加载时自动展开侧边栏

## License

MIT
