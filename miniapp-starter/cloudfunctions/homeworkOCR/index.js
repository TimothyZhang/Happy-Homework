'use strict'

const http = require('http')
const https = require('https')

// === OpenAI 模型 + reasoning effort 配对(此处改一个,另一个一起评估) ===
// 默认走 gpt-5.5(对应 Azure 同名 deployment)。实测在小学生作业登记本手写体
// 上召回 75%,显著优于 gpt-5(50%)和 gpt-4o(37%)。
// reasoning effort:云函数 timeout 已经升到 120s(见 SCF 配置),gpt-5.5 + low
// 端到端 17s 跑得动,recall 比 none 稳定高 10pp 左右(sample12 上 80% → 90%+)。
// 'minimal' 在 gpt-5.5 上不被接受;gpt-5 / o-series 才支持。
// 想覆盖,云函数 env 里设 OPENAI_OCR_MODEL / OPENAI_REASONING_EFFORT 仍会优先生效。
const DEFAULT_OPENAI_MODEL = 'gpt-5.5'
const DEFAULT_REASONING_EFFORT = 'low'
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'

const DEFAULT_MOCK_RAW_TEXT = `语文：抄写第3课生字两遍
数学：练习册第12页第1-5题
英语：背诵单词1-20
带彩纸一张，周三手工课用`

let cloud
let OcrClient
let createWorker
let builtinLangData
let hasLoadedOcrSdk = false
let hasLoadedTesseract = false
let tesseractWorkerPromise = null
let OpenAiSdk = null
let AzureOpenAiSdk = null
let hasLoadedOpenAiSdk = false
let openAiClientCache = null

try {
  cloud = require('wx-server-sdk')
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
} catch (error) {
  cloud = null
}

const OCR_RATE_COLLECTION = 'ocr_rate_limit'
const OCR_RATE_WINDOW_MS = 60 * 1000
const OCR_RATE_MAX_PER_WINDOW = 10

// 客户端预建 job doc 的集合。微信 wx.cloud.callFunction 网关有 60s 硬性同步
// 超时(-501002 / ESOCKETTIMEDOUT,控制台/客户端 timeout 都改不了)。OCR 偶尔
// 跑过 60s 时,网关会断掉同步连接,但本函数作为独立 SCF 执行仍会跑到 120s
// timeout 才结束。我们把最终结果落进 job doc,客户端网关超时后改用 DB 轮询
// 把结果捞回来。详见 main() 末尾和 persistJobResult。
const OCR_JOB_COLLECTION = 'ocr_jobs'
let hasEnsuredOcrJobCollection = false

// mockRawText 旁路只在本地/预发联调用 —— 生产部署不要置这个环境变量,
// 否则任意 client 都能塞一段假"识别结果",后续 ocr-result 页就用假数据
// 走完打卡链路。
const MOCK_RAW_TEXT_ALLOWED = !!process.env.OCR_ALLOW_MOCK_RAW_TEXT

function getAdminOpenids() {
  // 跟 adminPanel 共用同一个 env 白名单。这里只用 env 不读硬编码列表,
  // 避免两个云函数行为不一致。
  const raw = (process.env.ADMIN_OPENIDS || '').trim()
  if (!raw) return new Set()
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
}

function isOcrAdmin(openid) {
  if (!openid) return false
  return getAdminOpenids().has(openid)
}

// per-openid 滑动窗口限流。每个用户在 OCR_RATE_COLLECTION 里一条文档:
// { _openid, count, windowStart }。每次调 OCR 累加 count,跨过 window 重置。
// 目的不是精确防刷,而是挡住恶意脚本无脑批量调 = 烧 OpenAI/Azure 算力。
async function checkOcrRateLimit(openid) {
  if (!cloud) return true   // 本地联调没有 cloud SDK,跳过
  const db = cloud.database()
  try {
    await db.createCollection(OCR_RATE_COLLECTION)
  } catch (e) {
    // 已存在或权限问题都让后续 query 自然失败
  }
  const now = Date.now()
  const res = await db.collection(OCR_RATE_COLLECTION)
    .where({ _openid: openid })
    .limit(1)
    .get()
  const doc = (res.data && res.data[0]) || null
  if (!doc) {
    await db.collection(OCR_RATE_COLLECTION).add({
      data: { _openid: openid, count: 1, windowStart: now }
    })
    return true
  }
  if (now - (doc.windowStart || 0) > OCR_RATE_WINDOW_MS) {
    await db.collection(OCR_RATE_COLLECTION).doc(doc._id).update({
      data: { count: 1, windowStart: now }
    })
    return true
  }
  if ((doc.count || 0) >= OCR_RATE_MAX_PER_WINDOW) {
    return false
  }
  await db.collection(OCR_RATE_COLLECTION).doc(doc._id).update({
    data: { count: db.command.inc(1) }
  })
  return true
}

/**
 * homeworkOCR 云函数
 *
 * 支持两种模式：
 * 1. 传入 imageFileID，走真实 OCR 识别
 * 2. 传入 mockRawText，便于本地联调拆分逻辑
 */
async function main(event = {}) {
  const ctx = cloud ? cloud.getWXContext() : {}
  const callerOpenid = (ctx && ctx.OPENID) || ''

  // diagnose 只对管理员开放 —— 这个端点会列出哪些 OCR-相关环境变量已配
  // (含 OPENAI/AZURE/TENCENT key 名)、Azure endpoint URL、deployment 名,
  // 给攻击者递侦察图。普通用户没有任何用得到这个信息的场景。
  if (event && event.diagnose === true) {
    if (!isOcrAdmin(callerOpenid)) {
      return { ok: false, reason: 'not_admin' }
    }
    return collectDiagnostics()
  }

  // 生产环境拒绝匿名调用 —— OpenAI/Azure 按 token 计费,如果云函数没接
  // OPENID 闸,有人拿到 appId + cloud env 后能脚本无限调用刷算力。
  // 本地联调没有 cloud SDK 时 callerOpenid 为空,放行不挡。
  if (cloud && !callerOpenid) {
    return { ok: false, reason: 'no_openid' }
  }

  // mockRawText 旁路在生产环境直接关掉。
  if (event && event.mockRawText && !MOCK_RAW_TEXT_ALLOWED) {
    return {
      ok: false,
      errorCode: 'MOCK_DISABLED',
      error: 'mockRawText 仅在显式开启 OCR_ALLOW_MOCK_RAW_TEXT 的环境可用'
    }
  }

  // per-openid 限流。10 次/60s,正常用户改一张作业图不会触发。
  if (callerOpenid) {
    try {
      const allowed = await checkOcrRateLimit(callerOpenid)
      if (!allowed) {
        return {
          ok: false,
          errorCode: 'RATE_LIMITED',
          error: '识别频率过高,稍后再试',
          retryAfterMs: OCR_RATE_WINDOW_MS
        }
      }
    } catch (e) {
      // 限流逻辑挂了不阻塞业务 —— 真正的防线是上面的 OPENID 闸,这里只是
      // 限流软层。打一行 warn 便于排查 ocr_rate_limit 集合是否有问题。
      console.warn('homeworkOCR rate-limit check failed', e && e.errMsg)
    }
  }

  // 客户端在调用前预建了 job doc(用自己的 _openid,creator-only ACL),用于
  // 网关 60s 超时后的轮询兜底。这里顺手保证集合存在 —— 客户端建不了集合,
  // 首次部署后由本函数创建,第二次调用起客户端就能预建 doc。
  await ensureOcrJobCollection()

  let response
  try {
    const recognition = await recognizeRegisterText(event)
    // Provider(主要是 OpenAI Vision)若已经直接吐出结构化 drafts,直接用,
    // 跳过 parseHomeworkRegister 那个基于行 + 正则的解析(对表格场景会切碎)。
    const drafts = (Array.isArray(recognition.drafts) && recognition.drafts.length > 0)
      ? recognition.drafts
      : parseHomeworkRegister(recognition.rawText)

    response = {
      ok: true,
      source: recognition.source,
      providerWarning: recognition.providerWarning || '',
      // 已清掉的 fileID 仍然回传 —— 客户端打日志/诊断用,不会再去访问。
      imageFileID: event.imageFileID || '',
      rawText: recognition.rawText,
      drafts
    }
  } catch (error) {
    // 不打 stack —— 上游 SDK 偶尔会把请求体片段(prompt / 图片元数据)
    // 嵌进 stack,云函数日志在腾讯云侧保留期较长,减少敏感面。
    console.error('homeworkOCR failed', {
      code: error.code,
      message: error.message,
      requestId: error.requestId || ''
    })

    response = {
      ok: false,
      source: 'cloud-function',
      imageFileID: event.imageFileID || '',
      errorCode: error.code || 'OCR_FAILED',
      error: error.message || 'OCR 识别失败',
      requestId: error.requestId || '',
      canFallback: isBuiltinOcrFallbackEnabled()
    }
  }

  // 识别成功/失败都清云存储里的原图。我们已经把作业文本提取到响应里,
  // 原图(孩子手写作业,含可能的姓名/班级/家长签名)再保留没必要,
  // 也避免长期合规风险。客户端没有用 fileID 复跑的路径(失败后弹框 →
  // 看演示 / 重新选图都不会复用旧 fileID)。失败只 warn,不阻塞响应。
  // 注意:只删 wx.cloud.uploadFile 上传的 fileID,不要碰本地 imagePath。
  if (event.imageFileID && cloud) {
    try {
      await cloud.deleteFile({ fileList: [event.imageFileID] })
    } catch (cleanupErr) {
      console.warn('homeworkOCR cleanup failed', {
        message: cleanupErr && cleanupErr.message
      })
    }
  }

  // 把最终结果(成功/失败都写)落进客户端预建的 job doc。这是绕开微信
  // callFunction 网关 60s 同步超时(-501002 / ESOCKETTIMEDOUT)的兜底:网关
  // 断了同步连接,但本函数仍跑到 120s 才结束,结果在这里持久化,客户端轮询
  // 捞回。payload 含作业文本,只有建 doc 的用户自己可读,客户端读完即删。
  await persistJobResult(event.jobDocId, response)

  return response
}

async function ensureOcrJobCollection() {
  if (!cloud || hasEnsuredOcrJobCollection) return
  hasEnsuredOcrJobCollection = true
  try {
    await cloud.database().createCollection(OCR_JOB_COLLECTION)
  } catch (e) {
    // 已存在 / 权限问题都忽略 —— 真正的读写靠下面 persistJobResult 与客户端,
    // 出问题那里会再 warn。
  }
}

// 把识别结果写回客户端预建的 job doc(见 OCR_JOB_COLLECTION 注释)。
// best-effort:写失败只 warn,绝不影响同步返回。doc 是客户端用自己的
// _openid 建的,这里以 admin 身份按 _id update —— 不动 _openid 等系统字段,
// 所以客户端仍按 creator-only ACL 读得到自己这条。
async function persistJobResult(jobDocId, payload) {
  if (!jobDocId || !cloud) return
  try {
    const db = cloud.database()
    await db.collection(OCR_JOB_COLLECTION).doc(jobDocId).update({
      data: {
        status: 'done',
        payload,
        finishedAt: Date.now()
      }
    })
  } catch (error) {
    console.warn('homeworkOCR persistJobResult failed', {
      jobDocId,
      message: error && error.message
    })
  }
}

function collectDiagnostics() {
  // 把 env vars / SDK 版本 / provider 选取这些状态打包返回,前端不需要重部署就能拿到。
  const presentEnv = [
    'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'AZURE_API_KEY', 'OPENAI_KEY',
    'AZURE_OPENAI_ENDPOINT', 'OPENAI_BASE_URL', 'OPENAI_API_BASE_URL',
    'AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_DEPLOYMENT_NAME',
    'AZURE_OPENAI_API_VERSION',
    'OPENAI_OCR_MODEL', 'OPENAI_MODEL',
    'OPENAI_API_TYPE',
    'OPENAI_USE_CHAT_COMPLETIONS', 'OPENAI_FORCE_CHAT_COMPLETIONS',
    'OCR_PROVIDER', 'OCR_ENGINE',
    'ENABLE_OPENAI_OCR', 'OCR_ENABLE_OPENAI',
    'ENABLE_TENCENT_OCR', 'OCR_ENABLE_TENCENT',
    'ENABLE_WECHAT_OPENAPI_OCR', 'OCR_ENABLE_WECHAT_OPENAPI',
    'ENABLE_BUILTIN_OCR', 'OCR_ENABLE_BUILTIN',
    'TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRETID',
    'TENCENTCLOUD_SECRET_KEY', 'TENCENTCLOUD_SECRETKEY',
    'OCR_SECRET_ID', 'OCR_SECRET_KEY'
  ].filter((name) => !!process.env[name])

  let sdkVersion = null
  let hasResponses = null
  try {
    sdkVersion = require('openai/package.json').version
  } catch (e) {
    sdkVersion = `load failed: ${e.message}`
  }
  try {
    const openaiSdk = require('openai')
    const Cls = openaiSdk.AzureOpenAI || openaiSdk.OpenAI || openaiSdk.default
    if (Cls) {
      const tmp = new Cls({ apiKey: 'x', endpoint: 'https://x.openai.azure.com', apiVersion: '2025-04-01-preview', deployment: 'x' })
      hasResponses = !!(tmp.responses && typeof tmp.responses.create === 'function')
    }
  } catch (e) {
    hasResponses = `probe failed: ${e.message}`
  }

  return {
    ok: true,
    diagnose: true,
    nodeVersion: process.version,
    openaiSdkVersion: sdkVersion,
    sdkSupportsResponses: hasResponses,
    azureDetected: isAzureOpenAi(),
    openaiOcrEnabled: isOpenAiOcrEnabled(),
    openaiKeyPresent: !!getOpenAiApiKey(),
    azureEndpoint: getAzureOpenAiEndpoint() || null,
    azureDeployment: getAzureOpenAiDeployment(),
    azureApiVersion: getAzureOpenAiApiVersion(),
    model: getOpenAiModel(),
    forceChatCompletions: shouldUseChatCompletions(),
    tencentOcrEnabled: isTencentOcrEnabled(),
    wechatOpenapiOcrEnabled: isWechatOpenapiOcrEnabled(),
    builtinOcrEnabled: isBuiltinOcrFallbackEnabled(),
    providerMode: getOcrProviderMode(),
    envVarsPresent: presentEnv
  }
}

async function recognizeRegisterText(event = {}) {
  if (event && event.mockRawText) {
    return {
      source: 'mock-event',
      rawText: String(event.mockRawText)
    }
  }

  if (!event.imageFileID) {
    throw createError('MISSING_IMAGE_FILE_ID', '缺少 imageFileID，无法发起 OCR 识别')
  }

  let providerWarning = ''
  const providerMode = getOcrProviderMode()

  if (providerMode === 'openai') {
    const result = await recognizeWithOpenAiOcr(event.imageFileID)
    return {
      source: 'openai-vision-ocr',
      rawText: result.rawText,
      drafts: result.drafts
    }
  }

  if (providerMode === 'tencent') {
    return recognizeWithTencentOcr(event.imageFileID)
  }

  if (providerMode === 'wechat') {
    const rawText = await recognizeWithWechatOpenapiOcr(event.imageFileID)
    return {
      source: 'wechat-openapi-printed-text-ocr',
      rawText
    }
  }

  if (isOpenAiOcrEnabled() && getOpenAiApiKey()) {
    try {
      const result = await recognizeWithOpenAiOcr(event.imageFileID)
      return {
        source: 'openai-vision-ocr',
        rawText: result.rawText,
        drafts: result.drafts
      }
    } catch (error) {
      providerWarning = error.message || ''
      console.warn('OpenAI OCR failed, fallback to Tencent OCR', {
        code: error.code,
        message: error.message
      })
    }
  } else if (isOpenAiOcrEnabled()) {
    providerWarning = 'OpenAI API Key 未配置，自动改试腾讯云 OCR'
  }

  if (isTencentOcrEnabled()) {
    try {
      const recognition = await recognizeWithTencentOcr(event.imageFileID)
      return Object.assign({}, recognition, {
        providerWarning
      })
    } catch (error) {
      providerWarning = error.message || providerWarning

      if (isWechatOpenapiOcrEnabled()) {
        try {
          const rawText = await recognizeWithWechatOpenapiOcr(event.imageFileID)
          return {
            source: 'wechat-openapi-printed-text-ocr',
            rawText,
            providerWarning
          }
        } catch (wechatError) {
          console.warn('WeChat OpenAPI OCR failed after Tencent OCR failure', {
            code: wechatError.code,
            message: wechatError.message
          })
        }
      }

      if (!isBuiltinOcrFallbackEnabled() || !shouldFallbackToBuiltinOcr(error)) {
        throw error
      }

      console.warn('Tencent OCR failed, fallback to builtin OCR', {
        code: error.code,
        message: error.message,
        requestId: error.requestId || ''
      })
    }
  } else {
    if (!isBuiltinOcrFallbackEnabled()) {
      throw createError(
        'OCR_PROVIDER_DISABLED',
        '腾讯云 OCR 已关闭，且内置 OCR 默认禁用，无法识别登记本'
      )
    }

    providerWarning = '腾讯云 OCR 未启用，直接使用云函数内置 OCR'
  }

  const rawText = await recognizeWithBuiltinOcr(event.imageFileID)
  return {
    source: 'builtin-ocr-tesseract',
    rawText,
    providerWarning
  }
}

async function recognizeWithOpenAiOcr(imageFileID) {
  const apiKey = getOpenAiApiKey()
  if (!apiKey) {
    throw createError(
      'OPENAI_API_KEY_MISSING',
      'OpenAI OCR 已启用，但云函数环境变量里没有配置 OPENAI_API_KEY'
    )
  }

  const imageBuffer = await downloadImageBuffer(imageFileID)
  const dataUrl = `data:${detectImageMimeType(imageBuffer)};base64,${imageBuffer.toString('base64')}`

  const systemInstructions = [
    '你是一个中文小学生作业登记本智能识别引擎。',
    '任务：从作业登记本照片里识别每一条作业，返回严格 JSON。',
    '只输出 JSON 对象本身，不要解释、不要 Markdown、不要 ```。'
  ].join('\n')

  const userPromptText = [
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
    '    仍受规则 10「不编造」约束：字迹完全看不出原文时不要强行套黑名单。',
    '15. 条与条之间字符不越界。每个编号 N 的文字独立成段，第 N 条末字 / 第 N+1 条首字不能互挪。看到两条相邻条目的首尾字"恰好"能拼成一个常见词（如"+单词"、"+园地词" 紧邻 "日积月累"）时，**优先按编号断开**，宁可两条都按原文保留，也不要拼一个"看着顺"的词而把整条吞掉。',
    '    - 反例（sample6 英语）："1.背19课文+单词 2.完成研学单 3.改百词" 曾被错并成 [背19课文懂背, 改百词, 听默单词字母] —— 第 2 条整条丢失。',
    '    - 反例（sample5 语文）："1.抄书本(ABB6个,ABAB6个+园地词) 2.背园地日积月累" 曾被错并成 [抄本(ABB式,ABAB式)+日积月累] —— 第 2 条整条丢失。',
    '    - 自检：识别完按编号回数一遍，如果某科目栏图里能数到 N 个编号但只输出了 N-1 条，必须回看哪一条被吞了，按原图补齐。',
    '16. 加号 "+" 容易因笔画干扰漏识。"课文懂" / "课文背" / "课文懂背" 这种英语栏残词几乎都是 "课文+单词" 的 + 号误识，按 "+单词" 还原（rawText 保留原样）。同理 "ABB式" / "ABAB式" 这种"式"字孤立出现在语文抄写类内容里时，大概率是 "N个"（如 "ABB6个"）的数字+量词被错读，请按图核对数量。',
    '17. 数字 / 数量 / 页码必须逐位精确读，禁止凭印象或上下文外推：',
    '    - 量词（N 个 / N 题 / N 段 / N 遍 / N 页 / N 字内）：N 必须严格按图读，不可丢数字（"6个" 不可写成 "式"），也不可换算成其它量词。',
    '    - 起止页 / 单元号 / 课号：两位以上数字逐位核对（十位、个位）。"P53~P54" 不可识成 "P63-64"，"5单元" 不可识成 "16单元"，"200字内" 不可识成 "300字内"。前后条目的页码不可作为本条的参考。'
  ].join('\n')

  const response = await callOpenAiVision(apiKey, {
    model: getOpenAiModel(),
    systemInstructions,
    userPromptText,
    imageDataUrl: dataUrl
  })

  return extractOpenAiStructuredResult(response)
}

async function recognizeWithWechatOpenapiOcr(imageFileID) {
  if (!cloud || !cloud.openapi || !cloud.openapi.ocr || !cloud.openapi.ocr.printedText) {
    throw createError('WECHAT_OPENAPI_OCR_MISSING', '当前 wx-server-sdk 不支持 openapi.ocr.printedText')
  }

  const tempUrl = await getTempFileUrl(imageFileID)
  if (!tempUrl) {
    throw createError('WECHAT_OPENAPI_IMAGE_URL_MISSING', '无法获取微信 OCR 可访问的图片临时链接')
  }

  try {
    const response = await cloud.openapi.ocr.printedText({
      type: 'photo',
      imgUrl: tempUrl
    })
    return extractWechatOpenapiText(response)
  } catch (error) {
    throw createError(
      normalizeWechatOpenapiErrorCode(error),
      `微信云调用 OCR 失败：${(error && (error.errMsg || error.message)) || 'unknown error'}`
    )
  }
}

async function recognizeWithTencentOcr(imageFileID) {
  const client = createOcrClient()
  // 作业登记本场景以手写为主,把 GeneralHandwritingOCR 排在第一;
  // GeneralAccurateOCR / GeneralBasicOCR 作为印刷体兜底。
  // 注意:这里只要某一个 provider 返回非空 rawText 就停,所以顺序很关键 ——
  // 误把印刷体放第一会先把表头/页码抓回来直接返回,手写部分被忽略。
  const providers = [
    {
      source: 'tencent-cloud-general-handwriting-ocr',
      action: 'GeneralHandwritingOCR',
      options: {}
    },
    {
      source: 'tencent-cloud-general-accurate-ocr',
      action: 'GeneralAccurateOCR',
      options: {
        EnableDetectSplit: true,
        ConfigID: 'OCR'
      }
    },
    {
      source: 'tencent-cloud-general-basic-ocr',
      action: 'GeneralBasicOCR',
      options: {
        LanguageType: 'zh_rare'
      }
    }
  ]
  let lastError = null

  for (const provider of providers) {
    try {
      const rawText = await callTencentOcrProvider(client, provider, imageFileID)
      return {
        source: provider.source,
        rawText
      }
    } catch (error) {
      lastError = error
      console.warn('Tencent OCR provider failed', {
        action: provider.action,
        code: error.code,
        message: error.message,
        requestId: error.requestId || ''
      })
    }
  }

  throw lastError || createError('OCR_API_FAILED', '腾讯云 OCR 调用失败')
}

async function callTencentOcrProvider(client, provider, imageFileID) {
  const primaryRequest = await buildOcrRequest(imageFileID, provider.options)

  try {
    const response = await client[provider.action](primaryRequest)
    return extractRawText(response)
  } catch (error) {
    if (!primaryRequest.ImageUrl) {
      throw wrapOcrError(error)
    }

    const fallbackRequest = await buildOcrRequest(imageFileID, Object.assign(
      {},
      provider.options,
      { forceBase64: true }
    ))
    delete fallbackRequest.ImageUrl

    try {
      const response = await client[provider.action](fallbackRequest)
      return extractRawText(response)
    } catch (fallbackError) {
      throw wrapOcrError(fallbackError)
    }
  }
}

async function recognizeWithBuiltinOcr(imageFileID) {
  const tesseract = loadTesseract()
  if (!tesseract.createWorker) {
    throw createError(
      'TESSERACT_SDK_MISSING',
      '缺少 tesseract.js 依赖，请先安装并重新部署云函数'
    )
  }

  const imageBuffer = await downloadImageBuffer(imageFileID)
  const worker = await getTesseractWorker()

  try {
    const response = await worker.recognize(imageBuffer)
    const rawText = normalizeRecognizedText(response && response.data && response.data.text)

    if (!rawText) {
      throw createError('OCR_EMPTY_RESULT', 'OCR 已调用成功，但没有识别出可用文本')
    }

    return rawText
  } catch (error) {
    if (error && error.code) {
      throw error
    }

    throw createError(
      'BUILTIN_OCR_FAILED',
      `内置 OCR 调用失败：${(error && error.message) || 'unknown error'}`
    )
  }
}

async function getTesseractWorker() {
  if (!tesseractWorkerPromise) {
    const tesseract = loadTesseract()
    if (!tesseract.builtinLangData || !tesseract.builtinLangData.langPath) {
      throw createError(
        'TESSERACT_LANGDATA_MISSING',
        '缺少中文识别语言包，请重新安装云函数依赖并部署'
      )
    }

    tesseractWorkerPromise = tesseract.createWorker(tesseract.builtinLangData.code, 1, {
      langPath: `${tesseract.builtinLangData.langPath}/`,
      gzip: tesseract.builtinLangData.gzip
    }).catch((error) => {
      tesseractWorkerPromise = null
      throw error
    })
  }

  return tesseractWorkerPromise
}

function createOcrClient() {
  const Client = loadTencentOcrClient()
  if (!Client) {
    throw createError(
      'OCR_SDK_MISSING',
      '缺少 tencentcloud-sdk-nodejs-ocr 依赖，请先安装并重新部署云函数'
    )
  }

  const clientConfig = {
    region: getFirstEnv(['OCR_REGION', 'TENCENTCLOUD_REGION']) || 'ap-guangzhou',
    profile: {
      httpProfile: {
        endpoint: 'ocr.tencentcloudapi.com',
        reqTimeout: 15
      }
    }
  }

  const credential = getCredential()
  if (credential) {
    clientConfig.credential = credential
  }

  return new Client(clientConfig)
}

function loadTencentOcrClient() {
  if (hasLoadedOcrSdk) {
    return OcrClient
  }

  hasLoadedOcrSdk = true
  try {
    const sdk = require('tencentcloud-sdk-nodejs-ocr')
    OcrClient = sdk.ocr.v20181119.Client
  } catch (error) {
    OcrClient = null
  }

  return OcrClient
}

function loadTesseract() {
  if (hasLoadedTesseract) {
    return {
      createWorker,
      builtinLangData
    }
  }

  hasLoadedTesseract = true
  try {
    const tesseract = require('tesseract.js')
    createWorker = tesseract.createWorker
  } catch (error) {
    createWorker = null
  }

  try {
    builtinLangData = require('@tesseract.js-data/chi_sim')
  } catch (error) {
    builtinLangData = null
  }

  return {
    createWorker,
    builtinLangData
  }
}

async function callOpenAiVision(apiKey, options) {
  // 走官方 openai SDK,自动处理 OpenAI / Azure 的 URL/header/auth 差异。
  // 默认使用 Responses API(Azure 上是 /openai/responses,新模型如 gpt-5.x 系列只走这个);
  // 老的 Chat Completions 路径(/chat/completions 或 Azure 的 /openai/deployments/{dep}/chat/completions)
  // 仍然保留,用 OPENAI_USE_CHAT_COMPLETIONS=true 可强制切回。
  const client = getOpenAiClient(apiKey)

  if (shouldUseChatCompletions()) {
    return callOpenAiChatCompletion(client, options)
  }

  try {
    return await callOpenAiResponses(client, options)
  } catch (error) {
    // Responses API 在某些 Azure 部署上可能不可用 ——
    // 命中 404 / model_not_found 时自动退回 Chat Completions,避免硬失败。
    if (isResponsesEndpointUnavailable(error)) {
      console.warn('Responses API not available, falling back to Chat Completions', {
        code: error && error.code,
        status: error && error.status,
        message: error && error.message
      })
      return callOpenAiChatCompletion(client, options)
    }
    const code = normalizeOpenAiErrorCode(error)
    const detail = error && error.message ? error.message : 'unknown error'
    throw createError(code, `OpenAI OCR 调用失败(Responses)：${detail}`)
  }
}

async function callOpenAiResponses(client, options) {
  if (!client.responses || typeof client.responses.create !== 'function') {
    const fallbackError = new Error('当前 openai SDK 不支持 Responses API,请升级到 4.55+')
    fallbackError.code = 'OPENAI_SDK_NO_RESPONSES'
    throw fallbackError
  }

  const reasoning = isReasoningModel(options.model)

  const payload = {
    model: options.model,
    // 推理模型的 max_output_tokens 同时计推理 token,默认 2400 在 gpt-5 下不够,
    // 把推理预算单独放宽到 8000,避免在云端被截断/超时。
    max_output_tokens: reasoning ? getOpenAiReasoningMaxTokens() : getOpenAiMaxTokens(),
    text: { format: { type: 'json_object' } },
    input: [
      {
        role: 'system',
        content: [{ type: 'input_text', text: options.systemInstructions }]
      },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: options.userPromptText },
          { type: 'input_image', image_url: options.imageDataUrl, detail: 'high' }
        ]
      }
    ]
  }

  if (reasoning) {
    // 见文件顶部 DEFAULT_OPENAI_MODEL / DEFAULT_REASONING_EFFORT 注释,
    // 两者必须配对(不同模型支持的 effort 值不一致)。
    payload.reasoning = { effort: getOpenAiReasoningEffort() }
  } else {
    // 非推理模型让识别尽量确定。
    payload.temperature = 0
  }

  return await client.responses.create(payload)
}

async function callOpenAiChatCompletion(client, options) {
  const payload = {
    model: options.model,
    max_tokens: getOpenAiMaxTokens(),
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: options.systemInstructions
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: options.userPromptText },
          { type: 'image_url', image_url: { url: options.imageDataUrl, detail: 'high' } }
        ]
      }
    ]
  }

  if (!isReasoningModel(options.model)) {
    payload.temperature = 0
  }

  try {
    return await client.chat.completions.create(payload)
  } catch (error) {
    const code = normalizeOpenAiErrorCode(error)
    const detail = error && error.message ? error.message : 'unknown error'
    throw createError(code, `OpenAI OCR 调用失败(ChatCompletions)：${detail}`)
  }
}

function shouldUseChatCompletions() {
  const flag = String(getFirstEnv(['OPENAI_USE_CHAT_COMPLETIONS', 'OPENAI_FORCE_CHAT_COMPLETIONS']) || '').toLowerCase()
  return flag === 'true' || flag === '1' || flag === 'yes'
}

function isReasoningModel(model) {
  const name = String(model || '').toLowerCase()
  // o1/o3/o4 reasoning 系列,以及 gpt-5 系列(目前 gpt-5.x 表现像 reasoning model,
  // 默认 temperature 必须为 1,否则 Azure / OpenAI 都会拒)。
  return /^o\d/.test(name) || /^gpt-5/.test(name)
}

function isResponsesEndpointUnavailable(error) {
  if (!error) return false
  // SDK 太老,完全没暴露 client.responses ——这种情况也走 chat completions 兜底
  // (4.77 之前的 openai SDK 没有 Responses API)。
  if (error.code === 'OPENAI_SDK_NO_RESPONSES') return true
  const status = Number(error.status || (error.response && error.response.status) || 0)
  if (status === 404) return true
  const code = String(error.code || '').toLowerCase()
  if (code === 'model_not_found' || code === 'unknown_endpoint') return true
  const message = String(error.message || '').toLowerCase()
  if (message.includes('not found') && message.includes('responses')) return true
  // Azure 在 api-version 太老时报 400 + "Responses API is enabled only for api-version ..."
  // 这种情况下 Chat Completions 仍然能跑,落过去。
  if (status === 400 && message.includes('responses api') && message.includes('api-version')) return true
  return false
}

function loadOpenAiSdk() {
  if (hasLoadedOpenAiSdk) {
    return { OpenAi: OpenAiSdk, AzureOpenAi: AzureOpenAiSdk }
  }
  hasLoadedOpenAiSdk = true
  try {
    const sdk = require('openai')
    OpenAiSdk = sdk.OpenAI || sdk.default
    AzureOpenAiSdk = sdk.AzureOpenAI
  } catch (error) {
    OpenAiSdk = null
    AzureOpenAiSdk = null
  }
  return { OpenAi: OpenAiSdk, AzureOpenAi: AzureOpenAiSdk }
}

function getOpenAiClient(apiKey) {
  if (openAiClientCache) {
    return openAiClientCache
  }

  const { OpenAi, AzureOpenAi } = loadOpenAiSdk()

  if (isAzureOpenAi()) {
    if (!AzureOpenAi) {
      throw createError(
        'OPENAI_SDK_MISSING',
        '缺少 openai SDK 依赖(Azure 路径需要 AzureOpenAI),请先安装并重新部署云函数'
      )
    }
    const endpoint = getAzureOpenAiEndpoint()
    if (!endpoint) {
      throw createError(
        'AZURE_OPENAI_ENDPOINT_MISSING',
        'Azure OpenAI 已启用但未配置 AZURE_OPENAI_ENDPOINT'
      )
    }
    openAiClientCache = new AzureOpenAi({
      apiKey,
      endpoint,
      apiVersion: getAzureOpenAiApiVersion(),
      deployment: getAzureOpenAiDeployment(),
      timeout: getOpenAiTimeoutMs(),
      // 不让 SDK 自动重试 —— 默认 maxRetries=2,会把单次 timeout 放大到 3 倍,
      // 最坏撑爆 SCF 120s(本次线上即 45s 砍断+重试 ≈ 66.9s)。OCR 慢基本是
      // 模型推理慢而非网络抖动,重试也是慢,不如一次给足 timeout。
      maxRetries: 0
    })
  } else {
    if (!OpenAi) {
      throw createError(
        'OPENAI_SDK_MISSING',
        '缺少 openai SDK 依赖,请先安装并重新部署云函数'
      )
    }
    openAiClientCache = new OpenAi({
      apiKey,
      baseURL: getOpenAiBaseUrl(),
      timeout: getOpenAiTimeoutMs(),
      // 见 Azure 分支的 maxRetries 注释:关掉自动重试,避免重试累加撑爆 SCF。
      maxRetries: 0
    })
  }

  return openAiClientCache
}

function isAzureOpenAi() {
  const apiType = String(getFirstEnv(['OPENAI_API_TYPE']) || '').toLowerCase()
  if (apiType === 'azure') return true
  if (apiType === 'openai') return false
  // 没显式声明时,根据 endpoint 自动判断
  if (getFirstEnv(['AZURE_OPENAI_ENDPOINT'])) return true
  const baseUrl = String(getFirstEnv(['OPENAI_BASE_URL', 'OPENAI_API_BASE_URL']) || '')
  return baseUrl.toLowerCase().includes('azure.com')
}

function getAzureOpenAiEndpoint() {
  // Azure 端点格式:https://{resource}.openai.azure.com (不带 /openai 路径)
  const raw = getFirstEnv(['AZURE_OPENAI_ENDPOINT', 'OPENAI_BASE_URL', 'OPENAI_API_BASE_URL']) || ''
  // 兼容用户把完整路径填进来的情况(如 ".../openai" 或 ".../v1"),裁掉冗余尾巴
  return raw
    .replace(/\/+$/, '')
    .replace(/\/(openai|v1)$/i, '')
}

function getAzureOpenAiDeployment() {
  // Azure 的 deployment 名是用户在 Azure portal 自己定的,通常和模型同名(如 gpt-4o)。
  // 优先读专属变量,fallback 到 OPENAI_OCR_MODEL/OPENAI_MODEL。
  return (
    getFirstEnv(['AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_DEPLOYMENT_NAME', 'OPENAI_OCR_MODEL', 'OPENAI_MODEL']) ||
    DEFAULT_OPENAI_MODEL
  )
}

function getAzureOpenAiApiVersion() {
  // Responses API 在 Azure 上需要 >= 2025-03-01-preview。用户配的若太老,强制用一个安全的版本,
  // 不然 Responses 直接 400 "Responses API is enabled only for api-version 2025-03-01-preview and later"。
  const FLOOR = '2025-03-01'
  const SAFE_DEFAULT = '2025-04-01-preview'
  const userVer = getFirstEnv(['AZURE_OPENAI_API_VERSION'])
  if (!userVer) return SAFE_DEFAULT
  // 字符串比较对 ISO 日期前缀有效("2024-12" < "2025-03")。
  if (String(userVer).slice(0, 7) < FLOOR.slice(0, 7)) {
    console.warn('AZURE_OPENAI_API_VERSION too old for Responses API, overriding', {
      configured: userVer,
      using: SAFE_DEFAULT
    })
    return SAFE_DEFAULT
  }
  return userVer
}

function postJson(urlString, headers, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString)
    const transport = url.protocol === 'http:' ? http : https
    const requestBody = JSON.stringify(payload)
    const request = transport.request({
      method: 'POST',
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      headers: Object.assign({}, headers, {
        'Content-Length': Buffer.byteLength(requestBody)
      }),
      timeout: timeoutMs
    }, (response) => {
      let responseBody = ''

      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        responseBody += chunk
      })
      response.on('end', () => {
        const parsed = parseJsonResponse(responseBody)

        if (response.statusCode < 200 || response.statusCode >= 300) {
          const message = extractProviderErrorMessage(parsed) || responseBody || `HTTP ${response.statusCode}`
          const error = new Error(message)
          error.statusCode = response.statusCode
          error.providerResponse = parsed
          reject(error)
          return
        }

        resolve(parsed)
      })
    })

    request.on('timeout', () => {
      request.destroy(createError('OPENAI_OCR_TIMEOUT', `OpenAI 请求超过 ${Math.round(timeoutMs / 1000)} 秒`))
    })
    request.on('error', reject)
    request.write(requestBody)
    request.end()
  })
}

function parseJsonResponse(responseBody) {
  try {
    return JSON.parse(responseBody || '{}')
  } catch (error) {
    return {}
  }
}

function extractProviderErrorMessage(response) {
  return response && response.error && (response.error.message || response.error.code)
}

function getCredential() {
  // 优先用用户显式配置的 OCR_* 凭据(独立子用户的永久 AKSK)。
  // 关键:这里不能再 fallback 去读 TENCENTCLOUD_SESSIONTOKEN —— 它是
  // 腾讯云 SCF 自动注入的"云函数运行角色"的临时 session token,和子
  // 用户的永久 AKSK 不属于同一身份;若把两者拼起来,腾讯云会报
  // AuthFailure.TokenFailure。
  if (process.env.OCR_SECRET_ID && process.env.OCR_SECRET_KEY) {
    const credential = {
      secretId: process.env.OCR_SECRET_ID,
      secretKey: process.env.OCR_SECRET_KEY
    }
    if (process.env.OCR_TOKEN) {
      credential.token = process.env.OCR_TOKEN
    }
    return credential
  }

  // 否则回退到 SCF 运行角色自动注入的 TENCENTCLOUD_* 凭据,这套是配套的
  // (SecretId / SecretKey / SessionToken 同源),可以一起用。
  const secretId = getFirstEnv(['TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRETID'])
  const secretKey = getFirstEnv(['TENCENTCLOUD_SECRET_KEY', 'TENCENTCLOUD_SECRETKEY'])
  const token = getFirstEnv(['TENCENTCLOUD_TOKEN', 'TENCENTCLOUD_SESSIONTOKEN'])

  if (!secretId || !secretKey) {
    return null
  }

  const credential = { secretId, secretKey }
  if (token) {
    credential.token = token
  }

  return credential
}

async function buildOcrRequest(imageFileID, options = {}) {
  const useBase64 = Boolean(options.forceBase64)
  const request = Object.assign({}, options)
  delete request.forceBase64

  if (!useBase64) {
    const tempUrl = await getTempFileUrl(imageFileID)
    if (tempUrl) {
      request.ImageUrl = tempUrl
      return request
    }
  }

  const imageBuffer = await downloadImageBuffer(imageFileID)
  request.ImageBase64 = imageBuffer.toString('base64')
  return request
}

async function getTempFileUrl(imageFileID) {
  if (!cloud) {
    return ''
  }

  try {
    const response = await cloud.getTempFileURL({ fileList: [imageFileID] })
    const fileInfo = response && response.fileList && response.fileList[0]
    return (fileInfo && fileInfo.tempFileURL) || ''
  } catch (error) {
    console.warn('getTempFileURL failed, fallback to base64', {
      code: error && error.code,
      message: error && error.message
    })
    return ''
  }
}

async function downloadImageBuffer(imageFileID) {
  if (!cloud) {
    throw createError('CLOUD_SDK_MISSING', '云函数环境未加载 wx-server-sdk，无法下载图片')
  }

  try {
    const response = await cloud.downloadFile({ fileID: imageFileID })
    const fileContent = response && response.fileContent
    if (!fileContent) {
      throw new Error('downloadFile 返回空内容')
    }

    return Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent)
  } catch (error) {
    throw createError(
      'DOWNLOAD_FILE_FAILED',
      `无法从云存储读取图片：${error.message || 'downloadFile failed'}`
    )
  }
}

function extractRawText(response) {
  const lines = ((response && response.TextDetections) || [])
    .map((item) => String(item && item.DetectedText ? item.DetectedText : '').trim())
    .filter(Boolean)

  const rawText = lines.join('\n').trim()
  if (!rawText) {
    throw createError('OCR_EMPTY_RESULT', 'OCR 已调用成功，但没有识别出可用文本')
  }

  return rawText
}

function extractOpenAiStructuredResult(response) {
  // 同时兼容 Responses API 和 Chat Completions 的返回结构 ——
  // - Responses:        response.output_text 或 response.output[].content[].text
  // - ChatCompletions:  response.choices[0].message.content (string 或 [{type, text}] 数组)
  const textContent = extractOpenAiTextContent(response)

  if (!textContent.trim()) {
    throw createError('OCR_EMPTY_RESULT', 'OpenAI OCR 已调用成功，但没有返回内容')
  }

  // 尝试 JSON 解析(json_object 模式应该总是 JSON)。失败时退化为旧版纯文本路径,
  // 让 main() 用 parseHomeworkRegister 兜底。
  let parsed = null
  try {
    parsed = JSON.parse(textContent)
  } catch (error) {
    const fallbackRawText = normalizeRecognizedText(textContent)
    if (!fallbackRawText) {
      throw createError('OCR_EMPTY_RESULT', 'OpenAI OCR 返回内容无法解析为 JSON')
    }
    return { rawText: fallbackRawText }
  }

  const rawText = normalizeRecognizedText(String(parsed && parsed.rawText ? parsed.rawText : ''))
  const draftsInput = (parsed && Array.isArray(parsed.drafts)) ? parsed.drafts : []
  const drafts = draftsInput
    .map(normalizeOpenAiDraft)
    .filter((draft) => draft && draft.content)

  if (!rawText && drafts.length === 0) {
    throw createError('OCR_EMPTY_RESULT', 'OpenAI OCR 已调用成功，但没有识别出可用内容')
  }

  // rawText 兜底:模型有时只给 drafts 不给 rawText,把 drafts 拼起来作为 rawText。
  const effectiveRawText = rawText || drafts.map((draft) => draft.rawText || draft.content).join('\n')

  return { rawText: effectiveRawText, drafts }
}

function extractOpenAiTextContent(response) {
  if (!response) return ''

  // Responses API: SDK 把 output 的所有 text 拼到 output_text 字段(便利字段)。
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text
  }

  // Responses API 原始结构:output 是一个数组,里头是 message / reasoning / function_call 等条目;
  // 每个 message 的 content 又是一个数组,里头有 output_text / refusal 等。
  if (Array.isArray(response.output)) {
    const collected = []
    for (const item of response.output) {
      if (!item) continue
      if (Array.isArray(item.content)) {
        for (const piece of item.content) {
          if (!piece) continue
          if (typeof piece === 'string') {
            collected.push(piece)
          } else if (piece.type === 'output_text' || piece.type === 'text') {
            if (typeof piece.text === 'string') collected.push(piece.text)
          }
        }
      } else if (typeof item.text === 'string') {
        collected.push(item.text)
      }
    }
    if (collected.length > 0) return collected.join('')
  }

  // Chat Completions:choices[0].message.content
  const message = response.choices && response.choices[0] && response.choices[0].message
  const content = message && message.content
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item) return ''
        if (typeof item === 'string') return item
        return item.text || ''
      })
      .filter(Boolean)
      .join('')
  }
  return String(content || '')
}

function normalizeOpenAiDraft(draft, index) {
  if (!draft || typeof draft !== 'object') {
    return null
  }
  const subject = String(draft.subject || '').trim()
  const content = String(draft.content || '').trim()
  if (!content) {
    return null
  }
  const rawTextPart = String(draft.rawText || content).trim()
  const confidence = ['高', '中', '低'].includes(draft.confidence)
    ? draft.confidence
    : (subject ? '中' : '低')
  const needsConfirm = typeof draft.needsConfirm === 'boolean'
    ? draft.needsConfirm
    : !subject
  return {
    id: `draft-${Date.now()}-${index}`,
    subject,
    content,
    rawText: rawTextPart,
    confidence,
    needsConfirm
  }
}

function extractWechatOpenapiText(response) {
  const lines = ((response && response.items) || [])
    .map((item) => String(item && item.text ? item.text : '').trim())
    .filter(Boolean)

  const rawText = normalizeRecognizedText(lines.join('\n'))
  if (!rawText) {
    throw createError('OCR_EMPTY_RESULT', '微信云调用 OCR 已调用成功，但没有识别出可用文本')
  }

  return rawText
}

function normalizeRecognizedText(rawText) {
  let normalized = String(rawText || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  let previous = ''
  while (previous !== normalized) {
    previous = normalized
    normalized = normalized.replace(/([一-龥])\s+(?=[一-龥])/g, '$1')
  }

  return normalized
}

function shouldFallbackToBuiltinOcr(error) {
  if (!cloud) {
    return false
  }

  const code = String((error && error.code) || '')
  const message = String((error && error.message) || '').toLowerCase()

  if (code === 'MISSING_IMAGE_FILE_ID' || code === 'DOWNLOAD_FILE_FAILED') {
    return false
  }

  if (
    code === 'OCR_SDK_MISSING' ||
    code === 'OCR_CREDENTIALS_MISSING' ||
    code === 'OCR_PERMISSION_DENIED' ||
    code === 'OCR_RATE_LIMITED' ||
    code === 'OCR_EMPTY_RESULT' ||
    code === 'OCR_API_FAILED'
  ) {
    return true
  }

  return (
    message.includes('not authorized') ||
    message.includes('no permission') ||
    message.includes('access key') ||
    message.includes('secretid') ||
    message.includes('secretkey') ||
    message.includes('credential') ||
    message.includes('ocr:generalaccurateocr') ||
    message.includes('ocr:generalbasicocr')
  )
}

function isOpenAiOcrEnabled() {
  const flag = String(getFirstEnv(['ENABLE_OPENAI_OCR', 'OCR_ENABLE_OPENAI'])).toLowerCase()
  if (!flag) {
    return true
  }

  return flag === '1' || flag === 'true' || flag === 'yes'
}

function isTencentOcrEnabled() {
  const flag = String(getFirstEnv(['ENABLE_TENCENT_OCR', 'OCR_ENABLE_TENCENT'])).toLowerCase()
  if (!flag) {
    return true
  }

  return flag === '1' || flag === 'true' || flag === 'yes'
}

function isWechatOpenapiOcrEnabled() {
  const flag = String(getFirstEnv(['ENABLE_WECHAT_OPENAPI_OCR', 'OCR_ENABLE_WECHAT_OPENAPI'])).toLowerCase()
  if (!flag) {
    return true
  }

  return flag === '1' || flag === 'true' || flag === 'yes'
}

function isBuiltinOcrFallbackEnabled() {
  const flag = String(getFirstEnv(['ENABLE_BUILTIN_OCR', 'OCR_ENABLE_BUILTIN'])).toLowerCase()
  if (!flag) {
    return false
  }

  return flag === '1' || flag === 'true' || flag === 'yes'
}

function getOcrProviderMode() {
  const provider = String(getFirstEnv(['OCR_PROVIDER', 'OCR_ENGINE'])).toLowerCase()
  if (provider === 'openai' || provider === 'tencent' || provider === 'wechat') {
    return provider
  }

  return 'auto'
}

function getOpenAiApiKey() {
  // 同时接受 Azure 命名(AZURE_OPENAI_API_KEY/AZURE_API_KEY)和官方命名(OPENAI_API_KEY)。
  return getFirstEnv(['OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'AZURE_API_KEY', 'OPENAI_KEY'])
}

function getOpenAiModel() {
  return getFirstEnv(['OPENAI_OCR_MODEL', 'OPENAI_MODEL']) || DEFAULT_OPENAI_MODEL
}

function getOpenAiBaseUrl() {
  const baseUrl = getFirstEnv(['OPENAI_BASE_URL', 'OPENAI_API_BASE_URL']) || DEFAULT_OPENAI_BASE_URL
  return baseUrl.replace(/\/+$/, '')
}

function getOpenAiMaxTokens() {
  // 结构化 JSON 输出比纯文本长(每条 draft 含 5 个字段),原默认 1200 不够。
  const maxTokens = Number(getFirstEnv(['OPENAI_OCR_MAX_TOKENS']))
  return Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 2400
}

function getOpenAiReasoningMaxTokens() {
  // 推理模型(gpt-5/o-series)的 max_output_tokens 同时计 reasoning tokens,
  // 比非推理模型需要更多 budget,否则 status 会卡在 "incomplete"。
  const maxTokens = Number(getFirstEnv(['OPENAI_OCR_REASONING_MAX_TOKENS']))
  return Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 8000
}

function getOpenAiReasoningEffort() {
  const SUPPORTED = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
  const eff = String(getFirstEnv(['OPENAI_REASONING_EFFORT', 'OPENAI_OCR_REASONING_EFFORT']) || '').toLowerCase()
  if (SUPPORTED.includes(eff)) return eff
  return DEFAULT_REASONING_EFFORT
}

function getOpenAiTimeoutMs() {
  const timeoutMs = Number(getFirstEnv(['OPENAI_OCR_TIMEOUT_MS']))
  // 默认 100s。SCF timeout 是 120s,这里给单次 OpenAI 调用足够时间一次跑完。
  // 旧默认 45s 太短 —— gpt-5.5 + reasoning 在信息量大的登记本上常跑 50~65s,
  // 45s 会被 SDK 砍断并自动重试(见 getOpenAiClient 的 maxRetries),把总耗时
  // 累加到逼近甚至超过 SCF 120s;云函数一旦被杀,persistJobResult 来不及把结果
  // 写进 ocr_jobs,客户端轮询就永远等不到 done。100s + maxRetries:0 → 最坏单次
  // 100s,留 ~20s 给图片下载/解析/写库,稳定落在 120s 内。
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 100000
}

function detectImageMimeType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return 'image/jpeg'
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return 'image/jpeg'
  }
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png'
  }
  if (
    buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
    buffer.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }

  return 'image/jpeg'
}

function normalizeOpenAiErrorCode(error) {
  if (error && error.code === 'OPENAI_OCR_TIMEOUT') {
    return error.code
  }

  const statusCode = Number(error && error.statusCode)
  const message = String((error && error.message) || '').toLowerCase()

  if (statusCode === 401 || statusCode === 403 || message.includes('api key')) {
    return 'OPENAI_AUTH_FAILED'
  }
  if (statusCode === 429 || message.includes('rate limit') || message.includes('quota')) {
    return 'OPENAI_RATE_LIMITED'
  }
  if (message.includes('timeout') || message.includes('timed out')) {
    return 'OPENAI_OCR_TIMEOUT'
  }
  if (
    message.includes('enotfound') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('socket hang up')
  ) {
    return 'OPENAI_NETWORK_FAILED'
  }

  return 'OPENAI_OCR_FAILED'
}

function normalizeWechatOpenapiErrorCode(error) {
  const message = String((error && (error.errMsg || error.message)) || '').toLowerCase()
  const errCode = error && (error.errCode || error.errcode)

  if (String(errCode) === '604100' || message.includes('api unauthorized')) {
    return 'WECHAT_OPENAPI_OCR_PERMISSION_DENIED'
  }
  if (String(errCode) === '45009' || message.includes('quota')) {
    return 'WECHAT_OPENAPI_OCR_QUOTA_EXCEEDED'
  }

  return 'WECHAT_OPENAPI_OCR_FAILED'
}

function wrapOcrError(error) {
  const code = normalizeOcrErrorCode(error)
  const wrapped = createError(code, formatOcrErrorMessage(code, error))
  wrapped.requestId = error && error.requestId ? error.requestId : ''
  return wrapped
}

function normalizeOcrErrorCode(error) {
  const rawCode = String((error && error.code) || '').trim()
  const message = String((error && error.message) || '').trim()
  const fingerprint = `${rawCode} ${message}`.toLowerCase()

  if (
    rawCode === 'UnauthorizedOperation' ||
    rawCode === 'AuthFailure' ||
    fingerprint.includes('not authorized') ||
    fingerprint.includes('no permission')
  ) {
    return 'OCR_PERMISSION_DENIED'
  }
  if (rawCode) {
    return rawCode
  }
  if (fingerprint.includes('secretid') || fingerprint.includes('secretkey') || fingerprint.includes('credential')) {
    return 'OCR_CREDENTIALS_MISSING'
  }
  if (fingerprint.includes('limit')) {
    return 'OCR_RATE_LIMITED'
  }
  return 'OCR_API_FAILED'
}

function formatOcrErrorMessage(code, error) {
  const requestId = error && error.requestId ? `，requestId=${error.requestId}` : ''

  if (code === 'OCR_CREDENTIALS_MISSING') {
    return '腾讯云 OCR 凭证缺失或无效，请在云函数环境变量中配置 SecretId / SecretKey'
  }
  if (code === 'OCR_PERMISSION_DENIED') {
    return `腾讯云 OCR 当前没有接口权限：${(error && error.message) || 'permission denied'}${requestId}`
  }
  if (code === 'OCR_RATE_LIMITED') {
    return `腾讯云 OCR 调用过于频繁，请稍后重试${requestId}`
  }

  return `腾讯云 OCR 调用失败：${(error && error.message) || 'unknown error'}${requestId}`
}

function getFirstEnv(names) {
  for (const name of names) {
    if (process.env[name]) {
      return process.env[name]
    }
  }

  return ''
}

function createError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function parseHomeworkRegister(rawText) {
  const lines = String(rawText || '')
    .replace(/\r/g, '\n')
    .replace(/[；;]/g, '\n')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)

  return lines.map((line, index) => {
    const subjectMatch = line.match(/^(语文|数学|英语|科学|道法|美术|音乐|体育|劳动)[：: ]?/)
    const subject = subjectMatch ? subjectMatch[1] : ''
    const content = subjectMatch ? line.replace(subjectMatch[0], '').trim() : line

    return {
      id: `draft-${Date.now()}-${index}`,
      subject,
      content,
      rawText: line,
      confidence: subject ? '高' : '低',
      needsConfirm: !subject
    }
  })
}

module.exports = {
  main,
  parseHomeworkRegister
}
