# miniapp-starter

一个围绕“小学生家庭作业管理”场景搭建的微信小程序 MVP。

当前项目已经从最初的静态 demo，推进到 **OCR 真实闭环 + 跨设备同步** 的 MVP 阶段，适合继续做产品验证和家长访谈。

## 项目目标

帮助家长更轻松地管理孩子每天的家庭作业，并通过奖励与宠物养成提升孩子完成作业的主动性。

当前聚焦两条核心路径：

1. **手动录入作业并管理执行进度**
2. **拍照识别作业登记本，拆分为多条作业后导入**

## 当前能力范围

### 已有页面
- `pages/home`：首页，当日作业列表 + hero stats
- `pages/tasks`：作业本管理（列表 / 拖拽重排）
- `pages/calendar`：日历（月历 + 当日详情）
- `pages/notebook-detail`：作业本详情（按学科分组）
- `pages/pet`：宠物养成
- `pages/profile`：我的（含数据同步控制）
- `pages/stats`：学习统计
- `pages/ocr-import` / `pages/ocr-result`：OCR 拍照导入链路
- `pkg-notebook/notebook-edit`（子包）：新建 / 编辑作业本表单

### 已完成能力
- **OCR 真实闭环**：拍照 → 上传云存储 → 云函数调腾讯云 OCR → 拆草稿 → 导入作业
- **跨设备数据同步**：本地缓存 + 云数据库 `user_state` 集合镜像，单设备登录模型（切换设备时旧设备只读）
- 自定义 tabBar（字号 30rpx，比平台默认大）+ 子包预热（`preloadRule`）
- 作业管理：增删改、重复 / 一次性、按学科分组、拖拽重排
- 状态流转：未开始 / 进行中 / 暂停 / 已完成
- 金币奖励与宠物成长反馈
- 多 provider OCR 兜底：OpenAI Vision → 腾讯云 OCR → 微信 OpenAPI → Tesseract.js
- 「我的」页面有「立即同步 / 切回此设备」按钮

### 当前未完成
- OCR 错误码分级提示 / 失败重试 / 配额耗尽提示
- `coinLogs / ocrDraftItems` 等日志型数据的长期沉淀（目前只有最新快照）
- 多孩子 / 多家庭账号体系
- 离线写入队列 + 联网批量 push

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

5. `DEV-STATUS.md`
   - 当前开发状态说明
   - 用于快速判断哪些已经完成，哪些仍是原型

6. `TECH-OVERVIEW.md`
   - 技术结构说明
   - 用于快速理解页面、状态管理、云函数和后续研发方向

## 技术结构

### 小程序端
- `app.js / app.json / app.wxss`：全局配置（cloud.init + 云同步 hydrate）
- `pages/*`：主包页面
- `pkg-notebook/`：子包（notebook-edit），有 preloadRule 预热
- `custom-tab-bar/`：自定义 tabBar 组件
- `components/task-list/`：任务行组件（含拖拽 + swipe-to-revert）
- `utils/store.js`：业务状态 + 进程内缓存 + 写后触发云推送
- `utils/cloud-sync.js`：云数据库同步（`user_state` 集合，单设备 session 占用）
- `utils/navigation.js`：页面跳转封装

### 云函数
- `cloudfunctions/homeworkOCR`：OCR，多 provider 兜底（腾讯云 / OpenAI / 微信 OpenAPI / Tesseract.js）

### 云数据库
- 集合 `user_state`：每个用户一份完整 state 快照（详见 `CLOUD-SETUP.md`）

## 本地打开方式

1. 打开微信开发者工具
2. 选择「导入项目」，目录指向 `miniapp-starter`
3. 使用当前 `project.config.json` 中的 AppID 打开
4. **首次跑前**：到云开发控制台新建集合 `user_state`，权限设「仅创建者可读写」（详见 `CLOUD-SETUP.md` 末尾章节），否则同步会静默失败
5. OCR 链路：完成云函数部署 + OCR 凭证配置（详见 `CLOUD-SETUP.md` 主体章节）

## 推荐下一步

### 产品侧
1. 收敛首页和作业列表的信息层级
2. 明确 OCR 导入后的默认字段与优先级规则
3. 补一版「家长一天内使用路径」的体验脚本

### 技术侧
1. OCR 错误码分级提示 + 失败重试
2. `coinLogs / ocrDraftItems` 拆出来单独建集合做长期沉淀
3. 离线写入队列 + 联网批量 push
4. 多孩子 / 多家庭账号体系（若产品方向需要）

## 当前结论

这是一个产品骨架完整、OCR 主链路 + 跨设备同步均真实可用的小程序 MVP，可以拿给真实家长试用。下一步关键是 OCR 识别质量调优与错误处理细化，让它从 MVP 进入「可上线产品」。
