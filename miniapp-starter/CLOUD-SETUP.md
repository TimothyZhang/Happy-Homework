# 微信云开发接入说明

当前项目已经把前端调用链和云函数入口接好了。

## 已完成
- `app.js` 已调用 `wx.cloud.init`
- `pages/ocr-import/index.js` 已接入：
  - `wx.cloud.uploadFile`
  - `wx.cloud.callFunction({ name: 'homeworkOCR' })`
- `cloudfunctions/homeworkOCR` 已可部署

## 现在还差什么
这一步必须在微信开发者工具里完成，因为需要云环境权限。

## 需要操作
1. 打开微信开发者工具
2. 导入 `miniapp-starter`
3. 开通或绑定云开发环境
4. 右键部署云函数：`cloudfunctions/homeworkOCR`
5. 安装依赖（如果工具提示）
6. 再回到小程序里测试拍照识别

## 当前效果
即使云函数已经部署，现在返回的仍是“云函数内 mock OCR 文本”，但：
- 前端已经走真实上传
- 已经走真实云函数调用
- 不再是纯前端本地 mock

也就是说，现在差的只剩：

> 在 `cloudfunctions/homeworkOCR/index.js` 里接真正的 OCR 服务

## 下一步替换点
在 `recognizeRegisterText(event)` 里替换成：
- 根据 `imageFileID` 拿临时 URL
- 调 OCR API
- 返回整页文本

然后现有 `parseHomeworkRegister(rawText)` 会继续把整页文本拆成作业草稿。
