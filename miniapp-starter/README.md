# miniapp-starter

一个新建的微信小程序起步项目，已包含最小可运行首页。

## 目录

- `app.js / app.json / app.wxss`：全局配置
- `pages/home`：首页示例
- `project.config.json`：微信开发者工具项目配置

## 打开方式

1. 打开微信开发者工具
2. 选择“导入项目”
3. 项目目录指向 `miniapp-starter`
4. AppID 可先用测试号或继续使用 `touristappid`

## 当前状态

- 可以直接打开
- 可以直接预览首页
- 已带一个按钮用于验证页面交互
- 已有作业录入、排期、奖励、宠物基础页面
- 已接入“作业登记本 OCR”页面骨架（上传页 + 识别结果确认页）

## 下一步建议

1. 开通并绑定微信云开发环境
2. 在 `cloudfunctions/homeworkOCR` 中接入真实 OCR 服务
3. 用云函数返回整页文本 + 草稿拆分结果
4. 将 `pages/ocr-import` 里的 mock 逻辑替换成真实上传和调用
5. 继续完善作业导入后的编辑、排期和奖励衔接

## OCR 当前实现状态

- `pages/ocr-import`：已支持拍照/相册导入/演示数据
- `pages/ocr-result`：已支持草稿编辑、删除、新增、批量导入
- `utils/store.js`：已增加 `ocrCurrentJob / ocrJobs` 临时状态
- 当前仍为 mock 识别结果，下一步需要接真实 OCR

## 推荐接法

优先建议：**微信云开发 + 云函数 OCR**

原因：
- 不需要单独搭服务器
- 便于后续替换 OCR 提供方
- 适合当前 MVP 快速验证
- 更方便做“整页识别 + 多条作业拆分”逻辑
