# 运行指南 · 把原型接上真 AI

本指南教你把 VR-Class 跑起来：**学生点题 → 后端调用 Claude 现场生成一堂课（Lesson Script）→ 前端在虚拟教室里播放**。

后端是**零依赖**的（只用 Node 内置模块 + 全局 `fetch`），不需要 `npm install`。

---

## 1. 前置条件

- **Node.js ≥ 18**（用到全局 `fetch`；推荐 20+）。
- 想接真 AI：一个 **Anthropic API Key**（没有也能跑，见"示例模式"）。

---

## 2. 最快上手（示例模式，无需 Key）

```bash
npm run mock
# 等价于： MOCK=1 node server/server.js
```

浏览器打开 **http://localhost:8000** → 输入任意主题 → 开始上课。

> 示例模式下，`/api/lesson` 会返回**内置样例课**（《Transformer 注意力机制》），用来验证"点题 → 播放"整条链路与界面，不消耗 API。

---

## 3. 接真 AI（现场生成任意主题）

设置 Key 后启动（任选一种）：

```bash
# 方式一：命令行直接给
ANTHROPIC_API_KEY=sk-ant-xxxx node server/server.js

# 方式二：写进 .env（server 会自动读取）
cp .env.example .env        # 然后编辑 .env 填入 Key
npm start
```

打开 http://localhost:8000，输入**任意主题**（"光合作用""一致性哈希""明朝为什么灭亡"…），老师就会现场为你设计并讲出这堂课。

---

## 4. 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic API Key（缺省→自动进入示例模式） | — |
| `ANTHROPIC_MODEL` | 生成课程的模型（质量优先） | `claude-sonnet-4-6` |
| `ANTHROPIC_ASK_MODEL` | 课堂追问的模型（速度优先） | `claude-haiku-4-5-20251001` |
| `PORT` | 端口 | `8000` |
| `MOCK` | 设为 `1` 强制示例模式 | — |

> 模型按 PRD 的"质量/速度分层"：备课用更强的模型，追问用快速档以求低延迟。两者都可按需替换（如把生成换成 Opus 档追求质量）。

---

## 5. 它是怎么工作的

```
浏览器（prototype/classroom.html）
   │  POST /api/lesson { topic }
   ▼
server/server.js  ──►  server/prompt.js（System 提示：老师人设 + 教学法 + 严格 JSON 契约）
   │                         │
   │                         ▼
   │                 Anthropic Messages API（预填 "{" 强制直出 JSON）
   │                         │
   │   ◄── 校验/规整 ────  Lesson Script（PRD §5.3：chapters → scenes → visual）
   ▼
前端通用"播放器"按 visual.type 渲染并逐场景播放：
   text / formula(KaTeX) / diagram(Mermaid) / code / heatmap / quiz / image …
```

**关键点**：前端是**通用播放器**，本身不含任何一节课的内容；喂不同的 Lesson Script 就上不同的课。这正是 PRD 主张的"**课 = 可播放的结构化脚本**"。

### 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/lesson` | 入参 `{topic, level?}`，出参一份 Lesson Script JSON |
| `POST` | `/api/ask` | 入参 `{topic, question, context}`，课堂追问，出参 `{answer}` |
| `GET` | `/health` | 返回 `{mode: "live"\|"mock", model}` |
| `GET` | `/` | 虚拟教室页面（即 `prototype/classroom.html`） |

---

## 6. 离线 / 降级行为（都不会"白屏"）

- **不启动后端、直接双击打开** `prototype/classroom.html`：`/api/lesson` 请求失败 → 自动加载**内置示例课**（顶部显示"离线示例"）。
- **公式 / 图示**用 KaTeX / Mermaid（CDN）渲染；**断网时自动降级**为展示源码框，不报错、不白屏。
- 联网时，公式和 Mermaid 图会正常渲染为漂亮的版式。

---

## 7. 常见问题

- **一直是"示例模式"？** 说明没读到 `ANTHROPIC_API_KEY`。确认已 `export` 或写进根目录 `.env`，重启后端。`/health` 会告诉你当前模式。
- **生成报错 / JSON 解析失败？** 多为模型偶发不合规。重试一次通常即可；后端已做"括号平衡抽取 + 字段校验"，并对非法结构返回 502 而非崩溃。
- **首屏等待较久？** 当前是"一次生成整堂课"。降低延迟的下一步是**渐进式生成**（先出大纲、边播边生成后续章节），见下。
- **在公司代理后面跑不通 API？** Node 的全局 `fetch` 默认不走 `HTTPS_PROXY`；如需代理，请在你的环境里为 Node 配置出网代理。

---

## 8. 下一步（让它从"能用"到"好用"）

1. **渐进式生成 / 流式**（PRD 6.2）：先秒出大纲，第 1 章生成完即开播，后台续生成——首屏延迟无感。
2. **配图 / 动画生成**：把 `image`、动画类视觉接上图像生成或 Manim 类管线。
3. **语音讲解（TTS）**：把 `narration` 合成语音，与板书时序对齐。
4. **AI 前沿主题联网检索**（PRD 锁定的硬约束）：对时效性主题先检索再讲，并标注信息时间与出处。
5. **课程缓存与存档**：相同主题命中缓存，降本提速；支持回放与续学。
