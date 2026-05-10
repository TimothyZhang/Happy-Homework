# 技术说明

本文档用于快速说明 `miniapp-starter` 的当前技术结构，方便后续继续开发、交接或上传到 GitHub 后阅读。

## 1. 项目结构

```text
miniapp-starter/
├── app.js                  # 全局：cloud.init + cloud-sync.hydrate
├── app.json                # 含 tabBar.custom + subpackages + preloadRule
├── app.wxss
├── pages/                  # 主包页面
│   ├── home/               # 首页：当日作业列表 + hero stats
│   ├── tasks/              # 作业本管理（notebook 列表、拖拽）
│   ├── calendar/           # 日历（月历格子 + 当日详情）
│   ├── notebook-detail/    # 作业本详情：按学科分组 + 增删改
│   ├── pet/                # 宠物
│   ├── profile/            # 我的（含数据同步卡片）
│   ├── stats/              # 学习统计
│   ├── ocr-import/         # OCR 上传页
│   └── ocr-result/         # OCR 草稿确认页
├── pkg-notebook/           # 子包：notebook-edit（被 home/tasks/calendar/notebook-detail preload 预热）
│   └── notebook-edit/
├── custom-tab-bar/         # 自定义 tabBar 组件（字号 30rpx，比平台默认大）
├── components/
│   └── task-list/          # 任务行组件（拖拽 + swipe-to-revert）
├── utils/
│   ├── store.js            # 业务状态 + 进程内缓存 + saveState 触发云推送
│   ├── cloud-sync.js       # 云数据库同步：单设备 session 占用模型
│   └── navigation.js
├── cloudfunctions/
│   └── homeworkOCR/        # OCR 云函数（腾讯云 / OpenAI / 微信 OpenAPI 多 provider）
├── README.md
├── V1-PRD-homework-pet.md
├── V1-PRD-homework-register-ocr.md
├── CLOUD-DATA-NOTES.md
├── CLOUD-SETUP.md          # 含 user_state 集合配置说明
├── DEV-STATUS.md
└── PRODUCT-DOCS-INDEX.md
```

---

## 2. 页面结构

### `pages/home`
首页，负责展示：
- 当日作业列表（按 `tasksForDate` 计算，含未完成 / 已完成两段）
- Hero stats：今日总数 / 待完成 / 预计还需时间
- 日期切换器（昨日 / 今日 / 明日 / 任意 picker）

### `pages/tasks`
作业本管理页，负责：
- 列出所有作业本（一次性 / 重复 / 长期）
- 长按拖拽重排
- 跳转「+ 新建作业本」（→ 子包 `pkg-notebook/notebook-edit`）
- 点击进入「作业本详情」

### `pages/calendar`
日历页，月历格子（含每天的作业数 / 已完成数 / overdue 标记）+ 选中日详情。月历构建用 `wx.nextTick` 延后，首屏 chrome 先出。

### `pages/notebook-detail`
作业本详情页（结构管理视图）：
- 任务**按学科分组**（语文/数学/英语...），分组内拖拽
- task 行不显示「开始」按钮（这页不是执行视图，pause/resume/finish 仍可用）
- 底部 action stack：+ 新增作业 / 编辑作业本 / 分享 / 复制 / 删除

### `pages/pet`
宠物页，宠物成长与道具购买反馈。

### `pages/profile`
我的页，含：
- 家庭设置（基础占位）
- 学习统计入口
- **数据同步卡片**（状态 pill + 「立即同步」/「切回此设备」按钮）

### `pages/stats`
统计页，今日完成 / 金币 / 历史。

### `pages/ocr-import` / `pages/ocr-result`
OCR 上传 + 草稿确认链路（详见 `V1-PRD-homework-register-ocr.md`）。

### `pkg-notebook/notebook-edit`（子包）
新建 / 编辑作业本表单。挪到子包是为了让 `preloadRule` 在用户进 home/tasks/calendar/notebook-detail 时后台预热它，第一次点「+ 新建作业本」不卡。

---

## 3. 状态管理

`utils/store.js` 维护业务状态，没有引入 Redux/MobX 之类的框架。当前架构：**进程内缓存 + 本地 storage 落盘 + 云数据库镜像**。

### Store 持有的字段

```js
{
  schemaVersion, updatedAt,
  notebooks, tasks,                       // 业务核心
  coins, streakDays, bonusCoins,           // 奖励
  pet, lastReward,                          // 宠物
  rewardRules, shopItems,                  // 静态配置
  editTaskId, editNotebookId,              // 编辑态（UI 临时）
  ocrCurrentJob, ocrJobs                   // OCR 临时态
}
```

### 三层结构

1. **进程内缓存** `_stateCache`：第一次 `loadState` 后所有读直接返回，消除每次 `onShow` 的 `wx.getStorageSync` + `migrateState` 开销。
2. **本地 storage** (`wx.setStorageSync('homework-pet-v1', ...)`)：每次 `saveState` 同步落盘，下次启动恢复。
3. **云数据库** (`utils/cloud-sync.js`)：每次 `saveState` 200ms 防抖 push 到 `user_state` 集合。`SYNC_FIELDS` 白名单决定哪些字段上云（`notebooks / tasks / coins / streakDays / bonusCoins / pet / lastReward`）；OCR 任务、UI 临时态、应用级配置不上云。

### 写入流程

`updateState(updater)` → 检查 `cloudSync.isReadOnly()`（被踢则 toast + 不写） → `clone + updater` → 盖 `updatedAt = Date.now()` → `saveState`（写 cache + storage + 触发 push）。

### 同步流程

详见 `utils/cloud-sync.js` 注释 + `CLOUD-SETUP.md` 的「跨设备数据同步」章节。要点：
- 启动时 hydrate，云端有更新就 `applyHydratedState` 覆盖本地（不触发 push）
- 每个 tab `onShow` 调 `hydrateIfStale`（30s 防抖），launch hydrate 还在 in-flight 时 await 同一个 promise
- 单设备占用：云 doc 持有 `sessionId`，与本机不一致弹 modal「切到此设备 / 只读浏览」
- 只读模式下 `updateState` 直接 return，4s 节流 toast

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

### 当前不足
- OCR job 数据没独立持久化（只在 `state.ocrCurrentJob / ocrJobs` 里取最新快照）
- 失败重试 / 配额耗尽提示不细
- 无 multi-provider 并行合并能力

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

- OCR 服务计费上限（腾讯云免费额度有限）
- 云数据库 `user_state` 单文档若超 2MB 会写失败（一年量级的 task 不至于）
- 多孩子 / 多家庭账号体系还没设计，要做时需要 `user_state` 模型再分裂
- 「切回此设备」会丢失本机最近 200ms 内的写入

---

## 8. 下一步建议

1. OCR 错误码分级提示（已有 errorCode，前端没用）
2. OCR provider 来源 + 置信度展示
3. `coinLogs / ocrDraftItems` 拆出来单独建集合做长期沉淀
4. 离线写入队列（断网累积，联网批量 push）
5. 「切回此设备」前先 push 本机一次（减少切换时数据丢失）

---

## 9. 一句话结论

当前技术实现已经支持产品演示 + 跨设备同步 + OCR 真实闭环，工程化分水岭在于 OCR 错误处理细化与日志型数据的独立沉淀。
