# 技术说明

本文档用于快速说明 `miniapp-starter` 的当前技术结构，方便后续继续开发、交接或上传到 GitHub 后阅读。

## 1. 项目结构

```text
miniapp-starter/
├── app.js
├── app.json
├── app.wxss
├── pages/
├── utils/
├── cloudfunctions/
├── README.md
├── V1-PRD-homework-pet.md
├── V1-PRD-homework-register-ocr.md
├── CLOUD-DATA-NOTES.md
├── CLOUD-SETUP.md
├── DEV-STATUS.md
└── PRODUCT-DOCS-INDEX.md
```

---

## 2. 页面结构

### `pages/home`
首页，负责展示：
- 今日作业进度
- 今日金币
- 宠物状态
- 快捷入口

### `pages/tasks`
作业管理页，负责：
- 查看任务列表
- 新增作业
- 编辑作业
- 删除作业
- 跳转 OCR 导入

### `pages/plan`
排期页，用于展示今日作业顺序与计划安排。

### `pages/pet`
宠物页，用于展示宠物成长与道具购买反馈。

### `pages/profile`
个人页，目前为基础占位页。

### `pages/stats`
统计页，用于展示完成量、金币与打卡情况。

### `pages/ocr-import`
OCR 上传页，负责：
- 拍照
- 从相册选图
- 上传图片
- 调用云函数
- 失败时回退演示数据

### `pages/ocr-result`
OCR 结果确认页，负责：
- 展示草稿列表
- 编辑草稿
- 删除草稿
- 新增草稿
- 导入为正式作业

---

## 3. 状态管理

项目当前没有引入复杂状态管理框架，而是使用 `utils/store.js` 维护本地状态。

当前 store 主要承担：
- 作业列表
- 编辑中的作业 ID
- OCR 当前任务
- OCR 历史任务
- 金币与奖励规则
- 宠物状态
- 商店道具

### 当前特点
- 简单直接，适合原型阶段
- 便于快速改页面和逻辑
- 不适合长期作为正式线上数据方案

---

## 4. OCR 技术链路

当前 OCR 链路如下：

1. 用户在 `pages/ocr-import` 选择图片
2. 调用 `wx.cloud.uploadFile`
3. 调用 `wx.cloud.callFunction({ name: 'homeworkOCR' })`
4. 云函数返回 `rawText + drafts`
5. 在 `pages/ocr-result` 中让用户确认后导入

### 当前云函数
路径：`cloudfunctions/homeworkOCR/index.js`

当前能力：
- 接收 `imageFileID`
- 预留获取临时 URL 的逻辑
- 返回 mock OCR 文本
- 按规则拆分为草稿列表

### 当前不足
- 还未接真实 OCR API
- 还没有完整异常分类
- 还没有持久化 OCR job 数据

---

## 5. 数据设计方向

当前推荐的数据结构见：`CLOUD-DATA-NOTES.md`

重点数据包括：
- `users`
- `families`
- `children`
- `homeworkTasks`
- `coinLogs`
- `pets`
- `shopOrders`
- 后续建议补：`ocrJobs / ocrDraftItems`

---

## 6. 为什么当前选择这种方案

### 原因 1：先做 MVP，验证产品价值
当前阶段更重要的是尽快验证：
- 家长是否真的愿意用
- OCR 导入是否显著节省时间
- 奖励 + 宠物机制是否有持续动力

### 原因 2：微信云开发适合当前阶段
- 不需要先搭独立后端
- 接小程序更顺
- 适合快速原型和 MVP 演进

### 原因 3：本地 store 便于快速迭代
- 页面调试快
- 数据结构可先灵活调整
- 有利于产品方案先跑起来

---

## 7. 当前技术风险

- OCR 服务选型还未最终确定
- 云函数部署与环境绑定仍需补最终闭环
- 本地状态未来迁移到云数据库时会有一轮重构
- 当前项目更偏产品演示和 MVP 骨架，不是最终线上架构

---

## 8. 下一步建议

1. 完成真实 OCR API 接入
2. 部署并联调 `homeworkOCR` 云函数
3. 把核心任务数据落到云开发数据库
4. 对 OCR 结果做更稳定的拆分与异常处理
5. 进一步收敛页面信息层级和交互细节

---

## 9. 一句话结论

当前技术实现已经足够支持产品演示与下一步 MVP 验证，真正的工程化分水岭在于：真实 OCR 接入、云环境闭环、以及本地状态到云数据的迁移。