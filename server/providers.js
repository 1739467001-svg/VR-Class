// =============================================================================
//  providers.js —— 文本 / 图像 / 联网检索 的供应商抽象（零依赖）
//
//  文本生成：优先 Anthropic Claude（ANTHROPIC_API_KEY），否则阿里云 DashScope Qwen
//            （DASHSCOPE_API_KEY）。两者都没有 → 'none'（走示例模式）。
//  图像生成：阿里云 DashScope 通义万相（Wanx），需 DASHSCOPE_API_KEY。
//  联网检索：阿里云 DashScope Qwen + enable_search，需 DASHSCOPE_API_KEY。
//
//  说明：DashScope 的 key 既能生图也能联网检索，所以即使文本主供应商是 Claude，
//        只要配了 DASHSCOPE_API_KEY，配图与检索就可用。
// =============================================================================

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY;

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const ANTHROPIC_ASK_MODEL = process.env.ANTHROPIC_ASK_MODEL || 'claude-haiku-4-5-20251001';
const QWEN_MODEL = process.env.DASHSCOPE_MODEL || 'qwen-plus';
const QWEN_SEARCH_MODEL = process.env.DASHSCOPE_SEARCH_MODEL || 'qwen-plus';
const IMAGE_MODEL = process.env.DASHSCOPE_IMAGE_MODEL || 'wanx2.1-t2i-turbo';
const IMAGE_SIZE = process.env.DASHSCOPE_IMAGE_SIZE || '1280*720';

const DS = 'https://dashscope.aliyuncs.com';

const TEXT_PROVIDER = ANTHROPIC_KEY ? 'anthropic' : (DASHSCOPE_KEY ? 'dashscope' : 'none');

function textProvider() { return TEXT_PROVIDER; }
function activeModel() { return TEXT_PROVIDER === 'anthropic' ? ANTHROPIC_MODEL : (TEXT_PROVIDER === 'dashscope' ? QWEN_MODEL : null); }
function hasImage() { return !!DASHSCOPE_KEY; }
function hasSearch() { return !!DASHSCOPE_KEY; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Anthropic ----------
async function anthropicChat({ system, user, prefill, fast, maxTokens }) {
  const messages = [{ role: 'user', content: user }];
  if (prefill) messages.push({ role: 'assistant', content: prefill });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: fast ? ANTHROPIC_ASK_MODEL : ANTHROPIC_MODEL, max_tokens: maxTokens || 4000, system, messages }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
  const d = await r.json();
  const t = (d.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  return (prefill || '') + t;
}

// ---------- DashScope Qwen（文本 / 检索）----------
async function dashscopeChat({ system, user, maxTokens, search, model }) {
  const body = {
    model: model || QWEN_MODEL,
    input: { messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
    parameters: { result_format: 'message', max_tokens: maxTokens || 4000 },
  };
  if (search) body.parameters.enable_search = true;
  const r = await fetch(`${DS}/api/v1/services/aigc/text-generation/generation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DASHSCOPE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`DashScope ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
  const d = await r.json();
  if (d.output) {
    if (d.output.choices && d.output.choices[0]) return d.output.choices[0].message.content;
    if (typeof d.output.text === 'string') return d.output.text;
  }
  throw new Error('DashScope 返回格式异常');
}

// ---------- 统一文本补全 ----------
async function chat(opts) {
  if (TEXT_PROVIDER === 'anthropic') return anthropicChat(opts);
  if (TEXT_PROVIDER === 'dashscope') return dashscopeChat(opts); // prefill 对 Qwen 无效，靠 JSON 抽取兜底
  throw new Error('未配置任何文本供应商（缺 ANTHROPIC_API_KEY / DASHSCOPE_API_KEY）');
}

// ---------- 联网检索简报（DashScope Qwen + 搜索）----------
async function searchBrief(query) {
  if (!DASHSCOPE_KEY) return null;
  const system = '你是检索助手。请用联网搜索，给出关于该主题的**最新、准确**的关键信息要点，标注时间/版本，并在末尾用一行列出主要来源名称。务必简洁（200 字内），不要展开成文章。';
  const text = await dashscopeChat({ system, user: `检索并总结：「${query}」的最新关键信息。`, model: QWEN_SEARCH_MODEL, maxTokens: 1000, search: true });
  return (text || '').trim() || null;
}

// ---------- 图像生成（DashScope 通义万相，异步提交 + 轮询）----------
async function generateImage(prompt) {
  if (!DASHSCOPE_KEY) return null;
  const sub = await fetch(`${DS}/api/v1/services/aigc/text2image/image-synthesis`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DASHSCOPE_KEY}`, 'X-DashScope-Async': 'enable', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: IMAGE_MODEL, input: { prompt }, parameters: { size: IMAGE_SIZE, n: 1 } }),
  });
  if (!sub.ok) throw new Error(`Wanx 提交 ${sub.status}: ${(await sub.text().catch(() => '')).slice(0, 200)}`);
  const subj = await sub.json();
  const taskId = subj.output && subj.output.task_id;
  if (!taskId) throw new Error('Wanx 未返回 task_id');
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const p = await fetch(`${DS}/api/v1/tasks/${taskId}`, { headers: { Authorization: `Bearer ${DASHSCOPE_KEY}` } });
    if (!p.ok) continue;
    const pj = await p.json();
    const st = pj.output && pj.output.task_status;
    if (st === 'SUCCEEDED') {
      const r = pj.output.results && pj.output.results[0];
      return (r && (r.url || r.image_url)) || null;
    }
    if (st === 'FAILED') throw new Error('Wanx 任务失败：' + ((pj.output && pj.output.message) || ''));
  }
  throw new Error('Wanx 任务超时');
}

module.exports = { chat, searchBrief, generateImage, textProvider, activeModel, hasImage, hasSearch };
