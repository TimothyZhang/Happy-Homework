# homeworkOCR 云函数

这是“作业登记本 OCR”能力的云函数入口。

## 当前状态
- **真实闭环已通**，已部署到云开发环境 `cloud1-d8gkzu6ls85efd509`
- 多 provider 兜底：OpenAI Vision → 腾讯云 OCR（GeneralHandwriting → Accurate → Basic）→ 微信 OpenAPI → Tesseract.js
- 主链路：`imageFileID → 取临时 URL/下载 → OCR provider 兜底 → rawText → parseHomeworkRegister → drafts`
- 部署 + 环境变量配置详见仓库根 `CLOUD-SETUP.md`

## 当前采用方案
### 多 provider 兜底
设计成"前一个失败/返回空才试下一个"，所以 provider 顺序就是优先级。当前顺序是 **OpenAI Vision → 腾讯云**（手写体优先）**→ 微信 OpenAPI → Tesseract.js**。可通过 `OCR_PROVIDER` 环境变量强制只走某一条（`openai` / `tencent` / `wechat`）。

> 业务密钥不放小程序前端，全部走环境变量在云函数里读。

## 这个函数建议的输入
```json
{
  "imageFileID": "cloud://..."
}
```

## 需要的环境变量

### OpenAI（官方 api.openai.com）
- `OPENAI_API_KEY`
- 可选：`OPENAI_OCR_MODEL`，默认 `gpt-4o-mini`
- 可选：`OPENAI_BASE_URL`，默认 `https://api.openai.com/v1`
- 可选：`OPENAI_OCR_TIMEOUT_MS`，默认 `45000`

### Azure OpenAI
配齐下面四个会自动识别走 Azure 路径（不必再设 `OPENAI_API_TYPE=azure`）：
- `OPENAI_API_KEY` —— Azure 资源的 key
- `AZURE_OPENAI_ENDPOINT` —— `https://<resource>.openai.azure.com`，**不带** `/openai`
- `AZURE_OPENAI_DEPLOYMENT` —— Azure 门户里 Deployments 列出来的 name
- 可选：`AZURE_OPENAI_API_VERSION`，默认 `2025-04-01-preview`（Responses API 需要 ≥ 2025-03 系列）

### 调用方式
默认走 **Responses API**（`/openai/responses`），匹配 GPT-5/o-series 等新模型；遇到 Azure 部署只支持 Chat Completions 时会自动 404 回退到 `/openai/deployments/{deployment}/chat/completions`。
- 可选：`OPENAI_USE_CHAT_COMPLETIONS=true` 强制只走 Chat Completions（GPT-4o/4-turbo 等老部署可用）
- 可选：`OPENAI_OCR_MAX_TOKENS`，默认看 `getOpenAiMaxTokens()`

## 建议返回
```json
{
  "ok": true,
  "rawText": "...",
  "drafts": [
    {
      "subject": "语文",
      "content": "抄写第3课生字两遍"
    }
  ]
}
```
