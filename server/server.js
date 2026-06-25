// =============================================================================
//  server.js —— VR-Class 最小后端（零依赖，仅用 Node 内置模块 + 全局 fetch）
//
//  打通："学生点题 → 调用 Claude 生成 Lesson Script → 前端播放"
//
//  运行：
//    ANTHROPIC_API_KEY=sk-ant-xxx node server/server.js      # 接真 AI
//    MOCK=1 node server/server.js                            # 示例模式（无需 key）
//  然后浏览器打开 http://localhost:8000
//
//  环境变量：
//    ANTHROPIC_API_KEY   Anthropic API Key（缺省则自动进入示例模式）
//    ANTHROPIC_MODEL     生成所用模型（默认 claude-sonnet-4-6；要更高质量可设为 Opus）
//    PORT                端口（默认 8000）
//    MOCK=1              强制示例模式（返回内置样例课，不调用 API）
// =============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { SYSTEM_PROMPT, buildUserPrompt } = require('./prompt');

// 极简 .env 加载（零依赖）：把仓库根目录 .env 的 KEY=VAL 注入 process.env（不覆盖已有值）
(function loadEnv() {
  try {
    const p = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !process.env[m[1]]) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    }
  } catch (e) { /* ignore */ }
})();

const PORT = process.env.PORT || 8000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
// 追问用快速档（低延迟、低成本），契合 PRD 的模型分层
const ASK_MODEL = process.env.ANTHROPIC_ASK_MODEL || 'claude-haiku-4-5-20251001';
const MOCK = process.env.MOCK === '1' || !API_KEY;

const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'prototype', 'classroom.html');
const SAMPLE = path.join(ROOT, 'docs', 'sample-lesson-attention.jsonc');

// ---------- 工具 ----------
function stripJsonc(s) {
  // 去掉 /* */ 与整行 // 注释（本仓库样例文件的字符串值里不含 //）
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
}

// 从模型输出里抽出第一个"括号平衡"的 JSON 对象（容忍前后多余文字、字符串内的括号）
function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('no JSON object found');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
  }
  throw new Error('unterminated JSON object');
}

// 校验 + 规整，保证前端能安全渲染
function validateLesson(o) {
  if (!o || typeof o !== 'object') throw new Error('lesson is not an object');
  if (!Array.isArray(o.chapters) || o.chapters.length === 0) throw new Error('lesson.chapters missing/empty');
  o.chapters.forEach((ch, ci) => {
    if (!ch || !Array.isArray(ch.scenes) || ch.scenes.length === 0) throw new Error(`chapter[${ci}].scenes missing/empty`);
    ch.title = ch.title || `第 ${ci + 1} 章`;
    ch.id = ch.id || `c${ci}`;
    ch.scenes.forEach((s, si) => {
      if (!s || typeof s.narration !== 'string' || !s.visual || typeof s.visual.type !== 'string')
        throw new Error(`chapter[${ci}].scene[${si}] needs narration + visual.type`);
      s.board_action = s.board_action || 'fade_in';
      if (!Array.isArray(s.highlight)) s.highlight = s.highlight ? [s.highlight] : [];
    });
  });
  o.topic = o.topic || '未命名主题';
  o.meta = o.meta || { requires_retrieval: false, knowledge_freshness: 'evergreen', sources: [] };
  return o;
}

let SAMPLE_CACHE = null;
function loadSampleLesson() {
  if (!SAMPLE_CACHE) SAMPLE_CACHE = validateLesson(JSON.parse(stripJsonc(fs.readFileSync(SAMPLE, 'utf8'))));
  return SAMPLE_CACHE;
}

// ---------- 调用 Claude ----------
async function generateLesson(topic, opts) {
  const body = {
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: buildUserPrompt(topic, opts) },
      { role: 'assistant', content: '{' }, // 预填一个左花括号，强制模型直接续写 JSON
    ],
  };
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Anthropic API ${resp.status}: ${t.slice(0, 400)}`);
  }
  const data = await resp.json();
  let text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  text = '{' + text; // 补回预填的左括号
  const lesson = validateLesson(JSON.parse(extractJsonObject(text)));
  lesson._model = MODEL;
  return lesson;
}

// 课堂追问：用快速档模型，结合当前进度上下文作答
async function generateAnswer(topic, question, context) {
  const system = `你是「林老师」，正在给学生上《${topic}》这堂课。用面向学生的口吻、简短（2–4 句）、准确地回答问题；必要时举一个小例子。只回答问题本身，不寒暄。`;
  const user = `学生此刻刚学到：「${context || '（课程开头）'}」。\n学生的问题：${question}`;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: ASK_MODEL, max_tokens: 600, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!resp.ok) throw new Error(`Anthropic API ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);
  const data = await resp.json();
  return (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    return send(res, 204, '', { 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' });
  }

  // 健康检查 / 模式
  if (url.pathname === '/health') {
    return send(res, 200, JSON.stringify({ ok: true, mode: MOCK ? 'mock' : 'live', model: MOCK ? null : MODEL }), { 'content-type': 'application/json' });
  }

  // 核心 API：生成一堂课
  if (url.pathname === '/api/lesson' && req.method === 'POST') {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', async () => {
      let topic = '', opts = {};
      try { const j = JSON.parse(raw || '{}'); topic = (j.topic || '').trim(); opts = { level: j.level, language: j.language }; }
      catch { return send(res, 400, JSON.stringify({ error: '请求体不是合法 JSON' }), { 'content-type': 'application/json' }); }
      if (!topic) return send(res, 400, JSON.stringify({ error: '缺少 topic' }), { 'content-type': 'application/json' });

      try {
        let lesson;
        if (MOCK) {
          lesson = JSON.parse(JSON.stringify(loadSampleLesson())); // 深拷贝
          lesson._mock = true;
          lesson._requestedTopic = topic; // 示例模式下回显学生点的题（内容仍是内置样例课）
        } else {
          lesson = await generateLesson(topic, opts);
        }
        send(res, 200, JSON.stringify(lesson), { 'content-type': 'application/json; charset=utf-8' });
      } catch (e) {
        console.error('[lesson] 生成失败:', e.message);
        send(res, 502, JSON.stringify({ error: '生成失败：' + e.message }), { 'content-type': 'application/json; charset=utf-8' });
      }
    });
    return;
  }

  // 课堂追问
  if (url.pathname === '/api/ask' && req.method === 'POST') {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', async () => {
      let j = {};
      try { j = JSON.parse(raw || '{}'); } catch { return send(res, 400, JSON.stringify({ error: '请求体不是合法 JSON' }), { 'content-type': 'application/json' }); }
      const question = (j.question || '').trim();
      if (!question) return send(res, 400, JSON.stringify({ error: '缺少 question' }), { 'content-type': 'application/json' });
      try {
        const answer = MOCK
          ? '（示例模式）这是一个很好的问题。接入 ANTHROPIC_API_KEY 后，我会结合你当前学到的内容给出针对性解答。'
          : await generateAnswer(j.topic || '这堂课', question, j.context || '');
        send(res, 200, JSON.stringify({ answer }), { 'content-type': 'application/json; charset=utf-8' });
      } catch (e) {
        send(res, 502, JSON.stringify({ error: '回答失败：' + e.message }), { 'content-type': 'application/json; charset=utf-8' });
      }
    });
    return;
  }

  // 静态：首页 = 原型页
  if (url.pathname === '/' || url.pathname === '/classroom.html') {
    return fs.readFile(PAGE, (err, buf) => err ? send(res, 404, 'not found') : send(res, 200, buf, { 'content-type': MIME['.html'] }));
  }

  send(res, 404, 'not found');
});

// 仅在直接运行时启动服务；被 require 时只导出纯函数，便于测试
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`\n  VR-Class 后端已启动  →  http://localhost:${PORT}\n`);
    if (MOCK) {
      console.log('  模式：示例模式（MOCK）— 未检测到 ANTHROPIC_API_KEY，/api/lesson 返回内置样例课。');
      console.log('  接真 AI：  ANTHROPIC_API_KEY=sk-ant-xxx node server/server.js\n');
    } else {
      console.log(`  模式：实时生成（live）— 模型 ${MODEL}\n`);
    }
  });
}

module.exports = { extractJsonObject, validateLesson, stripJsonc, loadSampleLesson };
