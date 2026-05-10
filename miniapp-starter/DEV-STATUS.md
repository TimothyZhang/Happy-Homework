# 开发状态说明

本文档说明 `miniapp-starter` 当前到底已经做到了哪一步,哪些是真实链路,哪些仍然待完成。

## 当前项目阶段

> **OCR 真实闭环已跑通的早期 MVP**
>
> 拍照 → 上传云存储 → 云函数调腾讯云 OCR → 拆草稿 → 导入作业 这条主链路真实可用。

它已经从"强原型"进入"可验证 MVP"阶段,但还没有正式上线版本所需的容错和数据架构。

最近一次端到端验证:**2026-04-29 凌晨**(手写体优先模型生效,详见 `CLOUD-SETUP.md`)。

跨设备数据同步已于 **2026-05-10** 接入云数据库 `user_state` 集合(单设备登录模型,见 `CLOUD-SETUP.md` 末尾章节)。

---

## 一、已经完成的内容

### 1. 小程序整体骨架
项目已经具备完整的小程序基础结构:
- 全局配置 `app.js / app.json / app.wxss`
- 多页面结构 + TabBar 导航
- 基础视觉风格

### 2. 核心产品主链路原型
已实现以下主链路的前端交互:
- 首页总览(今日进度、金币、宠物状态、快捷入口)
- 作业列表(增删改、状态流转)
- 排期页 / 宠物页 / 统计页 / 个人页

### 3. 作业管理基础逻辑
- 新增 / 编辑 / 删除作业
- 标记进行中 / 已完成
- 展示计划时间与预计时长

### 4. 奖励与宠物反馈
- 完成作业获得金币
- 全部完成额外奖励
- 购买宠物道具
- 宠物成长/开心/饱腹值变化、升级反馈

### 5. OCR 导入链路 — **真实闭环已通**
- `pages/ocr-import`:拍照 / 相册导入 / 演示数据,真实 `wx.cloud.uploadFile` + `wx.cloud.callFunction`
- `pages/ocr-result`:识别结果确认、删除、新增、导入
- `cloudfunctions/homeworkOCR`:已部署,**真实调用腾讯云 OCR**
  - 子用户 `happy-homework-ocr` + `QcloudOCRFullAccess` 策略
  - 环境变量 `OCR_SECRET_ID` / `OCR_SECRET_KEY` / `OCR_REGION` 配置完毕
  - 云开发环境 `cloud1-d8gkzu6ls85efd509`
- 多 provider 兜底:OpenAI Vision OCR → 腾讯云 OCR(**GeneralHandwriting** → GeneralAccurate → GeneralBasic 顺序回退)→ 微信 OpenAPI → Tesseract.js

### 6. 跨设备数据同步 — **真实闭环已通**
- `utils/cloud-sync.js`:云数据库 `user_state` 集合 + 单设备登录模型
  - 启动时 `wx.cloud.database().collection('user_state').get()` 拉云端
  - 每次 `saveState` 200ms 防抖 push(白名单字段:`notebooks / tasks / coins / streakDays / bonusCoins / pet / lastReward`)
  - 每个 tab `onShow` 30s 防抖 hydrate(in-flight 时 await 同一 promise,避免 launch race)
- 单设备占用:云端 doc 持有 `sessionId`,与本机不一致时弹 modal「切到此设备 / 只读浏览」
- 只读模式下 `updateState` 直接 return,4s 节流 toast 提示
- 「我的」页面有「数据同步」卡片:状态 pill + 「立即同步 / 切回此设备」按钮
- 集合权限「仅创建者可读写」,`_openid` 自动过滤,无需云函数

### 7. 自定义 tabBar + 子包预热 — UI/perf
- `tabBar.custom: true` + `custom-tab-bar/` 组件,字号从平台默认 ~20rpx 增至 30rpx
- `pkg-notebook/notebook-edit/` 拆为子包,`preloadRule` 配置在用户进 home/tasks/calendar/notebook-detail 时预热
- `utils/store.js` 进程内缓存,消除每次 `onShow` 的 `wx.getStorageSync` + JSON.parse
- 日历 tab 的月历格子构建用 `wx.nextTick` 延后,首屏 chrome 先出

---

## 二、当前仍未完成的内容

### 1. OCR 识别质量进一步优化
手写体已经调到第一位,实测对作业登记本场景识别明显更准(如 "17课生字、抄书本" 替代了印刷体模型的 "17元",合并出 "改错明天交")。下一步可继续:
- **多 provider 并行 + 结果合并**:当前是"前一个失败才试下一个",可以改成两个 provider 并行调,取识别行数最多的合并展示(配额翻倍但识别完整度更高)
- **细化 needsConfirm 的判定**:目前只用"是否识别到科目"标记,可以把腾讯云返回的 confidence 字段也纳入

### 2. 多家庭 / 多孩子账号体系
当前云数据库 `user_state` 集合按 `_openid` 一对一,即一个微信号 = 一份完整状态。
- 家长和孩子若用同一个微信号 → 数据共用(目前的预期)
- 家长 / 孩子分别用不同微信号 → 各自独立,无法关联
- 暂无家庭聚合 / 多孩子切换的能力

`coinLogs / ocrDraftItems` 这些「日志型」数据当前没有独立持久化,只在 `user_state.state` 里取最新快照。要做长期统计需要拆出来单独建集合。

### 3. 跨设备同步的边角
- 「切回此设备」会以云端覆盖本机,本机最近 200ms 内未推送的写入会丢
- 进入只读后,目前要重启 app 才能再次弹「切回此设备」modal(`_conflictAcknowledged` 在内存里)。「我的」页面有「立即同步 / 切回此设备」按钮可绕过
- 离线时 push 静默失败,联网后等下一次 `saveState` 才会重试,没有显式离线队列

### 4. 线上级异常处理仍不足
- OCR 失败后的精细化错误提示(目前都弹"识别失败" modal,没区分 errorCode)
- 重试机制
- 图片上传失败分类处理
- 导入后的任务去重与清洗

### 5. 容量与计费
- 腾讯云 OCR 免费额度有限(每个接口约 1000 次/月),正式上线前需评估付费方案
- 微信 OpenAPI OCR 免费额度更有限,实际意义不大
- Tesseract.js 离线兜底默认关闭(开启会显著增加冷启动时长 + 内存)

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
- **业务状态持久化 + 跨设备同步**(云数据库 `user_state` 集合,本地缓存 + 云端镜像)
- 自定义 tabBar / 子包预热 / 月历延迟构建等 UX/perf 优化

### 仍然是 mock / 原型的部分
- 多家庭、多孩子账号体系(目前一个 openid = 一份独立 state)
- `coinLogs / ocrDraftItems` 等日志型数据的长期沉淀(只有最新快照)
- 完整线上化容错能力(重试 / 限流处理 / 错误分级)
- OCR 识别质量(对手写登记本仍偏弱)

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

### 第一优先级
- 真实跑 5-10 张不同登记本照片(光线好/差、字迹工整/潦草、单页/双页混排),记录命中率和拆分准确率作为基线
- 看是否需要补"多 provider 并行合并"或"OCR confidence → needsConfirm" 这两步

### 第二优先级
- OCR 错误码分级提示(对应 `cloudfunctions/homeworkOCR/index.js` 已有的 errorCode)
- 失败重试 / 配额耗尽提示
- 前端展示 OCR provider 来源 + 置信度

### 第三优先级
- 把 `coinLogs / ocrDraftItems` 拆出来单独建集合做长期沉淀(目前只在 `user_state` 里取最新快照)
- 离线写入队列 + 网络恢复后批量 push
- 多孩子 / 多家庭账号体系(若产品方向需要)
- 「切回此设备」前先 push 本机一次,减少切换时数据丢失

---

## 六、一句话结论

`miniapp-starter` 现在是一个产品骨架完整、OCR 主链路 + 跨设备同步均真实可用的 MVP,可以拿给真实家长试用;下一步的关键是 **OCR 识别质量调优** 与 **错误处理细化**,让它从"MVP"进入"可上线产品"。
