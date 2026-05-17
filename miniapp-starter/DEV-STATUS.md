# 开发状态说明

本文档说明 `miniapp-starter` 当前到底已经做到了哪一步,哪些是真实链路,哪些仍然待完成。

## 当前项目阶段

> **OCR 真实闭环 + 跨端云同步 + 大规模数据已优化的可灰度 MVP**
>
> 拍照 → 云函数 OCR → 拆草稿 → 导入；本地状态 → user_state 集合 → 跨端 hydrate；1000 个作业本/5000+ 个作业的目标场景下主要热点路径已做 O(N+M) 改造。

它已经从"强原型"走过"可验证 MVP",当前更接近「可灰度上线」前夜:核心闭环已通,但账号体系（多家庭/多孩子）和 OCR 计费方案尚未铺开。

最近一次端到端验证:**2026-04-29 凌晨**(手写体优先模型生效,详见 `CLOUD-SETUP.md`)。

跨设备数据同步已于 **2026-05-10** 接入云数据库 `user_state` 集合(单设备登录模型,见 `CLOUD-SETUP.md` 末尾章节)。

---

## 一、已经完成的内容

### 1. 小程序整体骨架
项目已经具备完整的小程序基础结构:
- 全局配置 `app.js / app.json / app.wxss`
- 主包 + `pkg-notebook` 分包,带 preloadRule 预热
- 自定义 `custom-tab-bar`(每 tab 页 onShow 同步 selected index)
- 基础视觉风格

### 2. 核心产品主链路原型
已实现以下主链路的前端交互:
- 首页(`pages/home`):按选定日期展示作业行,跨作业本拖拽,backlog 露出
- 作业本列表(`pages/tasks`):按结束日期倒序,长期重复本浮顶
- 作业本结构页(`pages/notebook-detail`):作业按学科分组,组内可拖拽;纯结构视图,不含开始/暂停/完成计时控件(执行操作走首页 / 日历的 task-list 组件)
- 月历(`pages/calendar`):每日完成 / 总数 / overdue 标识
- 排行榜(`pages/leaderboard`):tab 入口
- 宠物页 / 统计页 / 个人页(含数据同步卡片)

### 3. 作业管理基础逻辑
- 新增 / 编辑 / 删除作业
- 一次性 + 重复(每日 / 每周指定日)两种作业本
- 重复型作业按 `occurrences[date]` 分日记录状态
- 全局只允许一个作业 `doing`(其他自动 paused)
- 标记进行中 / 已完成 / 误点恢复

### 4. 奖励与宠物反馈
- 完成作业获得金币(单题 5/10/15 + daily-perfect 翻倍 + early-bird + weekly streak)
- 购买宠物道具 → 四属性(开心/饱腹/清洁/健康)变化
- 经验值升级(`getXpForLevel = level × 33 + 87`,XP 满手动点按钮 → 全屏动画);**XP 按时间挂机累计**,速率 = `XP_PER_HOUR_FULL × attrMultiplier(pet)` = `10 × (四属性均值/100)`。完成作业只发金币不发 XP;属性满速 240 XP/天,Lv.99→100 ≈ 14 天

### 5. OCR 导入链路 — **真实闭环已通**
- `pages/ocr-import`:拍照 / 相册导入 / 演示数据,真实 `wx.cloud.uploadFile` + `wx.cloud.callFunction`
- `pages/ocr-result`:识别结果确认、删除、新增、导入
- `cloudfunctions/homeworkOCR`:已部署,**默认走 Azure OpenAI Vision (gpt-5.5, reasoning=none)**
  - Azure 环境变量 `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_VERSION` 配置完毕(deployment 默认沿用模型名)
  - 腾讯云 OCR 兜底用 `OCR_SECRET_ID` / `OCR_SECRET_KEY` / `OCR_REGION`(子用户 `happy-homework-ocr` + `QcloudOCRFullAccess`)
  - 云开发环境 `cloud1-d8gkzu6ls85efd509`
- 多 provider 兜底:OpenAI Vision OCR → 腾讯云 OCR(**GeneralHandwriting** → GeneralAccurate → GeneralBasic 顺序回退)→ 微信 OpenAPI → Tesseract.js
- prompt 按语义拆分,共享前缀传递("17课生字、抄书本" → "17课生字" + "17课抄书本")
- **作业本详情页「📷 拍照识别」按钮**:识别结果直接落到该作业本(而不是默认当日 one-shot),notebookId 经 `store.ocrCurrentJob` 流串

### 6. 跨端云同步 — **真实闭环已通**
- `utils/cloud-sync.js` + 云数据库 `user_state` 集合,单设备 claim 模型
- 同步链路:
  - `app.onLaunch` 异步 hydrate;每个 tab `onShow` 调 `hydrateIfStale()`(30s 防抖,launch in-flight 时 await 同一 promise 避免 race)
  - 每次 `saveState` 200ms 防抖 push 到云
  - 同步白名单 `SYNC_FIELDS` = `notebooks / tasks / coins / coinLogs / streakDays / perfectDays / bonusByDay / completionsByDay / pet / lastReward / profile`(OCR 任务 / UI 临时态 / 固定配置不上云。客户端 = truth,coins / coinLogs 整包随 state push)
- 单设备占用:云端 doc 持有 `sessionId`,与本机不一致时弹 modal「用此设备 / 只读浏览」;只读模式 `updateState` 直接 return + 4s 节流 toast
- 「我的」页面有「数据同步」卡片:状态 pill + 「立即同步 / 用此设备」按钮
- 集合权限「仅创建者可读写」,`_openid` 自动过滤,无需云函数

### 7. 大规模数据性能 — **核心热点已优化**
针对 1000 个作业本 / 5000+ 个作业的目标场景:
- 进程内缓存(`_stateCache`)消除每次 `onShow` 的 `wx.getStorageSync` + JSON 反序列化
- `decorateNotebook` / `pauseAllOtherDoing` / start/pause/finish 等 task 操作:O(N×M) → O(N+M)
- 日历专用聚合器 `dateCountsForMonth`:整月一次扫描,省掉 30 次 `tasksForDate`
- 删掉无人读的 `calcOverview`(原本每次 `getStateWithComputed` 都白跑一次 `tasksForDate(today)`)
- bench / 正确性测试:`scripts/perf-bench.js` / `scripts/perf-correctness.js`(76 项行为对账)

### 8. 自定义 tabBar + 子包预热 — UI/perf
- `tabBar.custom: true` + `custom-tab-bar/` 组件,字号从平台默认 ~20rpx 增至 30rpx
- `pkg-notebook/notebook-edit/` + `pkg-notebook/notebook-task-edit/` 拆为子包,`preloadRule` 配置在用户进 home/tasks/calendar/notebook-detail 时预热
- 日历 tab 月历格子构建在 `wx.nextTick` 延后,首屏 chrome 先出

### 9. 金币 + 流水(客户端 = truth) + 管理员后台 — **已上线**

> 历史:之前试过"服务端账本独占"(`coinLedger` 云函数 + 客户端 `pendingCoinEvents` 异步上报),被一连串 mixed-authority bug 咬过(server commit 队头 poison / hydrate 抹掉 perfectDays / share/admin newBalance 漂移),改回客户端 = truth。

- `state.coins` + `state.coinLogs` 都在 `SYNC_FIELDS`,跟 tasks 一起整包 push 上云。云端只是 mirror,不再有"服务端账本"概念
- 客户端 `applyCoinDelta(state, kind, delta, meta)` 直接改 `state.coins` + append 一条 `coinLogs`(带 `eventId / kind / delta / balanceBefore / balanceAfter / ts / meta`)。task_refund 允许把余额拍负(欠债状态后续 task_reward 先补债)
- 服务端发起的金币(管理员调金币 / 分享被保存)走 inbox 模式:
  - `adminPanel.adjustCoins` 写 `admin_coin_inbox` + `coin_adjustments` 审计
  - `shareReward.credit` 写 `share_rewards_inbox`(好友导入触发 +3)
  - client 在 home `onShow` 时调 `claimAdminCoins` / `claimPendingRewards`,server 返 items + 删 inbox + 写一条 `coin_ledger` 审计(eventId = inbox 行 id 哈希,client retry 会被识别为 alreadyApplied 不重复入账),client 自己走 `applyShareRewardClaim` / `applyAdminCoinClaim` → `applyCoinDelta` 入账
- `pages/admin-detail` + `cloudfunctions/adminPanel`:管理员(`ADMIN_OPENIDS_HARDCODED` + `ADMIN_OPENIDS` env)能查用户列表 / 调金币(写 inbox + 审计)/ 看 `coinLogs`

### 10. 作业本分享 — **真实闭环**
- `pages/notebook-detail` 「📤 分享作业本」按钮调 `onShareAppMessage`:把作业本元数据 + 任务列表 URI-encode 进 share path（`/pages/notebook-share/index?d=...`）
- 接收方点卡片落到 `pages/notebook-share`:解码 → 显示「{发送方昵称}分享给你的作业本」+ 任务预览 → 「💾 保存」走 `store.importSharedNotebook` 生成新本,任务全部 reset 为 todo;支持「📤 分享」转发同 payload
- 「我的」页加了 `<input type="nickname">` 行,点击自动回填微信昵称,不需要手输;`profile.nickname` 入 `SYNC_FIELDS`,跨设备保持一致
- share path 1024 字符兜底:超长(典型 ~30+ 任务)降级到旧 `?id=` 路径(receiver 看不到内容,但发送 UI 不会卡)
- 接收方完全不需要存任何东西,所有数据在 URL 里;**不依赖云存储**(头像受微信隐私限制无法跨设备分享,见下方「不做」)

---

## 二、当前仍未完成的内容

### 1. OCR 识别质量进一步优化
手写体已经调到第一位,实测对作业登记本场景识别明显更准(如 "17课生字、抄书本" 替代了印刷体模型的 "17元",合并出 "改错明天交")。下一步可继续:
- **多 provider 并行 + 结果合并**:当前是"前一个失败才试下一个",可以改成两个 provider 并行调,取识别行数最多的合并展示(配额翻倍但识别完整度更高)
- **细化 needsConfirm 的判定**:目前只用"是否识别到科目"标记,可以把腾讯云返回的 confidence 字段也纳入

### 2. 多家庭 / 多孩子账号体系
跨端同步是基于「同一个微信账号下不同设备」的 sessionId claim 模型,不区分家长/孩子身份:
- 多孩子家庭只能共用一份数据
- 没有「家长查看 / 孩子操作」的权限分层
- 没有家庭成员邀请 / 关联机制
- `ocrDraftItems` 这些日志型数据没有独立持久化,只在 `user_state.state` 里取最新快照(金币事件已经走 `coin_ledger` 集合落库,见下方「服务端金币账本」)

未来如果要做家庭体系,需要在 `user_state` 之上加 `families / children` 关系(`CLOUD-DATA-NOTES.md` 已有草案)。

### 3. 跨设备同步的边角
- 当前 push 是把整段 `SYNC_FIELDS` JSON 推上去,不是 field-level patch:在线没问题,长时间离线后回到线上是 last-write-wins
- 单个 doc 体积随作业数线性增长,极端情况可能撞云数据库 single-doc 体积上限
- 「用此设备」会以云端覆盖本机,本机最近 200ms 内未推送的写入会丢
- 进入只读后,内存里的 `_conflictAcknowledged` 标记防 modal 反复弹,要重启 app 或在「我的」页面手动「用此设备」才能恢复
- 离线时 push 静默失败,联网后等下一次 `saveState` 才重试,没有显式离线队列

### 4. 线上级异常处理仍不足
- OCR 失败后的精细化错误提示(目前都弹「识别失败」modal,没区分 errorCode)
- OCR 重试机制
- 图片上传失败分类处理
- 导入后的任务去重与清洗
- 云同步失败的可视化(目前 profile 页有简单状态,但没区分网络/权限/冲突)

### 5. 分享体验仍有边角
- 接收方页面**不显示发送方头像**:微信侧没有任何 API 让接收方拿到分享者的真实头像 URL(`wx.getUserProfile` 自 2022-10-25 起对所有小程序统一返回灰头像 + 「微信用户」),即使分享方主动授权也救不了。要做必须自己上传到云存储,目前评估「不值得」
- 单条 share path 1024 字符上限,极端大的本(~30+ 任务且 content 较长)会触发降级到旧 `?id=`,接收方看不到内容,目前是静默降级,无 toast 警告
- 没有「我都分享给谁了」/「谁保存了我的本」的可见性,接收方保存后是独立副本,源端改动不会同步过去(这是有意为之 —— 不想引入 follow / sync 复杂度)

### 6. 容量与计费
- 腾讯云 OCR 免费额度有限(每个接口约 1000 次/月),正式上线前需评估付费方案
- 微信 OpenAPI OCR 免费额度更有限,实际意义不大
- Tesseract.js 离线兜底默认关闭(开启会显著增加冷启动时长 + 内存)
- 云数据库读写次数随用户量增长,需评估

---

## 三、项目中的"真"与"假"边界

### 真实存在的部分(可演示也可联调)
- 小程序多页面代码 + 各页面交互
- 作业管理 / 奖励 / 宠物 互动逻辑
- 小程序云开发初始化
- 图片上传到云存储
- 调用云函数入口
- **腾讯云 OCR 真实识别返回**
- 草稿编辑 + 批量导入
- **业务状态持久化 + 跨设备同步**(云数据库 `user_state` 集合,本地缓存 + 云端镜像,单设备 claim,切换设备 modal,只读模式)
- 自定义 tabBar / 子包预热 / 月历聚合器 / 进程内缓存 等 UX/perf 优化
- O(N+M) 热点路径 + bench / 正确性测试

### 仍然是 mock / 原型的部分
- 多家庭、多孩子账号体系(目前一个 openid = 一份独立 state)
- `ocrDraftItems` 等日志型数据的长期沉淀(只有最新快照;`coinLogs` 已落 `coin_ledger`)
- 完整线上化容错能力(重试 / 限流处理 / 错误分级)
- OCR 识别质量(对手写登记本仍偏弱)
- 单 doc 同步粒度(未来大数据量需要拆分)

---

## 四、适合当前阶段做什么

最适合用于:
- 产品方案讨论
- 页面流程演示
- **家长真实使用 OCR 导入路径的体验验证**(MVP 真闭环)
- 技术方案选型确认
- OCR 识别效果实测和调优

不适合直接视为:
- 已完成上线版本(数据没落库、错误处理不细、计费没评估)
- 已交付的正式产品

---

## 五、建议下一步

### 第一优先级:OCR 识别质量调优
- 真实跑 5-10 张不同登记本照片(光线好/差、字迹工整/潦草、单页/双页混排),记录命中率和拆分准确率作为基线
- "多 provider 并行 + 取识别行数最多者合并"(配额翻倍但识别完整度更高)
- 把腾讯云 confidence 字段纳入 `needsConfirm` 判定

### 第二优先级:错误处理 + 计费评估
- OCR 错误码分级提示(对应 `cloudfunctions/homeworkOCR/index.js` 已有的 errorCode)
- 失败重试 / 配额耗尽提示
- 前端展示 OCR provider 来源 + 置信度
- 评估腾讯云 OCR 付费方案 + 云数据库读写次数预算
- 同步失败可视化:网络 / 权限 / 冲突分级

### 第三优先级:账号 / 同步粒度
- 把 `user_state` 拓成 `families / children` 关系(对应 `CLOUD-DATA-NOTES.md` 已有的草案)
- `ocrDraftItems` 拆出来单独建集合做长期沉淀(`coinLogs` 已落 `coin_ledger`)
- 单 doc 同步太粗时,把 `tasks` 拆成集合(按 `notebookId` 索引)
- 离线写入队列 + 网络恢复后批量 push
- 「用此设备」前先 push 本机一次,减少切换时数据丢失

---

## 六、一句话结论

`miniapp-starter` 现在是 OCR 主链路真实可用、跨端云同步落地、核心热点路径已 O(N+M) 改造的可灰度 MVP;下一步的关键是 **OCR 识别质量调优**、**错误处理 + 计费评估**、**多孩子账号体系**,让它从「灰度可用」走向「正式上线」。
