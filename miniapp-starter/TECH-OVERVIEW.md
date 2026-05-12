# 技术说明

本文档用于快速说明 `miniapp-starter` 的当前技术结构，方便后续继续开发、交接或上传到 GitHub 后阅读。

## 1. 项目结构

```text
miniapp-starter/
├── app.js                     # cloud.init + cloud-sync.hydrate
├── app.json                   # 含 tabBar.custom + subpackages + preloadRule
├── app.wxss
├── pages/                     # 主包页面
│   ├── home/                  # 首页（按选定日期展示作业行 + 宠物对话气泡）
│   ├── tasks/                 # 作业本列表（按结束日期倒序）
│   ├── leaderboard/           # 排行榜 tab
│   ├── notebook-detail/       # 单作业本结构管理（按学科分组 + 组内拖拽；纯结构视图，不含计时控件）
│   ├── notebook-share/        # 接收方落地页（解码 share path → 预览 → 保存）
│   ├── calendar/              # 月历视图（每日完成度 / overdue 概览）
│   ├── stats/                 # 学习统计
│   ├── pet/                   # 宠物
│   ├── profile/               # 个人页（含云同步状态卡片）
│   ├── ocr-import/            # OCR 拍照/选图
│   └── ocr-result/            # OCR 草稿确认
├── pkg-notebook/              # 分包：作业本 / 单条作业编辑（被 home/tasks/calendar/notebook-detail preload 预热）
│   ├── notebook-edit/         #   新建 / 编辑作业本
│   └── notebook-task-edit/    #   新增 / 编辑单条作业（科目自动推断 + 历时预估）
├── components/
│   ├── task-list/             # 首页 + 日历共用的作业行组件（拖拽 + swipe-to-revert + 计时控件）
│   ├── month-calendar/        # 首页内嵌日历 + 日历 tab 共用的月历
│   └── reward-toast/          # 完成单项 / 当日全完成的金币奖励动画
├── custom-tab-bar/            # 自定义底部导航（字号 30rpx，比平台默认大）
├── utils/
│   ├── store.js               # 业务状态 + 进程内缓存 + schema 迁移 + saveState 触发云推送
│   ├── cloud-sync.js          # 跨端同步（user_state 集合，单设备 session 占用）
│   ├── share-reward.js        # 包装 shareReward 云函数（whoami / credit / claim）+ openid 缓存
│   └── navigation.js          # 页面跳转封装
├── cloudfunctions/
│   ├── homeworkOCR/           # 多 provider 兜底 OCR 云函数（OpenAI / 腾讯云 / 微信 OpenAPI / Tesseract.js）
│   └── shareReward/           # 分享奖励云函数（独立 share_rewards_inbox 集合）
├── scripts/                   # Node 端：perf-bench / perf-correctness / values-check（V1 数值校验），不打包进小程序
└── docs（README / PRD / TECH-OVERVIEW / CLOUD-SETUP / DEV-STATUS / PRODUCT-DOCS-INDEX / CLOUD-DATA-NOTES / V1-VALUES-DESIGN / V1-PET-ANIMATION-SPEC）
```

---

## 2. 页面结构

### `pages/home`
首页，按选定日期（默认今日）展示作业行：
- 未完成 / 已完成 分组
- 顶部 3 段日期切换器（今天 / 明天 / 日历），其中"日历"会展开内嵌的月历
- 宠物对话气泡：根据剩余项数 + 预计还需时间生成鼓励文案
- 跨作业本拖拽改顺序
- 重复型作业的「过去未完成」backlog 会一并露出

### `pages/tasks`
作业本列表页：
- 按结束日期倒序展示作业本（长期重复本浮顶）
- 卡片显示完成进度、学科 chips、模式标签
- 入口跳 `notebook-detail` 或子包 `pkg-notebook/notebook-edit`

### `pages/notebook-detail`
单作业本结构管理页：
- 作业按学科分组（语文/数学/英语...），组内可拖拽
- task 行不显示任何计时控件（start/pause/resume/finish 都不出现）—— 这页是纯结构视图，执行操作走首页 / 日历的 `task-list` 组件
- 已完成的作业行右侧保留只读 ✓ 标识 + 编辑 / 删除按钮
- 底部 action stack：+ 新增作业 / 编辑作业本 / 分享 / 复制 / 删除
- 不再做日期切换（结构页和今日操作页职责拆分）

### `pages/notebook-share`
接收方落地页 —— 微信好友点开 `notebook-detail` 的「📤 分享作业本」卡片后落到这里：
- `onLoad` 解 `?d=` 里 URI-encoded 的 JSON payload（`{ v, from, n, t }`）
- 顶部 hint pill 显示 「{发送者昵称}分享给你的作业本」（昵称来自发送方 profile，未设置则回退「好友」）
- 任务列表只读预览，无 新增/编辑/复制/删除
- 三个底部动作：💾 保存（调 `store.importSharedNotebook` 创建新本，全部 task 状态 reset 为 todo）/ 📤 分享（`onShareAppMessage` 把同 payload 转发）/ 取消
- 注册在主包，因为它经常是冷启动入口（受卡片首次打开），不能塞分包

### `pages/calendar`
月历视图：
- 每个日期 cell 显示当天 total / done / hasOverdue
- 选中某天显示详细作业行
- 月度数据通过 `dateCountsForMonth` 一次性聚合，避免 30 次 `tasksForDate`
- 月历构建在 `wx.nextTick` 里延后，首屏 chrome 先出

### `pages/leaderboard` / `pages/pet` / `pages/profile` / `pages/stats`
- leaderboard：排行榜 tab（V1 占位）
- pet：宠物成长与道具购买（动画系统详见 `V1-PET-ANIMATION-SPEC.md`）
- profile：「我的昵称」`<input type="nickname">`（自动回填微信昵称，作为分享发送方身份）+ 家庭设置占位 + 学习统计入口 + **数据同步卡片**（状态 pill + 「立即同步」/「用此设备」按钮）
- stats：今日完成 / 金币 / 历史

### `pages/ocr-import` / `pages/ocr-result`
OCR 上传 + 草稿确认链路（详见 `V1-PRD-homework-register-ocr.md`）。

### `pkg-notebook/notebook-edit` & `pkg-notebook/notebook-task-edit`（子包）
- `notebook-edit`：作业本编辑（新建 / 修改），从 tasks 页"+ 新建作业本"或 notebook-detail "编辑作业本"进入
- `notebook-task-edit`：单条作业编辑，从 notebook-detail "+ 新增作业" 或行内"✏️"进入；自动按内容推断科目（基于历史命中），并按 (content, subject) 历史给出预估耗时

两者都在 `preloadRule` 里，被 home/tasks/calendar/notebook-detail 进入时预热，避免第一次点击的加载延迟。

---

## 3. 状态管理

项目没有引入 Redux/MobX 等框架，使用 `utils/store.js` + `utils/cloud-sync.js` 自己维护。架构是：**进程内缓存 + 本地 storage 落盘 + 云数据库镜像**。

### 3.1 本地状态结构（`store.js`）
```js
{
  schemaVersion, updatedAt,                                  // 版本 + 同步时间戳
  notebooks, tasks,                                          // 核心业务
  coins, streakDays, perfectDays, bonusByDay,                // 奖励
  pendingShareCoins, testCoinsGranted,                       // 分享/测试金币的去重标记
  pet, lastReward,                                           // 宠物
  profile,                                                   // { nickname, avatar } —— 分享发送方身份
  rewardRules, shopItems,                                    // 静态配置（不同步）
  editTaskId, editNotebookId,                                // UI 临时态（不同步）
  ocrCurrentJob, ocrJobs                                     // OCR 临时态（不同步）
}
```
`migrateState` 每次 `loadState` 兜底做 v1→v2 迁移。

### 3.2 内存缓存
`store.js` 用模块级 `_stateCache` 缓存反序列化后的 state：
- 第一次 `loadState` 走 `wx.getStorageSync` + `JSON.parse` + `migrateState`
- 之后所有读全部命中缓存（页面 onShow 几乎零成本）
- `saveState` / `applyHydratedState` 在写盘的同时刷新缓存

### 3.3 写入流程
`updateState(updater)` → 检查 `cloudSync.isReadOnly()`（被踢则节流 toast + 不写）→ `clone + updater` → 盖 `updatedAt = Date.now()` → `saveState`（写 cache + storage + 触发 push）。

### 3.4 跨端同步（`cloud-sync.js` + `user_state` 集合）
- **单设备 claim 模型**：云端 doc 持有 `sessionId`，谁的 ID 匹配谁能写
- `app.onLaunch` 异步 `hydrate()`：云端比本地新就 overlay 同步字段；sessionId 不匹配弹 modal「用此设备 / 只读浏览」
- 每个 tab 页 `onShow` 调 `hydrateIfStale()`（30s 防抖；launch hydrate 还在 in-flight 时 await 同一个 promise，避免 race）
- `saveState` 触发 200ms 防抖 push（拖拽 / 秒针 tick 不会刷爆云端）
- 只读模式下 `updateState` 直接 return，4s 节流 toast

### 3.5 同步白名单（`SYNC_FIELDS`）
同步 `notebooks / tasks / coins / streakDays / perfectDays / bonusByDay / pendingShareCoins / pet / lastReward / profile / testCoinsGranted`。OCR 任务、UI 临时态、静态配置（rewardRules / shopItems）都本地保留。

要点：
- `profile` 在白名单里是为了让分享发送方的昵称（和头像 fileID）跟着用户跨设备走
- `pendingShareCoins` 同步是为了避免同账号在另一台设备上重复领取
- `testCoinsGranted` 是一次性测试金币标记，同步避免重装/换机重复发

### 3.6 性能要点
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
- 多 provider 调用：OpenAI Vision → 腾讯云 OCR（GeneralHandwriting → Accurate → Basic）→ 微信 OpenAPI → Tesseract.js 兜底
- 按规则拆分为草稿列表

### 当前状态
- 真实闭环已通：腾讯云 OCR 子用户 AKSK + `QcloudOCRFullAccess`，环境变量配齐
- 多 provider 兜底：OpenAI Vision → 腾讯云 OCR（GeneralHandwriting → GeneralAccurate → GeneralBasic）→ 微信 OpenAPI → Tesseract.js
- OCR job 数据当前仅在本地 store 留最近 10 条历史，未落库
- 失败重试 / 配额耗尽提示不细，无 multi-provider 并行合并能力

---

## 5. 云数据库

### 在用集合：`user_state`

详见 `CLOUD-SETUP.md` 末尾的「跨设备数据同步」章节。要点：
- 一个 `_openid` 一条文档，整个用户 state 打包存在 `state` 字段里
- 文档结构：`{ _id, _openid, state, sessionId, claimedAt, updatedAt }`
- 权限「仅创建者可读写」，`_openid` 自动注入，无需云函数代理
- 单文档存全状态：取舍是简单 + 写就是 replace；多设备并发由「单设备登录」机制规避

### 设计草案（未实现）

`CLOUD-DATA-NOTES.md` 里有更规范化的多表方案：`users / families / children / homeworkTasks / coinLogs / pets / shopOrders / ocrJobs / ocrDraftItems`。当前 v1 故意没采纳，原因：
- 多表化在 MVP 阶段不解决关键问题
- `_openid = 主键` 的单文档模型一行代码就能上云，验证产品价值更快
- 真要做长期分析或多家庭体系时再拆表（届时 `state` 里的 `tasks` / `coinLogs` 等数组就是迁移源）

---

## 6. 为什么当前选择这种方案

### 原因 1：MVP 阶段优先验证产品价值
当前更重要的是尽快验证：
- 家长是否真的愿意用
- OCR 导入是否显著节省时间
- 奖励 + 宠物机制是否有持续动力

### 原因 2：微信云开发适合当前阶段
- 不需要先搭独立后端
- 接小程序更顺
- 适合快速原型和 MVP 演进

### 原因 3：单文档同步比多表 ORM 简单 10 倍
- 写就是 replace，读就是 get
- 单设备占用避开了多设备并发合并问题
- 数据结构变更不需要数据库迁移
- 真正需要长期分析时再拆表，届时单文档里的 `tasks / coinLogs` 等数组就是源

---

## 7. 当前技术风险

- **单设备 claim 模型**：同账号多设备同时操作时只有一个能写。如果以后要协同（家长 + 孩子同时改），需要换合并 / CRDT 模型
- **同步粒度是整个 SYNC_FIELDS 子集**：每次 push 是整段 JSON 覆盖，不是 field-level patch，离线长时间后回到线上做差量合并会比较粗糙
- **OCR 配额有限**：腾讯云每接口 1000 次 / 月免费，正式上线前要看付费方案
- **云数据库 `user_state` 单文档体积上限**（约 2MB）：一年量级的 task 不至于，但作业本 / 任务无限增长时需要拆表
- **多孩子 / 多家庭账号体系**还没设计，要做时需要 `user_state` 模型再分裂
- **「用此设备」会丢失本机最近 200ms 内的写入**
- **极限规模未真机验证**：bench 是 1000 本 × 5 任务、365 天 backlog 在 Node 上跑的，真机引擎慢 3-5×；超过这个量级需要分页 / 虚拟列表

---

## 8. 下一步建议

1. **OCR 识别质量调优**：多 provider 并行合并、把腾讯云 confidence 字段纳入 `needsConfirm` 判定
2. **OCR 错误码分级 + provider 来源 + 置信度展示**：现有 `errorCode` 已传到端，前端没分级展示
3. **数据模型分表**：当前同步是把 `tasks` 数组整段推。等数据更大时拆成 `tasks` 集合，按 `notebookId` 索引；`coinLogs / ocrDraftItems` 也独立沉淀
4. **多家庭 / 多孩子账号**：当前 sessionId 只能识别同账号下哪台设备活跃，没有「孩子身份」概念
5. **离线写入队列**：断网累积，联网批量 push
6. **「用此设备」前先 push 本机一次**：减少切换时数据丢失
7. **作业本 / 作业列表的虚拟滚动**：极端规模下渲染层会成为新瓶颈

---

## 9. 一句话结论

当前实现已经从早期原型走到「可上线灰度」前夜：OCR 真闭环已通，云同步落地（单设备 claim 模式），核心热点路径已优化到 1000 本规模可用。下一步是 OCR 识别质量、错误处理细化、配额评估，以及账号体系扩展到多孩子 / 多家庭。
