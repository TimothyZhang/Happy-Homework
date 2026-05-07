'use strict'

const http = require('http')
const https = require('https')

const DEFAULT_OPENAI_MODEL = 'gpt-4o'
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

/**
 * homeworkOCR 云函数
 *
 * 支持两种模式：
 * 1. 传入 imageFileID，走真实 OCR 识别
 * 2. 传入 mockRawText，便于本地联调拆分逻辑
 */
async function main(event = {}) {
  try {
    const recognition = await recognizeRegisterText(event)
    // Provider(主要是 OpenAI Vision)若已经直接吐出结构化 drafts,直接用,
    // 跳过 parseHomeworkRegister 那个基于行 + 正则的解析(对表格场景会切碎)。
    const drafts = (Array.isArray(recognition.drafts) && recognition.drafts.length > 0)
      ? recognition.drafts
      : parseHomeworkRegister(recognition.rawText)
    return {
      ok: true,
      source: recognition.source,
      providerWarning: recognition.providerWarning || '',
      imageFileID: event.imageFileID || '',
      rawText: recognition.rawText,
      drafts
    }
  } catch (error) {
    console.error('homeworkOCR failed', {
      code: error.code,
      message: error.message,
      requestId: error.requestId || '',
      stack: error.stack
    })

    return {
      ok: false,
      source: 'cloud-function',
      imageFileID: event.imageFileID || '',
      errorCode: error.code || 'OCR_FAILED',
      error: error.message || 'OCR 识别失败',
      requestId: error.requestId || '',
      canFallback: isBuiltinOcrFallbackEnabled()
    }
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
    '1. 表格里"语文/数学/英语/..."栏目对应同一行右边的内容，要合并成一条 draft（不要按 cell 切碎）。',
    '2. 不要把模板字段（上学时间、家长签名、体温记录、到家时间、离校时间、上午/下午、周/星期/日期 等）当作业输出。',
    '3. 没有识别出作业时 drafts 返回空数组。',
    '4. content 里保留页码、题号、范围等关键信息（如"第12页 1-5题"）。',
    '5. 字迹模糊或 subject 为空时把 needsConfirm 设为 true，confidence 给"低"。',
    '6. 不确定的字用最可能的中文原文，不要编造内容。'
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

  const payload = {
    model: options.model,
    max_output_tokens: getOpenAiMaxTokens(),
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

  // 推理类(o-series / gpt-5 reasoning)模型不接受 temperature !== 1;非推理模型让识别尽量确定。
  if (!isReasoningModel(options.model)) {
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
  return message.includes('not found') && message.includes('responses')
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
      timeout: getOpenAiTimeoutMs()
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
      timeout: getOpenAiTimeoutMs()
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
  // Responses API 需要相对新的 api-version;2025-04-01-preview 是 GPT-5 类模型默认建议值。
  return getFirstEnv(['AZURE_OPENAI_API_VERSION']) || '2025-04-01-preview'
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
    console.warn('getTempFileURL failed, fallback to base64', error)
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

function getOpenAiTimeoutMs() {
  const timeoutMs = Number(getFirstEnv(['OPENAI_OCR_TIMEOUT_MS']))
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 45000
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
