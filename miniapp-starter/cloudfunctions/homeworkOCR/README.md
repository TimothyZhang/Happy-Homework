# homeworkOCR 云函数

这是“作业登记本 OCR”能力的云函数入口。

## 当前状态
- 已提供函数骨架
- 当前返回 mock OCR 结果
- 已内置一版简单的 `parseHomeworkRegister(rawText)` 拆分逻辑

## 下一步要接什么
1. 在云开发环境中创建并部署本函数
2. 将图片上传到云存储，拿到 `fileID`
3. 在本函数里调用真实 OCR 服务
4. 将 OCR 返回的整页文本传给 `parseHomeworkRegister(rawText)`
5. 把 `drafts` 返回给小程序端确认编辑

## 推荐真实接法
### 方案 A：云函数内接第三方 OCR API
适合快速验证，灵活度高。

### 方案 B：云函数内接腾讯云/微信生态 OCR
适合后续长期稳定使用。

## 这个函数建议的输入
```json
{
  "imageFileID": "cloud://..."
}
```

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
