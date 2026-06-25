# VR-Class · 沉浸式 AI 模拟课堂

> 想学什么，张口就来。VR-Class 让 AI 当你的私人老师，在虚拟教室里，把任意一个主题——一笔一画、分章节、带图带演示地，**讲给你看**。

学生说出今天想学什么，AI 即以老师的身份，在一间虚拟教室里，用**板书、图示、公式、动画和讲解**，按"是什么 / 为什么 / 怎么做"的教学节奏，分章节地把这堂课"上"出来。重点是**视觉化、有结构的沉浸式授课**，而非问答式聊天。

## 当前状态

🚀 **可运行的端到端原型** — 点题 → AI 现场生成一堂课 → 虚拟教室里播放。

### 快速开始

```bash
# 1) 示例模式（无需 API Key，验证整条链路）
npm run mock           # 等价 MOCK=1 node server/server.js

# 2) 接真 AI（现场生成任意主题）—— 二选一或都给
ANTHROPIC_API_KEY=sk-ant-xxxx npm start      # Claude 生成正文
DASHSCOPE_API_KEY=sk-xxxx     npm start      # 阿里云 Qwen 正文 + 通义万相配图 + 联网检索
```

然后打开 **http://localhost:8000**，输入任意主题即可上课。详见 [运行指南](docs/RUNNING.md)。

> 只想看界面：直接用浏览器双击打开 `prototype/classroom.html` 也行（不连后端时自动加载内置示例课）。

### 架构一图

```
浏览器（通用"演示脚本播放器"）
   │ ① POST /api/outline {topic}              → 大纲确认页（可一句话调深浅/换角度）
   │ ② POST /api/lesson/stream {topic,outline} → SSE：逐章下发
   ▼
后端 server.js + prompt.js + providers.js
   │ · 时效主题：先联网检索（DashScope）→ 注入生成
   │ · 逐章调文本模型（Claude 或 Qwen）→ 每章 SSE 推一个 chapter 事件
   ▼
前端：第 1 章到达即开播，后续边到边追加；image 场景后台经通义万相真生成、就位即现
   板书 9 类：text / formula / diagram / code / heatmap / quiz / chart / animation / image
   播放配 🔊 TTS 语音讲解（讲完一句才翻屏）+ 章节切换过渡
```

**核心思想：课 = 一段可播放的结构化脚本。** 前端是通用播放器，喂不同脚本就上不同的课。
体验流程：**点题 → 确认大纲 → 流式生成边到边播 → 配图就位即现 → 随时提问**；想一眼看全 9 类板书，开页面点「🎨 板书类型画廊」。

### 文档与产物

- 📘 [产品需求文档（PRD）](docs/PRD.md) — 产品定义、视觉呈现系统、内容生成管线、技术架构、MVP 与路线图。
- 🎨 [交互 / 视觉设计稿](docs/UX-Design.md) — 虚拟教室布局、板书演示动效、老师立绘、配色字体（含截图）。
- ▶️ [运行指南](docs/RUNNING.md) — 怎么跑、环境变量、接口、降级行为、下一步。
- 🖥️ [可交互前端 `prototype/classroom.html`](prototype/classroom.html) — 通用演示脚本播放器（虚拟教室 UI）。
- 🔌 [`server/`](server/) — 零依赖后端：`server.js`（HTTP + 流式编排）· `prompt.js`（内容引擎提示）· `providers.js`（Claude/Qwen 文本 · 通义万相配图 · 联网检索）。
- 📜 [样例课脚本 `sample-lesson-attention.jsonc`](docs/sample-lesson-attention.jsonc) — Lesson Script 数据契约的完整示例。

## 核心理念

- **视觉优先**：默认用图、公式、动画、分步板书表达，能画就不写。
- **老师在场**：稳定人设的老师"表演"这堂课——会板书、会指、会圈重点、会问"懂了吗"。
- **教学法结构**：每堂课遵循"导入 → 是什么 → 为什么 → 怎么做 → 演示 → 检验 → 小结"。

## 下一步

详见 PRD [附录 B · 后续文档规划](docs/PRD.md#附录-b--后续文档规划)：交互视觉设计稿 → 演示脚本技术规格 → MVP 技术方案与排期 → 教学法与提示词规范。
