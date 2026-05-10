# miniapp-starter

一个围绕“小学生家庭作业管理”场景搭建的微信小程序 MVP。

当前项目已经走过原型阶段，进入「可灰度 MVP」：**OCR 真实闭环 + 跨端云同步** 都已落地，核心热点路径为 1000 本规模做过算法优化。适合做家长访谈和小范围灰度验证。

## 项目目标

帮助家长更轻松地管理孩子每天的家庭作业，并通过奖励与宠物养成提升孩子完成作业的主动性。

当前聚焦两条核心路径：

1. **手动录入作业并管理执行进度**
2. **拍照识别作业登记本，拆分为多条作业后导入**

## 当前能力范围

### 已有页面
- `pages/home`：首页，按选定日期展示作业行（未完成 / 已完成 分组）+ hero stats
- `pages/tasks`：作业本列表（按结束日期倒序，长期重复本浮顶）
- `pages/notebook-detail`：单作业本结构管理（作业按学科分组，组内拖拽）
- `pages/notebook-share`：接收方落地页（解 share path → 预览 → 保存为自己的本）
- `pages/calendar`：月历视图，每日完成度 / overdue 概览
- `pages/pet`：宠物养成页
- `pages/profile`：个人页（含数据同步卡片）
- `pages/stats`：学习统计
- `pages/ocr-import` / `pages/ocr-result`：OCR 拍照导入链路
- `pkg-notebook/notebook-edit`（子包）：新建 / 编辑作业本，preloadRule 预热

### 已完成能力
- 多页面交互闭环（首页 / 作业本 / 详情 / 日历 / 宠物 / 统计）
- 一次性 + 重复（每日 / 每周指定日）两种作业本，重复型按日期分别记录状态
- 作业状态流转：未开始 / 进行中 / 暂停 / 已完成 / 误点恢复
- 全局只允许一个作业 `doing`（其他自动 paused）
- 金币奖励与宠物成长反馈
- **OCR 真实闭环**：腾讯云 OCR 子用户 AKSK 已配置，多 provider 兜底（OpenAI Vision → 腾讯云 GeneralHandwriting / Accurate / Basic → 微信 OpenAPI → Tesseract.js）
- **跨端云同步**：`user_state` 集合，单设备 claim 模型（切换设备弹 modal，旧设备只读）；「我的」页面有「立即同步 / 切回此设备」按钮
- **作业本分享**：把 notebook + tasks 编进 share path，接收方落地 `pages/notebook-share` 预览后一键保存为自己的本（`store.importSharedNotebook`）；发送方昵称用 `<input type="nickname">` 自动取微信昵称，跟随 cloud-sync 跨设备
- **大规模数据优化**：1000 本 / 5000+ 任务场景下主要热点路径已 O(N+M) 改造，附 Node 端 bench / 正确性测试
- 自定义 tabBar（字号 30rpx，比平台默认大）+ 子包预热

### 当前未完成
- OCR 识别质量进一步调优（多 provider 并行合并、confidence 入 `needsConfirm`）
- OCR 错误码分级提示 + 失败重试 / 配额耗尽提示
- `coinLogs / ocrDraftItems` 等日志型数据的长期沉淀（目前只有最新快照）
- 多孩子 / 多家庭账号体系
- OCR 计费方案与云数据库读写预算评估
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
- `app.js / app.json / app.wxss`：全局配置（cloud.init + 云同步 hydrate；`tabBar.custom` 指向自定义 tab bar；`preloadRule` 预热分包）
- `pages/*`：主包页面
- `pkg-notebook/notebook-edit`：作业本编辑分包，preloadRule 预热
- `components/task-list`：首页和日历共用的作业行组件（拖拽 + swipe-to-revert）
- `custom-tab-bar`：自定义底部导航（字号 30rpx，每 tab 页 onShow 同步 selected）
- `utils/store.js`：业务状态 + 进程内缓存 + schema 迁移 + 写后触发云推送
- `utils/cloud-sync.js`：跨端云同步（`user_state` 集合，单设备 claim）
- `utils/navigation.js`：页面跳转封装
- `scripts/perf-bench.js` / `perf-correctness.js`：Node 端性能基准 + 76 项行为对账（已通过 `project.config.json` `packOptions.ignore` 排除打包）

### 云函数
- `cloudfunctions/homeworkOCR`：OCR，多 provider 兜底（腾讯云 / OpenAI / 微信 OpenAPI / Tesseract.js），已部署到 `cloud1-d8gkzu6ls85efd509`

### 云数据库
- 集合 `user_state`：每个用户一份完整 state 快照（详见 `CLOUD-SETUP.md`）

## 当前实现状态

### OCR 当前状态
**真实闭环已通**。前端 `wx.cloud.uploadFile` + `wx.cloud.callFunction` → 云函数调腾讯云 OCR（GeneralHandwriting 优先）→ 拆草稿 → 用户编辑后导入。

具体配置（详见 `CLOUD-SETUP.md`）：
- 腾讯云子用户 `happy-homework-ocr` + `QcloudOCRFullAccess`
- 环境变量 `OCR_SECRET_ID / OCR_SECRET_KEY / OCR_REGION`
- 云开发环境 `cloud1-d8gkzu6ls85efd509`

### 云同步当前状态
**已接入**。本地 state 经 `utils/cloud-sync.js` 同步到 `user_state` 集合，单设备 claim 模型。
- `app.onLaunch` 异步 hydrate；每个 tab 页 `onShow` 调 `hydrateIfStale()`（30s 防抖）
- `saveState` 触发 200ms 防抖 push
- 切换设备弹 modal「切到此设备 / 只读浏览」
- 详见 `CLOUD-SETUP.md` 的「跨设备数据同步」一节

## 本地打开方式

1. 打开微信开发者工具
2. 选择「导入项目」
3. 项目目录**必须**指向 `miniapp-starter` 子目录（不是父目录 `happy_homework`），否则找不到 `app.json` 也无法部署云函数
4. 使用 `project.config.json` 中的 AppID 打开
5. 云开发环境已绑定 `cloud1-d8gkzu6ls85efd509`，OCR 链路开箱即可联调
6. **数据云同步必须**在云开发控制台手动新建 `user_state` 集合，权限设「仅创建者可读写」（详见 `CLOUD-SETUP.md` 末尾章节），否则同步会静默失败

## 性能基准

```bash
node scripts/perf-bench.js 1000 5 365     # 1000 本 × 5 任务 × 365 天 history
node scripts/perf-correctness.js          # 76 项行为对账
```

## 推荐下一步

### 产品侧
1. 真实跑 5-10 张登记本照片，记录命中率作为基线
2. OCR 识别失败时的兜底交互打磨
3. 补一版「家长一天内使用路径」的体验脚本
4. 收敛首页和作业列表的信息层级

### 技术侧
1. OCR 多 provider 并行合并（取识别行数最多者），把 confidence 字段纳入 `needsConfirm`
2. OCR 错误码分级 + 失败重试
3. `coinLogs / ocrDraftItems` 拆出来单独建集合做长期沉淀
4. 多孩子 / 多家庭账号体系
5. 离线写入队列 + 联网批量 push
6. 极限规模下 list 页虚拟滚动

## 当前结论

这是一个 OCR 真实可用、跨端云同步落地、核心热点路径已为大数据规模优化的微信小程序 MVP，可以进入小范围灰度验证阶段。

下一步关键是 OCR 识别质量调优 + 错误处理细化 + 多账号体系。
