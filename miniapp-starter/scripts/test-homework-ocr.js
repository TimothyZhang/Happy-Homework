// 直接调用 OpenAI / Azure OpenAI Vision 跑一遍 homeworkOCR 的 prompt,
// 验证识别和提取效果。不依赖云函数环境,纯 Node + https。
//
// 用法 A —— Azure OpenAI(对应云函数当前生产配置):
//   AZURE_OPENAI_API_KEY=...                                  \
//   AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com \
//   AZURE_OPENAI_DEPLOYMENT=gpt-5                             \
//   [AZURE_OPENAI_API_VERSION=2025-04-01-preview]             \
//     node miniapp-starter/scripts/test-homework-ocr.js <image_path>
//
// 用法 B —— 官方 OpenAI:
//   OPENAI_API_KEY=sk-... [OPENAI_OCR_MODEL=gpt-5] [OPENAI_BASE_URL=...] \
//     node miniapp-starter/scripts/test-homework-ocr.js <image_path>
//
// 这几个 env 与云函数同名,可以直接从 微信云开发面板 → 云函数 homeworkOCR
// → 版本与配置 → 环境变量 复制过来。
//
// 默认走 Responses API(匹配 gpt-5 / o-series);老模型(gpt-4o)失败时
// 自动回退 Chat Completions。

const fs = require('fs')
const path = require('path')
const https = require('https')

const SYSTEM_INSTRUCTIONS = [
  '你是一个中文小学生作业登记本智能识别引擎。',
  '任务:从作业登记本照片里识别每一条作业,返回严格 JSON。',
  '只输出 JSON 对象本身,不要解释、不要 Markdown、不要 ```。'
].join('\n')

const USER_PROMPT = [
  '识别这张作业登记本照片中的所有作业项,按下面 JSON schema 输出:',
  '{',
  '  "rawText": "整页识别到的原文,按行换行",',
  '  "drafts": [',
  '    {',
  '      "subject": "科目(语文/数学/英语/科学/道法/美术/音乐/体育/劳动/其他;不确定时给空字符串)",',
  '      "content": "作业的完整内容",',
  '      "rawText": "对应的原文片段",',
  '      "confidence": "高/中/低",',
  '      "needsConfirm": false',
  '    }',
  '  ]',
  '}',
  '',
  '关键规则:',
  '1. 表格左栏是科目(语文/数学/英语/...),右栏是该科目当天的所有作业。识别时科目跟随左栏,不要把科目名当成作业内容输出。',
  '2. 一栏内通常包含多条独立作业。判断"是不是一条"以语义为准——手写标点(顿号/逗号/分号/句号/空格/换行)非常不稳定,不能作为唯一依据。每一条独立的作业指令(明确的动作 + 对象,如"生字"、"抄书本"、"听写L15~L16"、"改卷子"、"练习册1-5题")都应是一条单独的 draft。',
  '3. 若一栏开头有作业范围标识(课号/单元号/页码/练习号,如"17课"、"第3单元"、"练习六(1)"),后续并列项没有重复该标识时,要把它补全到每一条 draft 上,例如:"17课生字、抄书本" → ["17课生字", "17课抄书本"];"练习册第12页 1-5题、6-10题" → ["练习册第12页 1-5题", "练习册第12页 6-10题"]。反过来,同一条作业的补充信息(截止日、说明、要求)不要单拆,例如"练习六(1)改错明天交"是一条完整作业,不要拆成"练习六(1)改错"和"明天交"。',
  '4. 不要把下列模板字段当作业输出:上学时间、离校时间、到家时间、体温记录、家长签名、作业完成情况、上午/下午、早上/晚上、周/星期/日期、"今天用X号簿"("号簿"前是数字时同样属于模板填空,不是作业)。',
  '5. 没有识别出作业时 drafts 返回空数组。',
  '6. content 里保留页码、题号、范围、截止时间等关键信息(如"第12页 1-5题"、"周三交")。',
  '7. 英语课号常写作 "L15"、"L16",注意首字母 L 不要识别成数字 4 或 1。',
  '8. 字迹模糊或 subject 为空时把 needsConfirm 设为 true,confidence 给"低"。',
  '9. 不确定的字用最可能的中文原文,不要编造内容。'
].join('\n')

function detectMime(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png'
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF') return 'image/webp'
  return 'image/jpeg'
}

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
    .replace(/\/(openai|v1)$/i, '') // 兼容尾巴
}

function getDeploymentOrModel() {
  return firstEnv([
    'AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_DEPLOYMENT_NAME',
    'OPENAI_OCR_MODEL', 'OPENAI_MODEL'
  ]) || 'gpt-4o'
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

function buildResponsesPayload(model, dataUrl) {
  const payload = {
    model,
    // 推理模型(gpt-5/o-series)的 max_output_tokens 同时算推理 token,留宽点防截断;
    // reasoning.effort='minimal' 让模型直接看图输出结构,不去做长链思考。
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
    // 默认 'low'(gpt-5.5 上 17s/75%召回最佳,gpt-5 上也合法不会 400)。
    // OCR_REASONING_EFFORT=minimal/none/medium/high/xhigh 可强制切档调试。
    payload.reasoning = { effort: process.env.OCR_REASONING_EFFORT || 'low' }
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

function postJson(urlString, headers, body) {
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
      timeout: 240000
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
    req.on('timeout', () => req.destroy(new Error('request timeout after 240s')))
    req.on('error', reject)
    req.write(requestBody)
    req.end()
  })
}

function authHeaders(apiKey) {
  return isAzure()
    ? { 'api-key': apiKey }
    : { 'Authorization': `Bearer ${apiKey}` }
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

async function callOnce(model, dataUrl) {
  const apiKey = getApiKey()
  const headers = authHeaders(apiKey)
  const urls = isAzure()
    ? azureUrls(getEndpoint(), getDeploymentOrModel(), getApiVersion())
    : openaiUrls(getEndpoint())

  // Responses → Chat Completions 回退
  try {
    const r = await postJson(urls.responses, headers, buildResponsesPayload(model, dataUrl))
    return { source: 'responses', response: r }
  } catch (err) {
    const status = err.status || 0
    const msg = String(err.message || '').toLowerCase()
    const fallback =
      status === 404 ||
      msg.includes('not found') ||
      (status === 400 && msg.includes('responses api') && msg.includes('api-version'))
    if (!fallback) throw err
    console.warn(`[warn] Responses API 不可用 (${err.message}),回退 Chat Completions`)
    const r = await postJson(urls.chat, headers, buildChatPayload(model, dataUrl))
    return { source: 'chat_completions', response: r }
  }
}

// 与用户提供的 ground truth 做粗略对比:每个 draft 的 content 子串匹配。
const EXPECTED = [
  { subject: '语文', keywords: ['17课', '生字'] },
  { subject: '语文', keywords: ['抄书本'] },
  { subject: '数学', keywords: ['口算'] },
  { subject: '数学', keywords: ['练习六', '改错', '明天交'] },
  { subject: '数学', keywords: ['四单元', '举一反三', '周三交'] },
  { subject: '英语', keywords: ['15', '16', '课', '目标'] },
  { subject: '英语', keywords: ['L15', 'L16', '明天听'] },
  { subject: '英语', keywords: ['改卷子'] }
]

function scoreDrafts(drafts) {
  const matched = []
  const remaining = drafts.slice()
  for (const exp of EXPECTED) {
    const idx = remaining.findIndex((d) => {
      if (d.subject && exp.subject && d.subject !== exp.subject) return false
      const text = String(d.content || '')
      return exp.keywords.every((kw) => text.includes(kw))
    })
    if (idx >= 0) {
      matched.push({ expected: exp, actual: remaining[idx] })
      remaining.splice(idx, 1)
    } else {
      matched.push({ expected: exp, actual: null })
    }
  }
  const recall = matched.filter((m) => m.actual).length / EXPECTED.length
  const extra = remaining
  const precision = drafts.length ? (drafts.length - extra.length) / drafts.length : 0
  return { matched, extra, recall, precision }
}

async function main() {
  const imagePath = process.argv[2]
  if (!imagePath) {
    console.error('用法: node scripts/test-homework-ocr.js <image_path>')
    process.exit(1)
  }
  const apiKey = getApiKey()
  if (!apiKey) {
    console.error('缺少 API key:Azure 请配 AZURE_OPENAI_API_KEY,官方请配 OPENAI_API_KEY')
    process.exit(1)
  }
  const azure = isAzure()
  if (azure) {
    const ep = firstEnv(['AZURE_OPENAI_ENDPOINT'])
    if (!ep) {
      console.error('Azure 路径下必须配 AZURE_OPENAI_ENDPOINT(形如 https://<resource>.openai.azure.com)')
      process.exit(1)
    }
  }
  const model = getDeploymentOrModel()

  const absPath = path.resolve(imagePath)
  const imageBuffer = fs.readFileSync(absPath)
  const dataUrl = `data:${detectMime(imageBuffer)};base64,${imageBuffer.toString('base64')}`

  console.log(`[info] 图片: ${absPath} (${imageBuffer.length} bytes)`)
  console.log(`[info] provider: ${azure ? 'Azure OpenAI' : 'OpenAI'}`)
  console.log(`[info] endpoint: ${getEndpoint()}`)
  if (azure) console.log(`[info] deployment / api-version: ${model} / ${getApiVersion()}`)
  else console.log(`[info] model: ${model}`)
  console.log('[info] 调用中...')

  const t0 = Date.now()
  const { source, response } = await callOnce(model, dataUrl)
  const ms = Date.now() - t0
  console.log(`[info] 调用通道: ${source}, 耗时: ${ms} ms`)

  const textContent = extractText(response)
  if (!textContent.trim()) {
    console.error('模型返回内容为空')
    console.error(JSON.stringify(response, null, 2))
    process.exit(2)
  }

  let parsed
  try {
    parsed = JSON.parse(textContent)
  } catch (e) {
    console.error('模型返回不是合法 JSON:', e.message)
    console.error('原始内容:\n' + textContent)
    process.exit(3)
  }

  console.log('\n=== rawText ===')
  console.log(parsed.rawText || '(空)')

  const drafts = Array.isArray(parsed.drafts) ? parsed.drafts : []
  console.log(`\n=== drafts (${drafts.length}) ===`)
  drafts.forEach((d, i) => {
    console.log(`#${i + 1} [${d.subject || '?'}] ${d.content}  (置信度=${d.confidence}, needsConfirm=${d.needsConfirm})`)
    if (d.rawText && d.rawText !== d.content) console.log(`    原文: ${d.rawText}`)
  })

  const { matched, extra, recall, precision } = scoreDrafts(drafts)
  console.log('\n=== 与 ground truth 对比 ===')
  matched.forEach((m) => {
    const exp = m.expected
    const tag = m.actual ? '✓' : '✗ 缺失'
    const got = m.actual ? `→ ${m.actual.content}` : ''
    console.log(`${tag}  期望:[${exp.subject}] ${exp.keywords.join(' / ')} ${got}`)
  })
  if (extra.length) {
    console.log('\n--- 多出的 drafts (可能是模板字段或拆碎了的额外条目) ---')
    extra.forEach((d) => console.log(`  ? [${d.subject || '?'}] ${d.content}`))
  }
  console.log(`\n召回率: ${(recall * 100).toFixed(1)}%  (${matched.filter((m) => m.actual).length}/${EXPECTED.length})`)
  console.log(`准确率: ${(precision * 100).toFixed(1)}%  (有效/${drafts.length})`)
}

main().catch((err) => {
  console.error('[error]', err.message)
  if (err.body) console.error(JSON.stringify(err.body, null, 2))
  process.exit(99)
})
