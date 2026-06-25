# 运行指南 · 接真 AI（流式生成 · 真配图 · 联网检索）

把 VR-Class 跑起来：**点题 →（大纲确认）→ 逐章流式生成、边到边播**；配图由图像模型真生成；时效性主题先联网检索再讲。

后端**零依赖**（只用 Node 内置模块 + 全局 `fetch`），不需要 `npm install`。

---

## 1. 前置条件

- **Node.js ≥ 18**（用到全局 `fetch`；推荐 20+）。
- 至少一个 key（没有也能跑示例模式）：
  - **Anthropic Claude**（`ANTHROPIC_API_KEY`）——生成正文/大纲/追问；或
  - **阿里云 DashScope / 百炼**（`DASHSCOPE_API_KEY`）——可单独生成正文（Qwen），并提供**配图（通义万相）**与**联网检索**。

---

## 2. 最快上手（示例模式，无需 key）

```bash
npm run mock        # 等价 MOCK=1 node server/server.js
```

浏览器开 **http://localhost:8000** → 点题 → 确认大纲 → 看它**流式**把内置样例课一章章播出来。

---

## 3. 接真 AI

```bash
# 方式一：命令行直接给（二选一或都给）
ANTHROPIC_API_KEY=sk-ant-xxx  DASHSCOPE_API_KEY=sk-xxx  node server/server.js

# 方式二：写进 .env（server 自动读取）
cp .env.example .env     # 编辑填入 key
npm start
```

- 只配 **ANTHROPIC_API_KEY** → Claude 生成正文（无配图/检索）。
- 只配 **DASHSCOPE_API_KEY** → Qwen 生成正文 **＋ 通义万相配图 ＋ 联网检索**，一把 key 全功能。
- 两个都配 → 正文用 Claude（质量优先），配图/检索用 DashScope。

`/health` 会告诉你当前能力：`{mode, provider, model, image, search}`。

> ⚠️ **安全**：不要把 key 写进会被提交的文件。`.env` 已在 `.gitignore` 中。若 key 曾在聊天/日志里出现过，请到控制台**轮换**一个新的。

---

## 4. 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Claude（正文/大纲/追问） | — |
| `DASHSCOPE_API_KEY` | Qwen 正文 + 万相配图 + 联网检索 | — |
| `ANTHROPIC_MODEL` | Claude 正文模型 | `claude-sonnet-4-6` |
| `ANTHROPIC_ASK_MODEL` | Claude 大纲/追问（快速档） | `claude-haiku-4-5-20251001` |
| `DASHSCOPE_MODEL` | Qwen 正文模型 | `qwen-plus` |
| `DASHSCOPE_IMAGE_MODEL` | 通义万相配图模型 | `wanx2.1-t2i-turbo` |
| `DASHSCOPE_IMAGE_SIZE` | 配图尺寸 | `1280*720` |
| `PORT` / `MOCK` | 端口 / 强制示例模式 | `8000` / — |

---

## 5. 它是怎么工作的

```
浏览器（通用"演示脚本播放器"）
   │ ① POST /api/outline {topic}              → 大纲确认页（可一句话调深浅/换角度）
   │ ② POST /api/lesson/stream {topic,outline} → SSE 流
   ▼
后端 server.js
   │  · 时效主题：先 DashScope 联网检索一份"最新资料简报"，注入逐章生成
   │  · 逐章调用文本模型（Claude / Qwen）→ 每生成完一章，SSE 推一个 chapter 事件
   ▼
前端：第 1 章到达即开播；后续章节边到边追加（侧栏未到的章节显示"待生成"）
   板书里的 image 场景 → 后台 POST /api/image → 通义万相生成 → 就位后替换占位
```

**核心**：前端是通用播放器，本身不含任何一课；课全部由流式下发的 Lesson Script 驱动。

### 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/outline` | `{topic, level?, adjust?}` → 章节大纲（含 `requires_retrieval`） |
| `POST` | `/api/lesson/stream` | `{topic, outline?}` → **SSE**：`meta` / `brief` / `chapter` / `done` / `error` |
| `POST` | `/api/lesson` | `{topic, outline?}` → 整堂 JSON（非流式，保留兼容） |
| `POST` | `/api/image` | `{prompt}` → `{url}`（通义万相，结果按 prompt 缓存） |
| `POST` | `/api/ask` | `{topic, question, context}` → `{answer}`（课堂追问） |
| `GET` | `/health` | `{mode, provider, model, image, search}` |

体验流程：**点题 → 确认大纲 → 流式生成边到边播（带 🔊 语音、章节过渡）→ 配图就位即现 → 随时💬提问**。想一眼看全 9 类板书，点首页「🎨 板书类型画廊」。

---

## 6. 三个新能力说明

- **正文流式生成**：先出大纲（快速档），再逐章生成；第 1 章好了就开播，后台续生成，把"备课中"等待抹平。播放追上生成时，会短暂等下一章（"下一章马上就好…"）。
- **真配图（通义万相）**：`image` 场景渲染时后台异步生成（提交 + 轮询），就位后无缝替换占位；同一 prompt 结果缓存。无 `DASHSCOPE_API_KEY` 时回退为画框占位。
- **联网检索**：主题被判定为时效性（大纲返回 `requires_retrieval` 或命中"最新/今年/202x"等词）时，用 DashScope（Qwen+搜索）取一份最新资料简报，注入逐章生成，并在顶部显示「🔎 已联网检索」。

---

## 7. 离线 / 降级（都不白屏）

- 不启动后端、直接双击打开 `prototype/classroom.html`：流式请求失败 → 自动加载**内置示例课**。
- 公式/图示走 KaTeX/Mermaid（CDN），**断网降级**为源码框。
- 配图无 key → 画框占位；某章生成失败 → 跳过该章并提示，不影响其余。

---

## 8. 常见问题

- **一直示例模式？** 没读到任何文本 key。确认 `export` 或写进根目录 `.env`，看 `/health`。
- **Qwen 偶发 JSON 不合规？** 后端做了"括号平衡抽取 + 字段校验"，非法返回 502；重试一般即可。
- **配图很慢？** 万相是异步任务（约 10–30s）；前端先占位、就位再替换，不阻塞播放。
- **公司代理/沙箱连不通 API？** Node 全局 `fetch` 默认不走 `HTTPS_PROXY`；受限网络下可能 403。请在能直连的环境运行，或为 Node 配置出网代理。

---

## 9. 已做到 & 下一步

**已落地**：大纲确认 · **逐章流式边到边播** · 9 类板书（含图表/数学动画）· **真配图（通义万相）** · **联网检索** · TTS 语音与板书时序对齐 · 章节切换过渡 · 课堂追问 · Claude/Qwen 双供应商。

**下一步**：更细的进度提示（"正在写第 N 章"）· 扩充数学动画模板 · 词级时间轴 TTS · 课程缓存与存档 · 多老师人设。
