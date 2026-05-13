# 微信云开发接入说明

整条 OCR 链路已经端到端验证通过(2026-04-29 凌晨,手写体优先版本)。本文档既给后人快速复现,也把当时踩过的坑沉淀下来。

## 当前状态

- 小程序端 `wx.cloud.init` / `wx.cloud.uploadFile` / `wx.cloud.callFunction({name: 'homeworkOCR'})` 全链路真实
- 云开发环境:`cloud1-d8gkzu6ls85efd509`
- 云函数 `homeworkOCR` 已部署,**真实调用腾讯云 OCR**(子用户 AKSK + `QcloudOCRFullAccess`)
- 验证方式:在模拟器拍登记本照片,云函数日志显示 `"source":"tencent-cloud-general-handwriting-ocr"`,识别结果与印刷体模型有显著差异(手写部分识别明显更准)

## OCR Provider 优先级(代码逻辑)

`cloudfunctions/homeworkOCR/index.js` 现在按下面顺序尝试:

1. **OpenAI Vision OCR**(若 `OPENAI_API_KEY` 已配,默认开启)
2. **腾讯云 OCR**(本次跑通的路径,默认开启)
   - `GeneralHandwritingOCR` → `GeneralAccurateOCR` → `GeneralBasicOCR` 顺序回退
   - ⚠️ 顺序很重要:作业登记本是手写为主,如果印刷体模型先返回非空(它会抓表头、页码这些印刷字),就直接返回了,手写主体被忽略。
3. **微信云调用 OpenAPI**(`cloud.openapi.ocr.printedText`,默认开启,但通常没有 quota,且只识别印刷体)
4. **Tesseract.js 内置兜底**(默认关闭,需 `ENABLE_BUILTIN_OCR=1`)

可通过 `OCR_PROVIDER` 强制单一通道:`openai` / `tencent` / `wechat`。

## 端到端复现步骤

### 一、腾讯云侧(浏览器,console.cloud.tencent.com)

1. **注册腾讯云账号 + 实名认证**(身份证 + 人脸识别,本人在手机操作)。
2. **CAM → 用户列表 → 新建用户 → 自定义创建**:
   - 类型:`可访问资源并接收消息`
   - 用户名:`happy-homework-ocr`
   - 访问方式:✓ 编程访问;✗ 控制台访问
   - 权限:**`QcloudOCRFullAccess`**(⚠️ 不要选 `QcloudOCRReadOnlyaccess`,见下方坑)
3. **创建完成时记下 SecretId + SecretKey**(SecretKey 只展示一次,推荐"下载 CSV"备份)。

### 二、微信开发者工具侧

1. 打开项目根目录 `miniapp-starter`(不要打开父目录 `happy_homework`)。
2. 工具栏点 ☁️ **云开发** → 开通环境(按量计费,有免费额度)→ 命名(本项目当前用 `happy-homework-prod` 命名风格)。
3. **绑定云函数目录**:
   - 这一步现在已经在 `project.config.json` 里写死:`"cloudfunctionRoot": "cloudfunctions/"`(详情见下方坑)
   - 右键 `cloudfunctions/` → "更换云环境" → 选当前环境
4. 右键 `cloudfunctions/homeworkOCR` → **「上传并部署:云端安装依赖(不上传 node_modules)」**
5. 等部署完(首次会装 `tencentcloud-sdk-nodejs-ocr` + `tesseract.js` 等,~2 分钟)。
6. **部署后务必验证**:云开发面板 → 云函数列表 → 看 `homeworkOCR` 的 "最后更新时间" 是否真的更新到刚才那一刻。微信开发者工具偶尔会**菜单点了但什么都没干**,UI 上没明显错误提示,需要凭"最后更新时间"确认。

### 三、云函数环境变量

在云开发面板 → 云函数 → `homeworkOCR` → **版本与配置** → 环境变量,加:

| Key | Value | 备注 |
|---|---|---|
| `OCR_SECRET_ID` | 子用户 SecretId(`AKID...` 36 字符) | ⚠️ Key 名带下划线,不是 `OCR_SECRETID` |
| `OCR_SECRET_KEY` | 子用户 SecretKey(32 字符) | 同上 |
| `OCR_REGION` | `ap-guangzhou` | 可选,默认 `ap-guangzhou` |

保存。环境变量改完**下次冷启动**自动生效,通常不用手动重新部署。

### 四、验证

模拟器 → 首页 → 「📸 拍照识别」→ 选张图 → 开始识别。

期望:跳到 ocr-result 页,草稿不再是固定 mock 文本,且云函数日志的 `source` 字段是 `tencent-cloud-general-handwriting-ocr`(或 fallback 到 `-accurate-ocr` / `-basic-ocr`)。

可以用云端测试代替,但要传一个**还存在于云存储的** imageFileID(临时 URL 文件会被定期清理,过几小时就 404)。

---

## 踩坑笔记 / 后人避坑

### 坑 1:`TENCENTCLOUD_*` 前缀被微信云开发保留

环境变量直接命名 `TENCENTCLOUD_SECRETID` / `TENCENTCLOUD_SECRETKEY` 会**保存失败**,报:
> `环境变量Key包含前缀SCF_、QCLOUD_或TENCENTCLOUD_,请修正后重试`

这三个前缀是腾讯云 SCF 平台保留的,运行时会自动注入(给云函数运行角色用)。所以业务自定义凭据**必须用 `OCR_*` 这种独立前缀**。

代码里 `getCredential()` 已支持 `OCR_SECRET_ID` 优先。

### 坑 2:`OCR_SECRETID` vs `OCR_SECRET_ID` 看起来太像

代码读的是带下划线的 `OCR_SECRET_ID` / `OCR_SECRET_KEY`(SECRET 和 ID/KEY 之间一个 `_`)。
配成 `OCR_SECRETID`(无下划线)就读不到,会 fallback 到 SCF 自动注入的 `TENCENTCLOUD_SECRETID`,然后报 `OCR_PERMISSION_DENIED`(那个角色没 OCR 权限)。

### 坑 3:子用户 AKSK 和 SCF 自动 SessionToken 混用 → `AuthFailure.TokenFailure`

`getCredential()` 早期版本会同时把:
- `OCR_SECRET_ID`(子用户的永久 AKSK)
- `TENCENTCLOUD_SESSIONTOKEN`(SCF 注入的运行角色临时 token)

拼成一个 credential 喂给腾讯云 SDK。腾讯云一看 token 不属于这对 AKSK,直接拒。

修复:`getCredential()` 已经改成"用户配了 OCR_* 时只用 OCR_*,不再 fallback 到 TENCENTCLOUD_SESSIONTOKEN"。详见 [`index.js`](cloudfunctions/homeworkOCR/index.js) 该函数注释。

### 坑 4:`QcloudOCRReadOnlyaccess` 描述误导

策略描述里写"包含调用所有OCR接口",看着像是能调识别 API 的。**实际不能** —— 它只允许 Describe/List 类读取接口,**不允许 `ocr:GeneralBasicOCR / GeneralAccurateOCR / GeneralHandwritingOCR` 这类识别 API**。

子用户**必须用 `QcloudOCRFullAccess`**,或者写自定义策略只授 `ocr:Generalxxx` 这几个 action。

### 坑 5:`project.config.json` 缺 `cloudfunctionRoot`

如果没这个字段,`cloudfunctions/` 在微信开发者工具里只是一个普通文件夹,**右键菜单里没有"上传部署"选项**。

修复:`project.config.json` 顶层加 `"cloudfunctionRoot": "cloudfunctions/"`。已经写进去了。

### 坑 6:打开错项目根

如果在微信开发者工具里"导入项目"时选了 `happy_homework` 父目录(包含 `miniapp-starter` / `weapp-demo` / `skills` 等),会报"找不到 app.json",且 `cloudfunctions/` 也不在根。**必须选 `miniapp-starter` 子目录**作为项目根。

### 坑 7:右键"上传并部署"可能静默失败

观察到一次:右键菜单点 `上传并部署:云端安装依赖`,菜单关闭,**没有任何错误提示也没有进度提示**,云端函数最后更新时间没动。第二次再点同样的菜单就成功了,差异未明。
**应对**:每次部署后去云开发面板验证"最后更新时间",别凭直觉认为成功。

补充(2026-05-12):重启开发者工具或换设备后,`cloudfunctions/` 上的**云环境绑定可能会丢**。
右键 `cloudfunctions/`,如果看到 `当前环境: (无)`,菜单里的部署项会显示成 "**创建并部署**"(而不是 "**上传并部署**"),**点了之后会全程静默失败**(没有任何提示)。
**应对**:每次开始部署前先扫一眼右键菜单顶部的 `当前环境: xxx`。是 `(无)` 就先选 `cloud1`,菜单文字会改成 "上传并部署",这时再点才生效。

### 坑 8:云函数 timeout / 内存配置不会随 deploy 推到云端

`cloudfunctions/<fn>/config.json` 里的 `timeout` / `memorySize` 改了之后,
**右键"上传并部署"不会把这些字段同步到云端**,只推代码 + 装依赖。要改运行配置:
- 云开发面板 → 云函数 → 选函数 → **版本与配置 → 配置 → 高级配置**,手动改超时时间/内存
- 该面板的"超时时间"上限是 **60 秒**(免费档/默认档),想要更长得提工单升档
所以本仓库默认走 `reasoning.effort: 'none'`(实测 12s,留出足够余量到 60s 上限),
而不是 'low'(本身效果更稳的 17s,但冷启动 + 图下载常常会撞 60s)。

### 坑 9:云函数 OCR 调用顺序对识别质量影响很大(代码层面)

`recognizeWithTencentOcr` 的 providers 数组**第一个返回非空就停**,不会把多个结果合并对比。所以顺序就是优先级:

| 顺序 | 适用场景 |
|---|---|
| `Handwriting` 第一(当前) | 作业登记本、孩子手写笔记、混排照片 |
| `Accurate` 第一 | 印刷体为主的资料(讲义、试卷题面) |
| `Basic` 第一 | 极简文本场景(很少用,精度不如前两者) |

如果想要"两个都跑然后取更长的",得改循环逻辑(收集所有 result,取 line count 最多的)。本次没做,留作后续 V2。

---

## 客户端工具问题(供后人避免重复踩坑)

### macOS computer-use 点击在双显示器/休眠态显示器下被误判

宿主环境:macOS 26.3 + Apple M5 Pro + Claude.app `1.5354.0` + computer-use MCP

症状:`left_click` 任何坐标都被报"会落在 Dock"或"通知中心",但实际点位是 WeChat 开发者工具窗口内部。

根因(综合):
- DELL 外接显示器即使物理"关电源"但**信号线还插着**,macOS 仍维护其桌面坐标空间(`Online: Yes` + `Display Asleep: Yes`),导致内建屏点击被误路由
- Claude.app 自动更新会**重置 macOS 辅助访问权限**(GitHub issue [#46859](https://github.com/anthropics/claude-code/issues/46859))
- 即便所有显示器只剩内建一块,且 Claude 重启过,仍可能稳定失败 —— 工具的 frontmost-app 检测没用到正确的 macOS 私有 API

绕过办法:
1. **WeChat 开发者工具进入 fullscreen**(其它窗口完全不可见)→ 点击恢复正常
2. 把窗口拖到 DELL 这种外接屏使用 → 其上的点击不受这个 bug 影响
3. 重新走系统设置 → 隐私与安全 → 辅助功能 / 屏幕录制 移除再加 Claude → 退出 Claude 重开

跨显示器空间切换:
- `ctrl+left/right` 在 fullscreen 应用之间切换桌面空间
- 但被设为 read-tier 的应用(如 Chrome)在前台时,键盘动作会被工具拒掉。先 `open_application` 切到 full-tier 应用再发 ctrl+arrow

---

## 真正还差什么(已更新)

OCR 链路本身已通,识别质量经过手写体优先调整后明显改善。仍可继续:

- ~~**本地状态迁云数据库**~~:已通过 `utils/cloud-sync.js` 接入(详见下方)。
- **错误分类提示**:云函数返回的 `errorCode` 已经分得比较细(`OCR_PERMISSION_DENIED` / `AuthFailure.TokenFailure` / `OCR_RATE_LIMITED` / `OCR_EMPTY_RESULT` / `DOWNLOAD_FILE_FAILED`),但前端 `pages/ocr-import` 现在统一弹"识别失败" modal,可以按 errorCode 给不同提示文案。
- **多 provider 结果合并**:当前 fallback 是"前一个失败才试下一个"。可以改成"并行调,取识别行数最多的"(代价是配额翻倍)。
- **可观测性**:云函数日志能看到 `Tencent OCR provider failed` 的具体 action 和 requestId,但前端只看到最终结果。考虑把 `providerWarning` 字段在 ocr-result 页面以 toast 形式展示给开发者(用户态可隐藏)。
- **OCR 用量监控**:腾讯云 OCR 免费额度有限,接近上限时要提醒,可以考虑加云监控告警或在云函数里自记 invocation count 落 CloudBase。

## 跨设备数据同步(`user_state` 集合)

`utils/cloud-sync.js` 把整个用户 state 同步到云数据库,实现**单设备登录**(切换设备时旧设备只读)。

### 一次性配置(必须做,否则 hydrate/push 都会静默失败)

1. 微信开发者工具 → ☁️ 云开发 → 进入控制台 → **数据库**。
2. **新建集合**,名字必须是 `user_state`(代码里硬编码,见 `utils/cloud-sync.js` 顶部的 `COLLECTION`)。
3. 点击该集合右侧 → **权限设置** → 改成 **「仅创建者可读写」**。
   - 这样 `_openid` 自动注入,`get()` 只返回当前用户自己的文档,无需写云函数。

### 运行时行为

- `app.onLaunch` 异步 `hydrate()`:云端无 doc → 用本机 state 创建并占用 sessionId;云端 sessionId 是别人 → 弹 modal「用此设备 / 只读浏览」。
- 每个 tab 页 `onShow` 调 `hydrateIfStale()`(30s 防抖,且 launch hydrate in-flight 时会 await 它)。被踢的设备能在切 tab 时及时收到提示。
- 任何 `updateState` 触发的写入会经 200ms 防抖 push 到云。push 影响行数=0 → 弹被踢 modal。
- 只读模式下 `updateState` 直接返回旧 state,4s 内最多弹一次 toast 提示。

### 数据范围

同步:`notebooks / tasks / coins / streakDays / perfectDays / bonusByDay / pendingShareCoins / pet / lastReward / profile`
仅本地:`editTaskId / editNotebookId / ocrCurrentJob / ocrJobs / shopItems / schemaVersion`

(白名单写在 `utils/store.js` 的 `SYNC_FIELDS` 常量。)

### 已知限制

- LWW 不会发生(单设备约束),但「用此设备」会丢掉本机最近 200ms 内未推送成功的写入(以云端为准)。
- 进入只读后,目前只能 kill app 重新进才能再次弹「用此设备」modal(按 `_conflictAcknowledged` 在内存里),后续可加常驻 banner 优化。
