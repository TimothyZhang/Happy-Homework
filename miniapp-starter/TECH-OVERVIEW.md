# 技术说明

本文档用于快速说明 `miniapp-starter` 的当前技术结构，方便后续继续开发、交接或上传到 GitHub 后阅读。

## 1. 项目结构

```text
miniapp-starter/
├── app.js / app.json / app.wxss
├── pages/                     # 主包页面
│   ├── home/                  # 首页（今日 / 历史日）
│   ├── tasks/                 # 作业本列表
│   ├── notebook-detail/       # 单个作业本下的作业管理
│   ├── calendar/              # 月历视图
│   ├── stats/                 # 统计
│   ├── pet/                   # 宠物
│   ├── profile/               # 个人页（含云同步状态）
│   ├── ocr-import/            # OCR 拍照/选图
│   └── ocr-result/            # OCR 草稿确认
├── pkg-notebook/              # 分包：作业本编辑（首屏不需要，按需加载）
│   └── notebook-edit/
├── components/
│   └── task-list/             # 主页 + 日历共用的作业行组件
├── custom-tab-bar/            # 自定义底部导航
├── utils/
│   ├── store.js               # 本地状态 + 内存缓存 + 数据迁移
│   ├── cloud-sync.js          # 跨端同步（user_state 集合）
│   └── navigation.js          # 页面跳转封装
├── cloudfunctions/
│   └── homeworkOCR/           # 多 provider 兜底 OCR 云函数
├── scripts/                   # Node 端 perf bench / 正确性测试（不打包进小程序）
└── docs（README / PRD / TECH-OVERVIEW / CLOUD-SETUP / DEV-STATUS …）
```

---

## 2. 页面结构

### `pages/home`
首页，按选定日期（默认今日）展示作业行：
- 进行中 / 未完成 / 已完成 分组
- 跨作业本拖拽改顺序
- 当日所有重复型作业的「过去未完成」backlog 一并露出

### `pages/tasks`
作业本列表页：
- 按结束日期倒序展示作业本（长期重复本浮顶）
- 卡片显示完成进度、学科 chips、模式标签
- 入口跳 `notebook-detail` 或 `pkg-notebook/notebook-edit`

### `pages/notebook-detail`
单个作业本的结构管理页：
- 作业按学科分组、组内可拖拽
- 增删改作业
- 删除/编辑作业本
- 不再做日期切换（结构页和今日操作页职责拆分）

### `pages/calendar`
月历视图：
- 每个日期 cell 显示当天 total / done / hasOverdue
- 选中某天显示详细作业行
- 月度数据通过 `dateCountsForMonth` 一次性聚合，避免 30 次全表扫

### `pages/pet` / `pages/profile` / `pages/stats`
- pet：宠物成长与道具
- profile：账号信息 + 数据同步卡片（同步状态、立即同步、切回此设备）
- stats：完成量、金币、打卡

### `pages/ocr-import` / `pages/ocr-result`
OCR 链路：拍照/选图 → 云函数识别 → 草稿编辑 → 导入正式作业。

### `pkg-notebook/notebook-edit`（分包）
作业本编辑（新建 / 修改）。放分包里，从 home/tasks/calendar/notebook-detail 走 `preloadRule` 提前预热，进入仍秒开。

---

## 3. 状态管理

项目没有引入 Redux/Mobx 等框架，使用 `utils/store.js` + `utils/cloud-sync.js` 自己维护。

### 3.1 本地状态结构（`store.js`）
- `notebooks` / `tasks`：核心业务数据
- `coins / streakDays / pet / lastReward`：奖励 + 宠物
- `ocrCurrentJob / ocrJobs`：OCR 任务（不同步）
- `editTaskId / editNotebookId`：UI 临时态（不同步）
- `schemaVersion + migrateState`：v1→v2 迁移（每次 `loadState` 兜底）
- `updatedAt`：最近一次 sync 相关 mutation 的 ms 时间戳

### 3.2 内存缓存
`store.js` 用一个模块级 `_stateCache` 缓存反序列化后的 state：
- 第一次 `loadState` 走 `wx.getStorageSync` + `JSON.parse` + `migrateState`
- 之后所有读全部命中缓存（页面 onShow 几乎零成本）
- `saveState` / `applyHydratedState` 在写盘的同时刷新缓存

### 3.3 跨端同步（`cloud-sync.js` + `user_state` 集合）
- **单设备 claim 模型**：云端 doc 持有 `sessionId`，谁的 ID 匹配谁能写
- `app.onLaunch` 异步 `hydrate()`：云端比本地新就 overlay 同步字段；sessionId 不匹配弹 modal「切到此设备 / 只读浏览」
- 每个 tab 页 `onShow` 调 `hydrateIfStale()`（30s 防抖）
- `saveState` 触发 200ms 防抖 push（拖拽/秒针 tick 不会刷爆云端）
- 只读模式下 `updateState` 直接拒写，throttle 提示一次

### 3.4 同步白名单（`SYNC_FIELDS`）
仅同步 `notebooks / tasks / coins / streakDays / bonusCoins / pet / lastReward`。OCR 任务、UI 临时态、固定配置（rewardRules / shopItems）都本地保留。

### 3.5 性能要点
对 1000 个作业本 / 5000+ 个作业的目标场景做了若干 O(N+M) 改造：
- `decorateNotebook`（tasks 列表页）：先按 `notebookId` group 一次，避免 N 次 filter 全表
- `pauseAllOtherDoing` / `start/pause/resume/finish/revert` task：预建 `notebookById` Map，把 `.find` 拉出 `.map`
- `tasksForDate(today)`：重复型 backlog 按本分组，每本只走一次 active-date 序列
- `dateCountsForMonth`：日历专用聚合器，一次扫描 tasks 出整月 cell 数据，省掉 30 次 `tasksForDate`
- 删掉 `calcOverview`：原本 `getStateWithComputed` 每次都跑一次 `tasksForDate(today)` 算个没人读的 overview

Bench / 正确性测试在 `scripts/perf-bench.js` / `scripts/perf-correctness.js`，Node 端跑：
```
node scripts/perf-bench.js 1000 5 365     # 1000 本 × 5 任务 × 365 天 history
node scripts/perf-correctness.js          # 76 项行为对账
```

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
- 获取临时 URL 或下载图片内容
- 调用腾讯云 OCR
- 按规则拆分为草稿列表

### 当前状态
- 真实闭环已通：腾讯云 OCR 子用户 AKSK + `QcloudOCRFullAccess`，环境变量配齐
- 多 provider 兜底：OpenAI Vision → 腾讯云 OCR（GeneralHandwriting → GeneralAccurate → GeneralBasic）→ 微信 OpenAPI → Tesseract.js
- OCR job 数据当前仅在本地 store 留最近 10 条历史，未落库

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

- **单设备 claim 模型**：同账号多设备同时操作时只有一个能写。如果以后要协同（家长 + 孩子同时改），需要换合并/CRDT 模型
- **同步粒度是整个 SYNC_FIELDS 子集**：每次 push 是整段 JSON 覆盖，不是 field-level patch，离线长时间后回到线上做差量合并会比较粗糙
- **OCR 配额有限**：腾讯云每接口 1000 次/月免费，正式上线前要看付费方案
- **极限规模未验证**：bench 是 1000 本 × 5 任务、365 天 backlog 在 Node 上跑的，真机引擎慢 3-5×；超过这个量级需要分页 / 虚拟列表

---

## 8. 下一步建议

1. **OCR 识别质量调优**：多 provider 并行合并、把腾讯云 confidence 字段纳入 `needsConfirm` 判定
2. **OCR 错误码分级**：现有 `errorCode` 已传到端，前端没分级展示
3. **数据模型分表**：当前同步是把 `tasks` 数组整段推。等数据更大时拆成 `tasks` 集合，按 `notebookId` 索引
4. **多家庭/多孩子账号**：当前 sessionId 只能识别同账号下哪台设备活跃，没有"孩子身份"概念
5. **作业本/作业列表的虚拟滚动**：极端规模下渲染层会成为新瓶颈

---

## 9. 一句话结论

当前实现已经从早期原型走到「可上线灰度」前夜：OCR 真闭环已通，云同步落地（单设备 claim 模式），核心热点路径已优化到 1000 本规模可用。下一步是 OCR 识别质量、配额评估，以及账号体系扩展到多孩子/多家庭。
