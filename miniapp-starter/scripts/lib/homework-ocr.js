// 作业登记本 OCR 共用工具:
// - SYSTEM_INSTRUCTIONS / USER_PROMPT:跟云函数 cloudfunctions/homeworkOCR/index.js
//   里的同款 prompt 保持一致(每次改云函数 prompt 都要同步改这里)。
// - callOcr(imagePath, options):用 Azure 或官方 OpenAI 调用 Vision,返回 {drafts, rawText, elapsedMs}
// - scoreDrafts(drafts, groundTruth, options):Dice 系数匹配 + 1-1 贪心配对,
//   返回 {matches, unmatchedExpected, unmatchedDrafts, recall, precision}
//
// 任何修改 prompt 或评估算法的地方,都改这里一处;test-homework-ocr.js / eval-homework-ocr.js 共用。

'use strict'

const fs = require('fs')
const path = require('path')
const https = require('https')

// ============ Prompt(必须与 cloudfunctions/homeworkOCR/index.js 同步) ============

// 注意:下面两个 prompt 字符串必须跟 cloudfunctions/homeworkOCR/index.js 里的
// systemInstructions / userPromptText 完全一致(全角标点、空格、换行都对齐)。
// 改动时两边一起改,然后跑:
//   node -e "...diff 校验..."  (CI 可加;现在靠人工)

const SYSTEM_INSTRUCTIONS = [
  '你是一个中文小学生作业登记本智能识别引擎。',
  '任务：从作业登记本照片里识别每一条作业，返回严格 JSON。',
  '只输出 JSON 对象本身，不要解释、不要 Markdown、不要 ```。'
].join('\n')

const USER_PROMPT = [
  '识别这张作业登记本照片中的所有作业项，按下面 JSON schema 输出：',
  '{',
  '  "rawText": "整页识别到的原文，按行换行",',
  '  "drafts": [',
  '    {',
  '      "subject": "科目（语文/数学/英语/科学/道法/美术/音乐/体育/劳动/其他；不确定时给空字符串）",',
  '      "content": "作业的完整内容",',
  '      "rawText": "对应的原文片段",',
  '      "confidence": "高/中/低",',
  '      "needsConfirm": false',
  '    }',
  '  ]',
  '}',
  '',
  '关键规则：',
  '1. 表格左栏是科目（语文/数学/英语/...），右栏是该科目当天的所有作业。识别时科目跟随左栏，不要把科目名当成作业内容输出。',
  '2. 拆分条目优先看"显式编号"，再看"语义"：',
  '   a) 看到 "1." "2." "3." "①②③" "(1)(2)(3)" 等开头标记的，每个编号是一条 draft 的起点。',
  '   b) 紧跟在某条编号段落之后、自己没有编号的内容，是前一条的"延续/补充"（如截止日、备注、改正要求），即使它看起来像一个新动作或字迹模糊到看不清——这种情况一律合并到上一条 draft，不要单拆。',
  '      例：原文 "1.口算 2.练习六(1) 改错明天交 3.四单元举一反三(周三交)" 应当输出 3 条：口算 / 练习六(1)改错明天交 / 四单元举一反三(周三交)。',
  '      即便 OCR 把 "改错明天交" 读成了乱码，因为它夹在 "2." 和 "3." 之间且没有自己的编号，仍然要并到 "练习六(1)"。',
  '   c) 整栏完全没编号时，才退到纯语义判断。每一条独立作业指令（动作+对象，如"生字"、"抄书本"、"听写L15~L16"）算一条。手写标点（顿号/逗号/句号/换行）不可靠，不要作为唯一依据。',
  '3. 若一栏开头有作业范围标识（课号/单元号/页码，如"17课"、"第3单元"），后续并列项没有重复该标识时，要把它补全到每一条 draft 上，例如："17课生字、抄书本" → ["17课生字", "17课抄书本"]。注意：范围标识传递（17课 → 第二条）只在条目本身是独立动作时做；和规则 2.b 的"延续/补充"不冲突——补充信息永远归前一条。',
  '4. 常见截止日短语包括"明天交"、"今天交"、"周X交"（周一/二/三...）、"月底交"。即使字迹模糊，识别到这种模式应当判断为前一条的截止说明，不单拆。',
  '5. 不要把下列模板字段当作业输出：上学时间、离校时间、到家时间、体温记录、家长签名、作业完成情况、上午/下午、早上/晚上、周/星期/日期、"今天用X号簿"（"号簿"前是数字时同样属于模板填空，不是作业）。',
  '6. 没有识别出作业时 drafts 返回空数组。',
  '7. content 里保留页码、题号、范围、截止时间等关键信息（如"第12页 1-5题"、"周三交"）。',
  '8. 英语课号常写作 "L15"、"L16"，注意首字母 L 不要识别成数字 4 或 1。',
  '9. 字迹模糊或 subject 为空时把 needsConfirm 设为 true，confidence 给"低"。',
  '10. 不确定的字用最可能的中文原文，不要编造内容。'
].join('\n')

// ============ Env / endpoint 解析 ============

function firstEnv(names) {
  for (const n of names) if (process.env[n]) return process.env[n]
  return ''
}

function isAzure() {
  return !!firstEnv(['AZURE_OPENAI_ENDPOINT']) ||
    /azure\.com/i.test(firstEnv(['OPENAI_BASE_URL', 'OPENAI_API_BASE_URL']) || '') ||
    String(firstEnv(['OPENAI_API_TYPE']) || '').toLowerCase() === 'azure'
}

function isReasoningModel(model) {
  const name = String(model || '').toLowerCase()
  return /^o\d/.test(name) || /^gpt-5/.test(name)
}

function getEndpoint() {
  return (firstEnv(['AZURE_OPENAI_ENDPOINT', 'OPENAI_BASE_URL', 'OPENAI_API_BASE_URL']) || 'https://api.openai.com/v1')
    .replace(/\/+$/, '')
    .replace(/\/(openai|v1)$/i, '')
}

function getDeploymentOrModel() {
  // 这套 Azure 资源约定:deployment 名 == 模型名,所以 fallback 链里
  // OPENAI_OCR_MODEL / OPENAI_MODEL 同时当 deployment 名用。
  // 默认 'gpt-5.5' 跟云函数 cloudfunctions/homeworkOCR/index.js 的
  // DEFAULT_OPENAI_MODEL 对齐,本地脚本裸跑(只有 KEY + ENDPOINT 在 env 里)
  // 就能复现生产行为。
  return firstEnv([
    'AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_DEPLOYMENT_NAME',
    'OPENAI_OCR_MODEL', 'OPENAI_MODEL'
  ]) || 'gpt-5.5'
}

function getApiVersion() {
  // Responses API 在 Azure 上需要 >= 2025-03-01-preview
  const FLOOR = '2025-03'
  const SAFE = '2025-04-01-preview'
  const v = firstEnv(['AZURE_OPENAI_API_VERSION'])
  if (!v) return SAFE
  if (String(v).slice(0, 7) < FLOOR) return SAFE
  return v
}

function getApiKey() {
  return firstEnv(['OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'AZURE_API_KEY', 'OPENAI_KEY'])
}

function getReasoningEffort() {
  // 默认 'low'(本地脚本通常想要最稳的效果)。云函数因为 60s timeout 限制
  // 用 'none',但本地脚本可以用 'low' 拿到更好的召回。
  // 设 OCR_REASONING_EFFORT 覆盖。
  return process.env.OCR_REASONING_EFFORT || 'low'
}

// ============ HTTP / payload ============

function detectMime(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png'
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF') return 'image/webp'
  return 'image/jpeg'
}

function buildResponsesPayload(model, dataUrl) {
  const payload = {
    model,
    max_output_tokens: isReasoningModel(model) ? 8000 : 2400,
    text: { format: { type: 'json_object' } },
    input: [
      { role: 'system', content: [{ type: 'input_text', text: SYSTEM_INSTRUCTIONS }] },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: USER_PROMPT },
          { type: 'input_image', image_url: dataUrl, detail: 'high' }
        ]
      }
    ]
  }
  if (isReasoningModel(model)) {
    payload.reasoning = { effort: getReasoningEffort() }
  } else {
    payload.temperature = 0
  }
  return payload
}

function buildChatPayload(model, dataUrl) {
  const payload = {
    model,
    max_tokens: 2400,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_INSTRUCTIONS },
      {
        role: 'user',
        content: [
          { type: 'text', text: USER_PROMPT },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }
        ]
      }
    ]
  }
  if (!isReasoningModel(model)) payload.temperature = 0
  return payload
}

function postJson(urlString, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString)
    const requestBody = JSON.stringify(body)
    const req = https.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody)
      }, headers),
      timeout: timeoutMs
    }, (res) => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { buf += c })
      res.on('end', () => {
        let parsed = {}
        try { parsed = JSON.parse(buf) } catch (e) { /* keep empty */ }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error((parsed.error && parsed.error.message) || `HTTP ${res.statusCode}`)
          err.status = res.statusCode
          err.body = parsed
          reject(err)
          return
        }
        resolve(parsed)
      })
    })
    req.on('timeout', () => req.destroy(new Error(`request timeout after ${Math.round(timeoutMs / 1000)}s`)))
    req.on('error', reject)
    req.write(requestBody)
    req.end()
  })
}

function authHeaders(apiKey) {
  return isAzure() ? { 'api-key': apiKey } : { 'Authorization': `Bearer ${apiKey}` }
}

function azureUrls(endpoint, deployment, apiVersion) {
  const enc = encodeURIComponent(deployment)
  return {
    responses: `${endpoint}/openai/responses?api-version=${apiVersion}`,
    chat: `${endpoint}/openai/deployments/${enc}/chat/completions?api-version=${apiVersion}`
  }
}

function openaiUrls(baseUrl) {
  return {
    responses: `${baseUrl}/responses`,
    chat: `${baseUrl}/chat/completions`
  }
}

function extractText(response) {
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text
  }
  if (Array.isArray(response.output)) {
    const parts = []
    for (const item of response.output) {
      if (!item || !Array.isArray(item.content)) continue
      for (const piece of item.content) {
        if (!piece) continue
        if (piece.type === 'output_text' || piece.type === 'text') {
          if (typeof piece.text === 'string') parts.push(piece.text)
        }
      }
    }
    if (parts.length) return parts.join('')
  }
  const msg = response.choices && response.choices[0] && response.choices[0].message
  const content = msg && msg.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('')
  }
  return ''
}

// ============ 主接口:callOcr ============

/**
 * 调用 Vision OCR,返回结构化结果。
 * @param {string} imagePath  图片绝对路径
 * @param {object} [options]
 * @param {number} [options.timeoutMs=240000]
 * @returns {Promise<{rawText: string, drafts: Array, model: string, effort: string|null, source: 'responses'|'chat_completions', elapsedMs: number}>}
 */
async function callOcr(imagePath, options = {}) {
  const apiKey = getApiKey()
  if (!apiKey) {
    throw new Error('缺少 API key:Azure 请配 AZURE_OPENAI_API_KEY,官方请配 OPENAI_API_KEY')
  }
  if (isAzure() && !firstEnv(['AZURE_OPENAI_ENDPOINT'])) {
    throw new Error('Azure 路径下必须配 AZURE_OPENAI_ENDPOINT(形如 https://<resource>.openai.azure.com)')
  }
  const model = getDeploymentOrModel()
  const timeoutMs = options.timeoutMs || 240000

  const imageBuffer = fs.readFileSync(imagePath)
  const dataUrl = `data:${detectMime(imageBuffer)};base64,${imageBuffer.toString('base64')}`

  const headers = authHeaders(apiKey)
  const urls = isAzure()
    ? azureUrls(getEndpoint(), getDeploymentOrModel(), getApiVersion())
    : openaiUrls(getEndpoint())

  const t0 = Date.now()
  let source = 'responses'
  let response
  try {
    response = await postJson(urls.responses, headers, buildResponsesPayload(model, dataUrl), timeoutMs)
  } catch (err) {
    const status = err.status || 0
    const msg = String(err.message || '').toLowerCase()
    const fallback =
      status === 404 ||
      msg.includes('not found') ||
      (status === 400 && msg.includes('responses api') && msg.includes('api-version'))
    if (!fallback) throw err
    source = 'chat_completions'
    response = await postJson(urls.chat, headers, buildChatPayload(model, dataUrl), timeoutMs)
  }
  const elapsedMs = Date.now() - t0

  const textContent = extractText(response)
  if (!textContent.trim()) {
    throw new Error('模型返回内容为空')
  }
  let parsed
  try {
    parsed = JSON.parse(textContent)
  } catch (e) {
    throw new Error(`模型返回不是合法 JSON: ${e.message}\n${textContent}`)
  }

  return {
    rawText: String(parsed.rawText || ''),
    drafts: Array.isArray(parsed.drafts) ? parsed.drafts : [],
    model,
    effort: isReasoningModel(model) ? getReasoningEffort() : null,
    source,
    elapsedMs
  }
}

// ============ 评分:scoreDrafts ============

/**
 * 字符级 Dice 系数:2|A∩B| / (|A|+|B|),范围 [0, 1],对短串相对宽容。
 * 例:"17课生字" vs "17课生字、抄书本" → 10/14 = 0.71
 *    "练习六(1)改错明天交" vs "练习六(1)" → 12/17 = 0.71
 *    "口算" vs "心算" → 2/4 = 0.50(刚好阈值,看具体情况)
 */
function diceSimilarity(a, b) {
  const sa = String(a || '')
  const sb = String(b || '')
  if (!sa && !sb) return 1
  if (!sa || !sb) return 0
  const setA = new Set(sa)
  const setB = new Set(sb)
  let intersection = 0
  for (const ch of setA) if (setB.has(ch)) intersection++
  return (2 * intersection) / (setA.size + setB.size)
}

/**
 * subject 匹配:都非空时要求相等;一边空当通配。
 */
function subjectAgrees(a, b) {
  const sa = String(a || '').trim()
  const sb = String(b || '').trim()
  if (!sa || !sb) return true
  return sa === sb
}

/**
 * 1-to-1 贪心配对:每次选当前最高的 (expected, draft) 对,各自从池子里取走。
 * 阈值默认 0.5(>= 0.5 才算 match)。
 *
 * @param {Array<{subject?: string, content: string}>} drafts
 * @param {Array<{subject?: string, content: string}>} groundTruth
 * @param {object} [options]
 * @param {number} [options.threshold=0.5]
 * @returns {{
 *   matches: Array<{expected, draft, score}>,
 *   unmatchedExpected: Array,
 *   unmatchedDrafts: Array,
 *   recall: number,
 *   precision: number,
 *   avgScore: number
 * }}
 */
function scoreDrafts(drafts, groundTruth, options = {}) {
  const threshold = options.threshold != null ? options.threshold : 0.5
  // 算所有候选对的分数
  const pairs = []
  for (let i = 0; i < groundTruth.length; i++) {
    for (let j = 0; j < drafts.length; j++) {
      if (!subjectAgrees(groundTruth[i].subject, drafts[j].subject)) continue
      const score = diceSimilarity(groundTruth[i].content, drafts[j].content)
      if (score >= threshold) pairs.push({ i, j, score })
    }
  }
  // 按 score 降序贪心配对
  pairs.sort((a, b) => b.score - a.score)
  const usedExpected = new Set()
  const usedDraft = new Set()
  const matches = []
  for (const p of pairs) {
    if (usedExpected.has(p.i) || usedDraft.has(p.j)) continue
    usedExpected.add(p.i)
    usedDraft.add(p.j)
    matches.push({ expected: groundTruth[p.i], draft: drafts[p.j], score: p.score })
  }
  const unmatchedExpected = groundTruth.filter((_, i) => !usedExpected.has(i))
  const unmatchedDrafts = drafts.filter((_, j) => !usedDraft.has(j))
  const recall = groundTruth.length ? matches.length / groundTruth.length : 0
  const precision = drafts.length ? matches.length / drafts.length : 0
  const avgScore = matches.length ? matches.reduce((s, m) => s + m.score, 0) / matches.length : 0

  return { matches, unmatchedExpected, unmatchedDrafts, recall, precision, avgScore }
}

// ============ 样本加载 ============

/**
 * 加载一个 sample JSON,返回 {id, image, capturedAt, notes, groundTruth, imageAbsPath}。
 * image 字段相对路径相对于 JSON 所在目录。
 */
function loadSample(jsonPath) {
  const abs = path.resolve(jsonPath)
  const sample = JSON.parse(fs.readFileSync(abs, 'utf8'))
  const imageRel = sample.image
  if (!imageRel) throw new Error(`Sample ${abs} 缺少 image 字段`)
  const imageAbsPath = path.isAbsolute(imageRel)
    ? imageRel
    : path.resolve(path.dirname(abs), imageRel)
  if (!fs.existsSync(imageAbsPath)) {
    throw new Error(`Sample ${sample.id || abs} 引用的图片不存在: ${imageAbsPath}`)
  }
  return {
    id: sample.id || path.basename(abs, '.json'),
    image: imageRel,
    imageAbsPath,
    capturedAt: sample.capturedAt || '',
    notes: sample.notes || '',
    groundTruth: Array.isArray(sample.groundTruth) ? sample.groundTruth : []
  }
}

/**
 * 找一个目录下的所有 sample JSON(不含 _ 开头的)。
 */
function listSamples(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !name.startsWith('_'))
    .map((name) => path.join(dir, name))
    .sort()
}

module.exports = {
  // prompt / config
  SYSTEM_INSTRUCTIONS,
  USER_PROMPT,
  isAzure,
  isReasoningModel,
  getEndpoint,
  getDeploymentOrModel,
  getApiVersion,
  getReasoningEffort,
  // ocr
  callOcr,
  // scoring
  diceSimilarity,
  scoreDrafts,
  // sample
  loadSample,
  listSamples
}
