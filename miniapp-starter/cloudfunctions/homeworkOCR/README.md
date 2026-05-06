# homeworkOCR 云函数

这是“作业登记本 OCR”能力的云函数入口。

## 当前状态
- 已接入 OpenAI Vision OCR 主链路
- 保留腾讯云 / 微信 OpenAPI OCR 作为显式关闭 OpenAI 后的备用链路
- 支持 `imageFileID -> OCR -> rawText -> drafts` 主链路
- 已内置一版简单的 `parseHomeworkRegister(rawText)` 拆分逻辑
- 仍需在云环境中配置 `OPENAI_API_KEY`

## 下一步要接什么
1. 在云开发环境中部署本函数
2. 为云函数配置 OpenAI 环境变量
3. 将图片上传到云存储，拿到 `fileID`
4. 在本函数里调用 OpenAI Vision OCR
5. 将 OCR 返回的整页文本传给 `parseHomeworkRegister(rawText)`
6. 把 `drafts` 返回给小程序端确认编辑

## 当前采用方案
### 方案 C：云函数内接 OpenAI Vision OCR
适合快速绕开腾讯云 / 微信 OCR 权限链路，也避免在小程序前端暴露密钥。

## 这个函数建议的输入
```json
{
  "imageFileID": "cloud://..."
}
```

## 需要的环境变量
- `OPENAI_API_KEY`
- 可选：`OPENAI_OCR_MODEL`，默认 `gpt-4o-mini`
- 可选：`OPENAI_BASE_URL`，默认 `https://api.openai.com/v1`
- 可选：`OPENAI_OCR_TIMEOUT_MS`，默认 `45000`

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
