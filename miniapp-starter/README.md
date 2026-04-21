# miniapp-starter

一个围绕“小学生家庭作业管理”场景搭建的微信小程序 MVP。

当前项目已经从最初的静态 demo，推进到可交互原型 + OCR 导入链路骨架阶段，适合继续做产品验证、家长访谈和云开发接入。

## 项目目标

帮助家长更轻松地管理孩子每天的家庭作业，并通过奖励与宠物养成提升孩子完成作业的主动性。

当前聚焦两条核心路径：

1. **手动录入作业并管理执行进度**
2. **拍照识别作业登记本，拆分为多条作业后导入**

## 当前能力范围

### 已有页面
- `pages/home`：首页，总览今日进度、奖励和宠物状态
- `pages/tasks`：作业列表与编辑入口
- `pages/plan`：排期视图
- `pages/pet`：宠物养成页
- `pages/profile`：个人页
- `pages/stats`：统计页
- `pages/ocr-import`：拍照/选图上传页
- `pages/ocr-result`：OCR 识别结果确认页

### 已完成能力
- 首页、作业、排期、宠物、统计等多页面交互原型
- 作业状态流转：未开始 / 进行中 / 已完成
- 金币奖励与宠物成长反馈
- OCR 导入链路骨架：
  - 小程序端初始化云开发
  - 上传图片到云存储
  - 调用 `homeworkOCR` 云函数
  - 展示并编辑识别后的作业草稿
  - 批量导入到作业列表

### 当前未完成
- 真实 OCR 服务接入
- 云函数部署后的完整联调验证
- 线上数据模型真正落到云开发数据库
- 多孩子/家庭账号体系

## 产品文档

项目内文档建议按下面顺序阅读：

1. `V1-PRD-homework-pet.md`
   - 小程序整体 V1 产品设计文档
   - 覆盖作业管理、排期、奖励、宠物养成等主链路

2. `V1-PRD-homework-register-ocr.md`
   - “作业登记本 OCR”专项产品设计文档
   - 重点说明整页识别、草稿拆分、编辑确认、导入流程

3. `CLOUD-DATA-NOTES.md`
   - 云开发数据结构草案
   - 说明 MVP 阶段推荐的数据表设计

4. `CLOUD-SETUP.md`
   - 微信云开发接入说明
   - 说明当前已完成接入点与下一步部署动作

## 技术结构

### 小程序端
- `app.js / app.json / app.wxss`：全局配置
- `pages/*`：页面实现
- `utils/store.js`：原型数据与状态管理
- `utils/navigation.js`：页面跳转封装

### 云函数
- `cloudfunctions/homeworkOCR`
  - OCR 云函数入口
  - 当前返回 mock 文本
  - 已内置一版整页文本拆分逻辑

## 当前实现状态

### OCR 当前状态
目前已经打通到“前端真实上传 + 调用真实云函数入口”，但云函数内仍返回 mock 文本。

也就是说，当前进度不是纯前端假流程，而是已经完成了：
- `wx.cloud.init`
- `wx.cloud.uploadFile`
- `wx.cloud.callFunction({ name: 'homeworkOCR' })`

真正还差的是：
- 在微信开发者工具中绑定云环境
- 部署 `cloudfunctions/homeworkOCR`
- 在云函数中接入真实 OCR 服务

## 本地打开方式

1. 打开微信开发者工具
2. 选择“导入项目”
3. 项目目录指向 `miniapp-starter`
4. 使用当前 `project.config.json` 中的 AppID 打开
5. 如需测试 OCR 链路，继续完成云开发环境绑定与云函数部署

## 推荐下一步

### 产品侧
1. 收敛首页和作业列表的信息层级
2. 明确 OCR 导入后的默认字段与优先级规则
3. 补一版“家长一天内使用路径”的体验脚本

### 技术侧
1. 在云函数中接入真实 OCR API
2. 验证整页文本拆分效果
3. 将本地状态迁移到云开发数据库
4. 增加错误态与重试机制

## Git 历史里程碑

- `3c02a95` Add WeChat mini program demo scaffold
- `ea231d5` feat: add miniapp starter project
- `fd0e30e` Add miniapp PRD and configure preview project
- `b688f5c` Build first interactive homework miniapp prototype
- `148b251` Expand miniapp into multi-page interactive V1
- `6d5a6d2` Add task editing and stats to miniapp prototype
- `4478ea5` Improve prototype feedback flow and add cloud data notes
- `b968a62` Add homework register OCR flow scaffold
- `b4c9adf` Wire mini program to cloud OCR flow

## 当前结论

这是一个已经具备产品骨架、页面原型和 OCR 导入主流程骨架的微信小程序项目。

如果接下来优先把云函数部署和真实 OCR 接入补齐，就可以进入更真实的 MVP 验证阶段。