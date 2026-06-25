// =============================================================================
//  server.js —— VR-Class 后端（零依赖：Node 内置模块 + 全局 fetch）
//
//  打通："点题 → (大纲) → 流式逐章生成 → 边到边播"，并接入真·配图与联网检索。
//
//  运行：
//    ANTHROPIC_API_KEY=sk-ant-xxx node server/server.js        # Claude 生成正文
//    DASHSCOPE_API_KEY=sk-xxx     node server/server.js        # 用 Qwen 生成 + 万相配图 + 联网检索
//    MOCK=1                        node server/server.js        # 示例模式（无需任何 key）
//  浏览器打开 http://localhost:8000
//
//  环境变量见 .env.example（server 会自动读取根目录 .env）。
// =============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { SYSTEM_PROMPT, CHAPTER_SYSTEM, OUTLINE_SYSTEM, buildUserPrompt, buildChapterPrompt, buildOutlinePrompt } = require('./prompt');

// 极简 .env 加载（零依赖）：把根目录 .env 的 KEY=VAL 注入 process.env（不覆盖已有值）
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

// providers 必须在 loadEnv 之后 require（它在模块顶层读 env）
const { chat, searchBrief, generateImage, textProvider, activeModel, hasImage, hasSearch } = require('./providers');

const PORT = process.env.PORT || 8000;
const MOCK = process.env.MOCK === '1' || textProvider() === 'none';

const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'prototype', 'classroom.html');
const SAMPLE = path.join(ROOT, 'docs', 'sample-lesson-attention.jsonc');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 工具 ----------
function stripJsonc(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
}
function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('no JSON object found');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else { if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); } }
  }
  throw new Error('unterminated JSON object');
}
function normalizeScene(s, where) {
  if (!s || typeof s.narration !== 'string' || !s.visual || typeof s.visual.type !== 'string') throw new Error(`${where} needs narration + visual.type`);
  s.board_action = s.board_action || 'fade_in';
  if (!Array.isArray(s.highlight)) s.highlight = s.highlight ? [s.highlight] : [];
  return s;
}
function validateLesson(o) {
  if (!o || typeof o !== 'object') throw new Error('lesson is not an object');
  if (!Array.isArray(o.chapters) || o.chapters.length === 0) throw new Error('lesson.chapters missing/empty');
  o.chapters.forEach((ch, ci) => {
    if (!ch || !Array.isArray(ch.scenes) || ch.scenes.length === 0) throw new Error(`chapter[${ci}].scenes missing/empty`);
    ch.title = ch.title || `第 ${ci + 1} 章`; ch.id = ch.id || `c${ci}`;
    ch.scenes.forEach((s, si) => normalizeScene(s, `chapter[${ci}].scene[${si}]`));
  });
  o.topic = o.topic || '未命名主题';
  o.meta = o.meta || { requires_retrieval: false, knowledge_freshness: 'evergreen', sources: [] };
  return o;
}
function validateOutline(o) {
  if (!o || !Array.isArray(o.chapters) || o.chapters.length === 0) throw new Error('outline.chapters missing/empty');
  o.chapters = o.chapters.map((c, i) => ({ id: c.id || `c${i}`, title: c.title || `第 ${i + 1} 章`, summary: c.summary || '' }));
  o.topic = o.topic || '未命名主题'; o.level = o.level || ''; o.requires_retrieval = !!o.requires_retrieval;
  return o;
}
function validateChapterScenes(r, where) {
  const scenes = Array.isArray(r) ? r : (r && Array.isArray(r.scenes) ? r.scenes : null);
  if (!scenes || !scenes.length) throw new Error(`${where}: empty scenes`);
  scenes.forEach((s, i) => normalizeScene(s, `${where}.scene[${i}]`));
  return scenes;
}
function isTimeSensitive(t) { return /最新|最近|今年|近期|目前|现在|202[4-9]|latest|recent|current|newest|发布|新版|本月|今天|趋势/i.test(t || ''); }

let SAMPLE_CACHE = null;
function loadSampleLesson() { if (!SAMPLE_CACHE) SAMPLE_CACHE = validateLesson(JSON.parse(stripJsonc(fs.readFileSync(SAMPLE, 'utf8')))); return SAMPLE_CACHE; }
function sampleOutline(topic) {
  const s = loadSampleLesson();
  return { topic: topic || s.topic, level: s.level || '示例', requires_retrieval: false,
    chapters: s.chapters.map(c => ({ id: c.id, title: c.title, summary: ((c.scenes[0] && c.scenes[0].narration) || '').replace(/\s+/g, '').slice(0, 26) })), _mock: true };
}

// ---------- 生成（经 providers，自动选 Claude / Qwen）----------
async function genJSON({ system, user, fast, maxTokens }) {
  const text = await chat({ system, user, prefill: '{', fast, maxTokens }); // prefill 对 Qwen 无效，靠抽取兜底
  return JSON.parse(extractJsonObject(text));
}
async function generateLesson(topic, opts) {
  const o = validateLesson(await genJSON({ system: SYSTEM_PROMPT, user: buildUserPrompt(topic, opts), maxTokens: 8000 }));
  o._model = activeModel(); return o;
}
async function generateOutline(topic, opts) {
  return validateOutline(await genJSON({ system: OUTLINE_SYSTEM, user: buildOutlinePrompt(topic, opts), fast: true, maxTokens: 1500 }));
}
async function generateChapter(topic, outline, index, opts) {
  return validateChapterScenes(await genJSON({ system: CHAPTER_SYSTEM, user: buildChapterPrompt(topic, outline, index, opts), maxTokens: 3000 }), `chapter[${index}]`);
}
async function generateAnswer(topic, question, context) {
  const system = `你是「林老师」，正在给学生上《${topic}》这堂课。用面向学生的口吻、简短（2–4 句）、准确地回答；必要时举一个小例子。只回答问题本身，不寒暄。`;
  return (await chat({ system, user: `学生此刻刚学到：「${context || '（课程开头）'}」。\n学生的问题：${question}`, fast: true, maxTokens: 600 })).trim();
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8' };
function send(res, code, body, headers = {}) { res.writeHead(code, { 'Access-Control-Allow-Origin': '*', ...headers }); res.end(body); }
function readBody(req) { return new Promise(resolve => { let raw = ''; req.on('data', c => (raw += c)); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve(null); } }); }); }

const IMG_CACHE = new Map(); // prompt -> url

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') return send(res, 204, '', { 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' });

  if (url.pathname === '/health') {
    return send(res, 200, JSON.stringify({ ok: true, mode: MOCK ? 'mock' : 'live', provider: textProvider(), model: MOCK ? null : activeModel(), image: hasImage(), search: hasSearch() }), { 'content-type': 'application/json' });
  }

  // 大纲规划
  if (url.pathname === '/api/outline' && req.method === 'POST') {
    const j = await readBody(req); if (!j) return send(res, 400, JSON.stringify({ error: '请求体非法' }), { 'content-type': 'application/json' });
    const topic = (j.topic || '').trim(); if (!topic) return send(res, 400, JSON.stringify({ error: '缺少 topic' }), { 'content-type': 'application/json' });
    try { const outline = MOCK ? sampleOutline(topic) : await generateOutline(topic, { level: j.level, adjust: j.adjust });
      send(res, 200, JSON.stringify(outline), { 'content-type': 'application/json; charset=utf-8' });
    } catch (e) { console.error('[outline]', e.message); send(res, 502, JSON.stringify({ error: '大纲生成失败：' + e.message }), { 'content-type': 'application/json; charset=utf-8' }); }
    return;
  }

  // 流式逐章生成（SSE）——边到边播
  if (url.pathname === '/api/lesson/stream' && req.method === 'POST') {
    const j = await readBody(req); if (!j) return send(res, 400, JSON.stringify({ error: '请求体非法' }), { 'content-type': 'application/json' });
    const topic = (j.topic || '').trim(); if (!topic) return send(res, 400, JSON.stringify({ error: '缺少 topic' }), { 'content-type': 'application/json' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      if (MOCK) {
        const s = loadSampleLesson();
        sse('meta', { topic, level: s.level, chapters: s.chapters.map(c => c.title), retrieval: false, mock: true });
        for (let i = 0; i < s.chapters.length; i++) { await sleep(550); sse('chapter', { index: i, id: s.chapters[i].id, title: s.chapters[i].title, scenes: s.chapters[i].scenes }); }
        sse('done', {}); return res.end();
      }
      let outline = (j.outline && Array.isArray(j.outline.chapters) && j.outline.chapters.length) ? validateOutline(j.outline) : await generateOutline(topic, { level: j.level });
      // 时效性主题：联网检索一份简报，注入逐章生成
      let brief = null;
      if (hasSearch() && (outline.requires_retrieval || isTimeSensitive(topic))) { try { brief = await searchBrief(topic); } catch (e) { console.error('[search]', e.message); } }
      sse('meta', { topic, level: outline.level || j.level || '', chapters: outline.chapters.map(c => c.title), retrieval: !!brief });
      if (brief) sse('brief', { brief });
      for (let i = 0; i < outline.chapters.length; i++) {
        try { const scenes = await generateChapter(topic, outline, i, { level: outline.level || j.level, brief }); sse('chapter', { index: i, id: outline.chapters[i].id, title: outline.chapters[i].title, scenes }); }
        catch (e) { console.error(`[chapter ${i}]`, e.message); sse('chapter_error', { index: i, title: outline.chapters[i].title, message: e.message }); }
      }
      sse('done', {}); res.end();
    } catch (e) { console.error('[stream]', e.message); sse('error', { message: e.message }); res.end(); }
    return;
  }

  // 整堂生成（非流式，保留兼容）
  if (url.pathname === '/api/lesson' && req.method === 'POST') {
    const j = await readBody(req); if (!j) return send(res, 400, JSON.stringify({ error: '请求体非法' }), { 'content-type': 'application/json' });
    const topic = (j.topic || '').trim(); if (!topic) return send(res, 400, JSON.stringify({ error: '缺少 topic' }), { 'content-type': 'application/json' });
    try {
      let lesson;
      if (MOCK) { lesson = JSON.parse(JSON.stringify(loadSampleLesson())); lesson._mock = true; lesson._requestedTopic = topic; }
      else lesson = await generateLesson(topic, { level: j.level, language: j.language, outline: j.outline });
      send(res, 200, JSON.stringify(lesson), { 'content-type': 'application/json; charset=utf-8' });
    } catch (e) { console.error('[lesson]', e.message); send(res, 502, JSON.stringify({ error: '生成失败：' + e.message }), { 'content-type': 'application/json; charset=utf-8' }); }
    return;
  }

  // 配图真生成（DashScope 通义万相）
  if (url.pathname === '/api/image' && req.method === 'POST') {
    const j = await readBody(req); if (!j) return send(res, 400, JSON.stringify({ error: '请求体非法' }), { 'content-type': 'application/json' });
    const prompt = (j.prompt || '').trim(); if (!prompt) return send(res, 400, JSON.stringify({ error: '缺少 prompt' }), { 'content-type': 'application/json' });
    if (!hasImage()) return send(res, 501, JSON.stringify({ error: '未配置图像生成（需 DASHSCOPE_API_KEY）' }), { 'content-type': 'application/json' });
    if (IMG_CACHE.has(prompt)) return send(res, 200, JSON.stringify({ url: IMG_CACHE.get(prompt), cached: true }), { 'content-type': 'application/json' });
    try { const u = await generateImage(prompt); if (u) IMG_CACHE.set(prompt, u); send(res, 200, JSON.stringify({ url: u }), { 'content-type': 'application/json' }); }
    catch (e) { console.error('[image]', e.message); send(res, 502, JSON.stringify({ error: '配图失败：' + e.message }), { 'content-type': 'application/json' }); }
    return;
  }

  // 课堂追问
  if (url.pathname === '/api/ask' && req.method === 'POST') {
    const j = await readBody(req); if (!j) return send(res, 400, JSON.stringify({ error: '请求体非法' }), { 'content-type': 'application/json' });
    const question = (j.question || '').trim(); if (!question) return send(res, 400, JSON.stringify({ error: '缺少 question' }), { 'content-type': 'application/json' });
    try {
      const answer = MOCK ? '（示例模式）这是个好问题。接入 API Key 后，我会结合你当前学到的内容给出针对性解答。'
        : await generateAnswer(j.topic || '这堂课', question, j.context || '');
      send(res, 200, JSON.stringify({ answer }), { 'content-type': 'application/json; charset=utf-8' });
    } catch (e) { send(res, 502, JSON.stringify({ error: '回答失败：' + e.message }), { 'content-type': 'application/json; charset=utf-8' }); }
    return;
  }

  if (url.pathname === '/' || url.pathname === '/classroom.html') {
    return fs.readFile(PAGE, (err, buf) => err ? send(res, 404, 'not found') : send(res, 200, buf, { 'content-type': MIME['.html'] }));
  }
  send(res, 404, 'not found');
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`\n  VR-Class 后端已启动  →  http://localhost:${PORT}\n`);
    if (MOCK) console.log('  模式：示例模式（MOCK）— 未配置文本 key，/api/* 返回内置样例课。\n');
    else {
      console.log(`  模式：实时生成（live）— 文本：${textProvider()} / ${activeModel()}`);
      console.log(`  配图：${hasImage() ? '通义万相 ✓' : '未启用（缺 DASHSCOPE_API_KEY）'}　联网检索：${hasSearch() ? '✓' : '未启用'}\n`);
    }
  });
}

module.exports = { extractJsonObject, validateLesson, validateOutline, validateChapterScenes, stripJsonc, loadSampleLesson, sampleOutline, isTimeSensitive };
