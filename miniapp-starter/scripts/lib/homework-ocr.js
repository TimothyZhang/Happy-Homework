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
  '2. 拆分条目的硬规则：先数编号，看到 N 个编号就要输出 N 条 draft（这条优先级最高，跟下面的"合并/延续"冲突时以"数清楚 N 条"为准）。',
  '   a) 在每个科目栏内，扫所有像 "1." "2." "3." "1、" "2、" "①②③" "(1)(2)(3)" 这种开头标记。能数到 N 个（1~N 连续或近似连续），就要输出正好 N 条 draft——不管它们写在同一行、跨多行、还是字迹乱到几乎看不清。',
  '      例 A（挤在一行）：数学栏 "1.口算  2.目P53~54  3.举一反三(周五交)  4.作息表" → 输出 4 条，不可因为挤在一行就合并成一条混合内容。',
  '      例 B（跨行）：数学栏 "1.口算  2.复习六单元" 加下一行 "3.目P61-62" → 一共 3 个编号，输出 3 条：口算 / 复习六单元 / 目P61-P62。',
  '      例 C（编号紧贴 / 中间没空格）：英语栏 "1.听默2.百词3.研学单" → 看见 3 个编号就是 3 条 [听默, 百词, 研学单]，即使紧贴无空格也不能合并成"听默百词单"这种伪装的一条；同理数学栏 "1.口算 2.目P21" 是 [口算, 目标P21] 两条，绝不可错并成"口算P21"或"口答P21"。**最常见的识错模式**：前一项末字（算/写/读…）+ 后一项页码 / 起头字 被错并成一个假复合词，看见这种结构时优先按编号拆。',
  '   b) 紧跟在某条编号 K 之后、自己没有新编号的片段，是第 K 条的"延续/补充"（截止日、备注、改正要求），即使看起来像新动作或字迹乱也合并到第 K 条，不要单拆。',
  '      例：原文 "1.口算 2.练习六(1) 改错明天交 3.四单元举一反三(周三交)" 中"改错明天交"没自己的编号，并入第 2 条 → 3 条：口算 / 练习六(1)改错明天交 / 四单元举一反三(周三交)。',
  '   c) 整栏完全没编号时，才退到纯语义判断：每一条独立作业指令（动作+对象，如"生字"、"抄书本"、"听写L15~L16"）算一条。手写标点（顿号/逗号/句号/换行）不可靠，不要作为唯一依据。',
  '3. 若一栏开头有作业范围标识（课号/单元号/页码，如"17课"、"第3单元"），后续并列项没有重复该标识时，要把它补全到每一条 draft 上，例如："17课生字、抄书本" → ["17课生字", "17课抄书本"]。注意：范围标识传递（17课 → 第二条）只在条目本身是独立动作时做；和规则 2.b 的"延续/补充"不冲突——补充信息永远归前一条。',
  '4. 常见截止日短语包括"明天交"、"今天交"、"周X交"（周一/二/三...）、"月底交"。即使字迹模糊，识别到这种模式应当判断为前一条的截止说明，不单拆。',
  '5. 不要把下列模板字段当作业输出：上学时间、离校时间、到家时间、体温记录、家长签名、作业完成情况、上午/下午、早上/晚上、周/星期/日期、"今天用X号簿"（"号簿"前是数字时同样属于模板填空，不是作业）。',
  '6. 没有识别出作业时 drafts 返回空数组。',
  '7. content 里保留页码、题号、范围、截止时间等关键信息（如"第12页 1-5题"、"周三交"）。',
  '8. 英语课号常写作 "L15"、"L16"，注意首字母 L 不要识别成数字 4 或 1。',
  '9. 字迹模糊或 subject 为空时把 needsConfirm 设为 true，confidence 给"低"。',
  '10. 不确定的字用最可能的中文原文，不要编造内容。',
  '11. 每条作业末尾常画"小方框 口"、"对勾 ✓/√"、"小圆圈 ○" 当完成标记（家长/学生勾掉用），这些是图形不是字，不要把它们识成 "10"、"D"、"0" 之类并入 content。',
  '12. 常见缩写要补全成完整词。学生在登记本上写得快时会用单字缩写，识别后请还原成完整词写进 content（rawText 保留原样）：',
  '    - "目X" / "目PXX" / "目XX-XX" → "目标X" / "目标PXX" / "目标XX-XX"，例如 "目P51-52" → "目标P51-52"。',
  '    - "预X" / "预X,Y" / "预X、Y" / "预X课" → "预习第X课" / "预习第X、Y课"，例如 "预5,6" → "预习第5、6课"。',
  '    - "复X" → "复习X"，例如 "复百词" → "复习百词"。',
  '    只在"单字 + 数字 / 页码 / 范围"这种缩写模式下补全；原文已经写全的（如"目标24课"、"预习25课"、"复习"独立成条）保持不变。',
  '13. 常见小学作业词参考词典。字迹模糊但能依稀辨形时优先匹配下列已知词，避免识成形似但语义不通的字（仍受规则 10「不编造」约束，看不出就别套）：',
  '    - 语文：学习单、研学单、习作、抄书本、生字、复习、预习、目标（常缩"目"）。',
  '    - 数学：口算、举一反三、每周一讲、目标（常缩"目"）、小练习、改错、习作。',
  '    - 英语：听写、复习、百词、研学单、L 课（L15、L16）。',
  '    例：手写"百词"易被识成"白词/单词/台词"，"研学单"易被识成"听写单/所学单"——这两种情况按词典回到"百词"和"研学单"。',
  '14. 高频识错黑名单。下列"伪词"在小学作业本里几乎都是误识，识别时要回纠成右侧正确词（rawText 保留原样，content 用正确词）：',
  '    - "口答" → "口算"。小学作业不存在"口答"这种项，看到几乎一定是"口算"误识。',
  '    - "口答P[页码]" / "口答[数字]" → 这是"1.口算 2.目标P[页码]"两条被错并成一条，按规则 2.a 拆成 [口算, 目标P[页码]] 两条。',
  '    - "白词" / "台词" / 孤立的"单词"（前面没修饰） → "百词"。',
  '    - 英语栏的"听写单" / "所学单" / "听默百词单" → "研学单"（英语小学常见词，参规则 13）。',
  '    - "目-[数字]" / "目标-[数字]"（只有数字、缺字母 P） → "目P[数字]"（漏识了 P 字母，补回）。',
  '    仍受规则 10「不编造」约束：字迹完全看不出原文时不要强行套黑名单。'
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
 * 图片按同名 + 常见图片后缀在 JSON 所在目录里找;也兼容老 schema 的显式 image 字段。
 */
const SAMPLE_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.heic']

function loadSample(jsonPath) {
  const abs = path.resolve(jsonPath)
  const sample = JSON.parse(fs.readFileSync(abs, 'utf8'))
  const dir = path.dirname(abs)
  const baseName = path.basename(abs, '.json')

  let imageRel = sample.image
  let imageAbsPath
  if (imageRel) {
    imageAbsPath = path.isAbsolute(imageRel) ? imageRel : path.resolve(dir, imageRel)
  } else {
    for (const ext of SAMPLE_IMAGE_EXTS) {
      const candidate = path.join(dir, baseName + ext)
      if (fs.existsSync(candidate)) {
        imageAbsPath = candidate
        imageRel = baseName + ext
        break
      }
    }
    if (!imageAbsPath) {
      throw new Error(`Sample ${sample.id || abs} 找不到同名图片(尝试过 ${SAMPLE_IMAGE_EXTS.join('/')})`)
    }
  }
  if (!fs.existsSync(imageAbsPath)) {
    throw new Error(`Sample ${sample.id || abs} 引用的图片不存在: ${imageAbsPath}`)
  }
  return {
    id: sample.id || baseName,
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
