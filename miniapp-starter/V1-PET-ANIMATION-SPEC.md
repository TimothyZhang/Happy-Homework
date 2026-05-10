# V1 — Pet Animation Spec

> 第一版"丰富宠物动画"方案。鹦鹉 🦜 已作为原型跑通,本文档把流程沉下来,
> 后续 8 种宠物按"如何为新宠物加动画"小节加即可。

落地代码:
- 状态机:[pages/pet/index.js](pages/pet/index.js)
- 视觉规则:[pages/pet/index.wxss](pages/pet/index.wxss)
- WXML 模板:[pages/pet/index.wxml](pages/pet/index.wxml)
- 拆分后的鹦鹉 SVG:[assets/pets/](assets/pets/)
  - **正面**(idle/sleeping/celebrating):`parrot-body.svg` / `parrot-head.svg` / `parrot-eyes.svg` / `parrot-wing-left.svg` / `parrot-wing-right.svg`
  - **侧面**(walking/flying/eating):`parrot-side-body.svg` / `parrot-side-head.svg` / `parrot-side-eye.svg` / `parrot-side-wing.svg` / `parrot-side-leg-front.svg` / `parrot-side-leg-back.svg`
- 跨页触发载体:[app.js](app.js) 的 `globalData.petAnimQueue`

---

## 1. 设计原则

1. **每只宠物有"多组真正会动的动作"**,不再只是 idle 单调晃动。
2. **动画用纯 WXSS keyframes + class 切换驱动**,不引入第三方动画库。
   `setData({ currentAnim })` → 父 view class 变化 → CSS 重新匹配规则。
3. **SVG 拆分到能独立动的部位**:身体 / 头 / 眼睛 / 双翅各一个图层,
   每层 viewBox 与原始 SVG 保持一致(均为 `0 0 200 200`),
   通过 CSS `transform-origin` 把旋转中心钉在身体相对位置(百分比)。
4. **只动一只眼睛/一只翅膀** 这种局部动画,通过为 part 单独设
   `transform-origin` 实现;**整体位移**(走、飞)放在外层容器。
   两层独立元素分担 transform,避免 keyframes 互相覆盖。
5. **被动动画(idle/walking/flying/sleeping)** 由内部定时器随机切换,
   **主动动画(eating/celebrating)** 由 `queueAnim()` 触发并具有最高优先级。
6. **视角随动作切换(§1.1)**:不同状态使用不同的 rig(正面 / 侧面 /
   3D 模拟),让宠物看起来是有体积的而不是一张纸片。

---

## 1.1 视角(perspective)

正面平面图(单层)在"原地呼吸 / 睡觉"时最可爱,但当宠物开始走、飞、
低头啄食时正面 rig 完全没有方向感和立体感。所以 V1 给鹦鹉额外画了一套
**侧面 rig**,并按动作切换。其它物种暂时只用正面 rig(仅在 idle 类
动作里循环,问题不大)。

| 状态           | 视角                          | 用哪套 rig                    | 为什么                                   |
|---------------|------------------------------|------------------------------|----------------------------------------|
| `idle`        | 正面                          | front (`parrot-*.svg`)        | 大眼睛对玩家最讨喜,呼吸用 scaleY 最自然    |
| `sleeping`    | 正面                          | front                         | 闭眼正脸 + 慢呼吸,正面表达最直观           |
| `walking`     | 侧面(左右翻转)                 | side (`parrot-side-*.svg`)    | 必须看出方向 / 脚步 / 翅膀贴身             |
| `flying`      | 侧面(始终向右)                 | side                          | 翅膀完全张开、看出飞行轨迹                 |
| `eating`      | 斜 3/4(side + perspective rotateY −22°) | side + CSS 透视   | 啄食姿态从斜角更生动,纯侧面太硬             |
| `celebrating` | 正面 + Y 轴 3D 旋转            | front + CSS `rotateY(360°)`   | 旋转一圈视觉上有 3D 感,扁平 sprite 在 90°/270° 自然变成"侧背" |

**实现策略**:正面 + 侧面两套 rig 同时挂在 `.parrot-stage` 里,
通过 `parrot-anim-{{currentAnim}}` class 在 CSS 里 `display: none / block`
切换显示哪一套。侧面 rig 外面再裹一层 `.side-flip`,
walking 时通过 `transform: scaleX(-1)` 在两个直线段上翻转,
让鹦鹉看起来是真的转身。

---

## 1.5 规范动作集 / Canonical Action Set

把鹦鹉摸出来的方法论沉到所有宠物身上:**每个物种都拥有一组规范动作**
(canonical actions),共享同一套状态机、时长契约和触发口径,只是视觉
保真度分两档实现(参见 §1.6)。

### 必备动作(每只宠物都要有,共 6 个)

| 动作          | 类型   | 时长(ms) | 默认视角 | 触发条件                                |
|---------------|--------|---------------|----------|---------------------------------------|
| `idle`        | 循环   | 2800          | 正面     | 默认 / 无干预                            |
| `walking`     | 循环   | 9000          | 正/侧    | 自动循环抽中 / 仅在状态正常时             |
| `sleeping`    | 循环   | 5000          | 正面     | 自动循环抽中(不舒服时概率提升)           |
| `eating`      | 单次   | 1800          | 正/侧    | 用户在商店买"提升 fullness"的食物         |
| `celebrating` | 单次   | 2000          | 正面     | 首页完成作业,跨页 `globalData` 信号      |
| `happy`       | 单次   | 1200          | 正面     | 玩家点击宠物本体                         |

> `happy` 是 V1 标准化新增的:之前 `talking` 在点击时只是嘴边晃,
> 现在统一用 `queueAnim('happy')` 触发一段轻量"被点开心跳一下"反馈,
> 让所有物种点击都有共同的物理回馈。

### 接口契约

- **状态名**:小写英文(`idle` / `walking` / ...),JS `currentAnim` 与 CSS class 共用,大小写敏感。
- **时长**:JS 在 `ANIM_RECIPES[name].duration` 拍板;CSS 的 `animation` 时长 **必须等于** 该值,否则 oneShot 提前/滞后回 idle。
- **类型**:
  - **循环**(`oneShot: false`):自动状态机抽到才播,被 oneShot 抢占。
  - **单次**(`oneShot: true`):由 `queueAnim()` 触发,最高优先级,播完回 idle。
- **触发条件**:见上表。新增触发点应集中在 `pages/pet/index.js` 同一组入口(`queueAnim`),不要散落各页面。
- **视角**:Premium 档可在不同动作切 rig(参见 §1.1);Standard 档全部正面纯 CSS transform,通过 `.pet-figure` 外层 + `.pet-art` 内层两层独立 transform 叠合。

### 物种专属动作

只在合理的物种身上做 1-2 个 signature 即可。所有动作复用同一个
`currentAnim` 通道,JS 不区分,CSS 用 `.species-<id>` 前缀做 override:

| 物种      | 专属动作                | 实现思路                                                  | 档位      |
|----------|------------------------|-----------------------------------------------------------|----------|
| 🦜 parrot | **flying**             | 6 层侧面 SVG rig + 翼大幅扇动 + X 弧线位移                | Premium  |
| 🐤 chicken | **flying**             | 单层 SVG + 大幅 Y 弹 + 整体高频抖(模拟扇翅)              | Standard |
| 🐰 rabbit | **hopping**            | walking 替身,Y 轴大跳 + scaleY 蓄力压缩                  | Standard |
| 🐶 dog    | **wagging**            | idle 叠加,身体小幅 rotate 模拟摇尾,频率快                | Standard |
| 🐱 cat    | **stretch**            | happy 替身,scaleX 1→1.2 拉长 + Y 微沉                    | Standard |
| 🐷 pig    | **rolling**            | celebrating 替身,Z 轴 720° + 大跳 ×1                     | Standard |
| 🐮 cow    | **chewing**            | eating 替身,左右 skewX 模拟磨牙,头身只小幅晃              | Standard |
| 🐑 sheep  | (待补)                 | 单层 SVG,V1 暂用通用 6 件套                              | —        |
| 🦙 alpaca | **gallop**             | walking 替身,频率 ×1.5 + 倾斜 7°                          | Standard |

物种专属是 **替身或叠加**,不引入新的状态枚举:
- "替身"走 `.species-rabbit.pet-anim-walking { animation: pet-anim-hop ... }` —— 同一状态名,CSS 换 keyframe。
- "叠加"走 `.species-dog.pet-anim-idle .pet-art { animation: pet-anim-breath ..., pet-anim-wag ...; }` —— 多 animation 用逗号叠加。

### 每物种动作清单

| 物种      | idle | walking      | eating      | celebrating | sleeping | happy        | 物种专属                   |
|----------|------|--------------|-------------|-------------|----------|--------------|--------------------------|
| 🦜 parrot   | ✓    | ✓ 侧 rig     | ✓ 侧 rig    | ✓           | ✓        | ✓            | `flying`(Premium 侧 rig) |
| 🐱 cat      | ✓    | ✓            | ✓           | ✓           | ✓        | `stretch`    | (`happy` 替身)            |
| 🐶 dog      | ✓ + `wag` | ✓       | ✓           | ✓           | ✓        | ✓            | `wagging`(idle 叠加)     |
| 🐤 chicken  | ✓    | ✓            | ✓           | ✓           | ✓        | ✓            | `flying`                  |
| 🐰 rabbit   | ✓    | `hopping` 替身 | ✓         | ✓           | ✓        | ✓            | `hopping`(walking 替身)  |
| 🐮 cow      | ✓    | ✓            | `chewing` 替身 | ✓        | ✓        | ✓            | `chewing`(eating 替身)   |
| 🐷 pig      | ✓    | ✓            | ✓           | `rolling` 替身 | ✓     | ✓            | `rolling`(celebrating 替身) |
| 🐑 sheep    | ✓    | ✓            | ✓           | ✓           | ✓        | ✓            | —                         |
| 🦙 alpaca   | ✓    | `gallop` 替身 | ✓          | ✓           | ✓        | ✓            | `gallop`(walking 替身)   |

> 表里"替身"列写在动作名后:同一 `currentAnim` 状态触发,CSS 渲染替换。

---

## 1.6 实现分档 / Implementation Tiers

不是每个宠物都要鹦鹉那种 6 层 SVG rig 才能动起来。Standard 档基于
**单层 SVG + CSS transform** 即可覆盖全套规范动作,把 Premium 档保留
给后续按需逐个升级。

### Premium 档(目前仅鹦鹉)
- 多层 SVG —— 正面 + 侧面共 ~11 个 part,每层独立 viewBox/transform-origin。
- 局部动画 —— 头/眼/翅/腿各自旋转 + 平移。
- 真侧面 rig —— 走/飞/吃用侧面 SVG,走路时 `scaleX(-1)` 翻转转身。
- WXSS 类前缀 `.parrot-anim-*`,见 §5。

### Standard 档(其它 8 种)
- 单层 emoji-style SVG(`/assets/pets/<species>.svg`)—— 不再拆分。
- 纯 CSS `transform` 实现 6 个规范动作 + 物种专属。
- 双层 transform 设计:
  - 外层 `.pet-figure` —— 整体位移(走/跳/飞)
  - 内层 `.pet-art`   —— 局部姿态(呼吸/旋转/晃动)
- 共享 keyframes 集中在 [`pages/pet/pet-anim.wxss`](pages/pet/pet-anim.wxss),前缀 `pet-anim-*` 防冲突,见 §5.5。

> Standard 档的视觉定位是"会动且可识别",不强求"动得像鹦鹉"。
> 单层 SVG 能传达的方向感和重量感有限,升级到 Premium 由后续按物种
> by-demand 推进。

---

## 2. 状态列表(鹦鹉 Premium 档,完整 6 状态参见 §1.5)

下表是 Premium 鹦鹉的状态机数值,Standard 档物种沿用相同的 type/duration,
仅 `flying` 是鹦鹉/鸡专属 —— 其它物种不挂这一行。

| 状态           | 类型      | 默认时长(ms) | 触发条件                                    |
|----------------|-----------|---------------|-------------------------------------------|
| `idle`         | 循环      | 2800          | 默认 / 无干预                                |
| `walking`      | 循环      | 9000          | 自动循环抽中 / 仅在状态正常时               |
| `sleeping`     | 循环      | 5000          | 自动循环抽中(不舒服时概率提升)             |
| `flying`       | 单次       | 3500          | 独立计时器 25–40s 一次,健康/清洁正常时      |
| `eating`       | 单次       | 1800          | 用户在商店买"提升 fullness"的食物            |
| `celebrating`  | 单次       | 2000          | 用户在首页完成作业,跨页 `globalData` 信号    |
| `happy`        | 单次       | 1200          | 玩家点击宠物本体(§1.5 新增)                |

> 时长记号 = 一次完整循环或一次单次播放。当被打断(eating / celebrating
> 抢占),当前循环视为播完一次后退场。

---

## 3. 状态机切换规则

```
                    ┌──────────────┐
   onShow ────────► │ _startAnim   │
                    │  Engine()    │
                    └──────┬───────┘
                           │
                           ▼
   ┌───────────────── _scheduleNextAuto ─────────────────┐
   │   每个 tick:pickAutoState(pet) → idle/walking/sleep │
   │   下一 tick = 当前 state 的 duration                 │
   └─────────────┬───────────────────────────────────────┘
                 │
                 │  独立平行:
                 ▼
   ┌──────────── _scheduleFlying ───────────────────────┐
   │   每 25–40s 抽一次;若不舒服或正在 oneShot,        │
   │   不播,等下次再抽。                                │
   └─────────────────────────────────────────────────────┘

   queueAnim('eating' | 'celebrating')                  ← 外部触发
        │
        ▼
   _playOneShot:
        ├─ 立刻 cancel auto cycle 的 pending tick
        ├─ setData({ currentAnim: name })
        ├─ duration 后:
        │    若 _queuedOneShot 有 → 接着播
        │    否则 → 回 idle 并 _scheduleNextAuto
```

### 优先级

1. **用户触发的 oneShot**(eating / celebrating):**最高**。立即接管。
2. **flying**:中等。在 oneShot 进行中时让位,等下一轮抽。
3. **idle / walking / sleeping**:背景循环,任何 oneShot 都会打断。

### 状态依赖 pet 属性(spec §3 "联动")

`pickAutoState(pet)`:

- `pet.health < 30 || pet.cleanliness < 30` → 仅在 `idle` / `sleeping` 间挑
  (`sleeping` 概率提升到 35%)。
- 正常状态 → `idle 55% / walking 35% / sleeping 10%`。
- `flying` 单独由 `_scheduleFlying` 决定:同样的"不舒服"判断会让它跳过这次。

> 这一层判断每次 tick 重新算,所以 stat 一旦回升,自动恢复完整选项。

---

## 4. 跨页触发(完成作业 → 庆祝)

家庭与宠物是两个 tab,用户完成作业时宠物页大概率不在前台,所以采用
**"在 app.globalData 留一个 flag,宠物页 onShow 消费"** 的轻量模式:

| 谁         | 写 / 读                                              |
|------------|----------------------------------------------------|
| 首页       | `pages/home/index.js` 的 `maybeShowReward()`:奖励有效命中后  |
|            | `getApp().globalData.petAnimQueue = 'celebrating'` |
| 宠物页     | `pages/pet/index.js` 的 `onShow()`:发现该字段为      |
|            | `'celebrating'` 即清空并 `queueAnim('celebrating')` |

eating 不需要跨页 — 商店和动画都在宠物页本页,直接 `queueAnim('eating')`
即可。

---

## 5. 鹦鹉的"动作配方"

每个动作下面三件套:**驱动哪个元素 / 时长 / 关键帧节奏**。
全部 keyframes 在 [`pages/pet/index.wxss`](pages/pet/index.wxss) 文件末尾。

**rig** 列说明该状态用哪一套 SVG(参见 §1.1)。

| 动作          | rig    | 元素 / 类                                           | 时长          | 关键帧 / 备注                                     |
|---------------|--------|----------------------------------------------------|---------------|------------------------------------------------|
| **idle**      | front  | `.parrot-stage`(scale 1→1.03)                      | 3.0s 循环      | `parrot-breath` — 0%/100% scale1, 50% scale 1.03 + Y −4rpx |
|               |        | `.part-eyes`(scaleY 1→0.05)                        | 4.5s 循环      | `parrot-blink` — 95–97% scaleY 0.05,其余 1     |
|               |        | `.part-wing-left/right`                            | 3.0s 循环      | `parrot-flutter-l/r` — ±6° 慢扇                |
| **walking**   | side   | `.parrot-figure`(translateX)                       | 9.0s 循环      | `parrot-walk-x` — 0/50/100% center,25% −80rpx,75% +80rpx |
|               |        | `.side-flip`(scaleX ±1)                            | 9.0s 循环      | `parrot-walk-flip` — `steps(1)` 在 25% / 75% 处镜像翻转 |
|               |        | `.parrot-stage`(translateY)                        | 0.55s 循环     | `parrot-walk-bounce` — Y ±6rpx 模拟脚步        |
|               |        | `.part-side-leg-front` / `.part-side-leg-back`     | 0.55s 循环     | `parrot-leg-step-a/b` — 错峰起落,显得真在迈步   |
|               |        | `.part-side-wing` / `.part-side-head`              | 0.55s 循环     | `parrot-side-flutter` / `parrot-side-head-bob` |
| **flying**    | side   | `.parrot-figure`(X)                                | 3.5s 1 次      | `parrot-fly-x` — 从 −260rpx 飞到 +260rpx,首尾淡出 |
|               |        | `.parrot-stage`(Y)                                 | 3.5s 1 次      | `parrot-fly-y` — 中点抬升 Y −60rpx 形成弧线    |
|               |        | `.part-side-wing`(±20° → ∓35°)                     | 0.18s 循环     | `parrot-side-flap-fast` — 大幅高频扇动          |
| **eating**    | side   | `.side-flip`                                       | 静态           | `perspective(500px) rotateY(-22deg)` — 3/4 透视 |
|               |        | `.part-side-head` + `.part-side-eye`               | 0.42s 循环     | `parrot-side-peck` — 50% rotate +28° + Y +8rpx |
|               |        | `.parrot-stage`(translateX)                        | 0.84s 循环     | `parrot-sway` — ±6rpx 身体小摆                 |
| **celebrating** | front  | `.parrot-figure`(rotateY,perspective 600)        | 2.0s 1 次      | `parrot-celebrate-rot-3d` — 0→360° Y 轴转一圈,扁平 sprite 在 90°/270° 自然变 edge-on |
|               |        | `.parrot-stage`(translateY)                        | 1.0s ×2        | `parrot-celebrate-jump` — Y −50rpx 两次起跳   |
|               |        | wings                                              | 0.22s 循环     | `parrot-flap-l/r-big` — ±20° → ∓50° 大扇       |
| **sleeping**  | front  | `.parrot-stage`(scale + Y)                         | 4.0s 循环      | `parrot-sleep-breath` — 极慢呼吸               |
|               |        | `.part-eyes`(static)                               | —             | `transform: scaleY(0.05)` 直接闭眼             |

### transform-origin 表(以 200-单位 viewBox 为基)

**正面 rig**

| Part              | origin     | 对应原始 SVG 坐标             |
|-------------------|------------|------------------------------|
| `part-wing-left`  | 29% 65%    | (58, 130) — 左肩             |
| `part-wing-right` | 71% 65%    | (142, 130) — 右肩            |
| `part-head`       | 50% 56%    | (100, 112) — 颈根            |
| `part-eyes`       | 50% 35%    | (100, 70) — 眼线             |
| `part-body`       | 50% 70%    | 默认底部缩放点               |

**侧面 rig**(鹦鹉 chest 朝右)

| Part                  | origin     | 对应原始 SVG 坐标             |
|-----------------------|------------|------------------------------|
| `part-side-body`      | 54% 65%    | (108, 130) — 身体几何中心     |
| `part-side-head`      | 61% 54%    | (122, 108) — 颈根             |
| `part-side-eye`       | 71% 37%    | (142, 74) — 侧脸眼线          |
| `part-side-wing`      | 47% 50%    | (95, 100) — 肩关节            |
| `part-side-leg-front` | 59% 88%    | (118, 175) — 近脚根部         |
| `part-side-leg-back`  | 48% 88%    | (96, 175) — 远脚根部          |

**双层 transform 设计要点**:locomotion(整图位移)放
`.parrot-figure`(走 / 飞 / 转圈),姿态(呼吸 / 弹跳 / 摇晃)放
`.parrot-stage` 内层。两层独立元素互不抢 `transform`,可以叠加。

---

## 5.5 Standard 档共享 keyframes(其它 8 种)

所有 Standard 档物种共享下列 keyframes,集中在
[`pages/pet/pet-anim.wxss`](pages/pet/pet-anim.wxss),
通过 `@import` 拼到主页 wxss。前缀 `pet-anim-*` 避免与鹦鹉
`parrot-*` 冲突。

| keyframe                  | 用途                                | 应用元素        |
|---------------------------|-------------------------------------|----------------|
| `pet-anim-breath`         | idle 呼吸 + 微抬                    | `.pet-art`     |
| `pet-anim-walk-x`         | walking 整体来回 ±80rpx             | `.pet-figure`  |
| `pet-anim-walk-flip`      | walking 转向(steps(1) snap-flip)   | `.pet-art`     |
| `pet-anim-walk-bounce`    | walking 上下小弹模拟脚步            | `.pet-art`     |
| `pet-anim-eat-bob`        | eating 头部点头(整体前倾抖)        | `.pet-art`     |
| `pet-anim-celebrate-spin` | celebrating Y 轴旋转 360°           | `.pet-art`     |
| `pet-anim-celebrate-jump` | celebrating 跳两次                  | `.pet-figure`  |
| `pet-anim-sleep-breath`   | sleeping 极慢呼吸 + 微沉            | `.pet-art`     |
| `pet-anim-happy-pop`      | happy 一次小跳 + scale wiggle       | `.pet-art`     |
| `pet-anim-hop`            | rabbit / chicken 大跳               | `.pet-figure`  |
| `pet-anim-hop-squash`     | rabbit / chicken 蓄力压缩           | `.pet-art`     |
| `pet-anim-wag`            | dog 摇尾(idle 叠加旋转)            | `.pet-art`     |
| `pet-anim-stretch`        | cat 伸懒腰(scaleX 拉长)            | `.pet-art`     |
| `pet-anim-roll`           | pig 打滚 720°                       | `.pet-art`     |
| `pet-anim-chew`           | cow 磨牙(skewX 摆动)               | `.pet-art`     |
| `pet-anim-gallop-x`       | alpaca 加速 walking                 | `.pet-figure`  |
| `pet-anim-gallop-tilt`    | alpaca 倾斜 7°                      | `.pet-art`     |
| `pet-anim-flap-jitter`    | chicken 飞行高频抖(模拟扇翅)       | `.pet-art`     |

类规则约定(WXML 上 `<view class="pet-figure species-{{species}} pet-anim-{{currentAnim}} anim-{{animState}}">`):

```css
.species-<id>.pet-anim-<action>           { animation: ... }   /* 外层 — locomotion */
.species-<id>.pet-anim-<action> .pet-art  { animation: ... }   /* 内层 — posture */
```

物种 override / 叠加示例:

```css
.species-rabbit.pet-anim-walking            { animation: pet-anim-hop ... }
.species-rabbit.pet-anim-walking .pet-art   { animation: pet-anim-hop-squash ... }
.species-dog.pet-anim-idle .pet-art         { animation: pet-anim-breath ..., pet-anim-wag ...; }
.species-pig.pet-anim-celebrating .pet-art  { animation: pet-anim-roll ... }
.species-cow.pet-anim-eating .pet-art       { animation: pet-anim-chew ... }
.species-cat.pet-anim-happy .pet-art        { animation: pet-anim-stretch ... }
.species-chicken.pet-anim-flying            { animation: pet-anim-hop ... }
.species-chicken.pet-anim-flying .pet-art   { animation: pet-anim-flap-jitter ... }
.species-alpaca.pet-anim-walking            { animation: pet-anim-gallop-x ... }
.species-alpaca.pet-anim-walking .pet-art   { animation: pet-anim-gallop-tilt ... }
```

**vital-state filters**(开心/难过/脏/生病的"色调"提示)依然由
`.anim-<animState> .pet-art { filter: ... }` 单独控制,只放 `filter`,
不放 `animation`,所以不与 `pet-anim-*` 冲突。

---

## 6. 鹦鹉 vs. 其它宠物的渲染分支

[pages/pet/index.wxml](pages/pet/index.wxml):

```wxml
<!-- Premium 档:鹦鹉 -->
<view wx:if="{{pet.species === 'parrot'}}"
      class="pet-figure parrot-figure parrot-anim-{{currentAnim}}">
  <view class="parrot-stage">
    <image class="part part-body"       src="/assets/pets/parrot-body.svg" .../>
    ...
  </view>
  ...state-icon overlays
</view>
<!-- Standard 档:其它 8 种 -->
<view wx:else
      class="pet-figure species-{{pet.species}} pet-anim-{{currentAnim}} anim-{{animState}}">
  <image class="pet-art" src="/assets/pets/{{pet.species}}.svg" .../>
  ...state-icon overlays
</view>
```

> Standard 档现在也走完整状态机,跟 Premium 共享 `currentAnim` 通道。
> 原 `parrot.svg` 保留(选种网格、换宠面板仍用它)。

---

## 7. 如何为新宠物加动画

Recipe 化的步骤,无需动 JS:

### 7.0 先决定档位

参考 §1.6:

- **Premium** —— 真正想"会动得像生物"的物种(目前仅鹦鹉)。走 §7.1–7.4 完整流程。
- **Standard** —— 单层 SVG + CSS transform 即可。**完全不需要拆 SVG**,
  也不用写新 keyframe,直接走 §7.6 即可。

### 7.1 SVG 拆分约定(Premium 档)

把整体宠物 SVG 拆成 **同一个 viewBox**(推荐 `0 0 200 200`)的若干层文件:

| 必备                                  | 可选                                     |
|--------------------------------------|----------------------------------------|
| `<species>-body.svg` —— 含躯干、尾、足  | `<species>-tail.svg` — 单独尾巴(摆尾用) |
| `<species>-head.svg` —— 含头、嘴、配饰   | `<species>-ear-left/right.svg` — 单耳朵 |
| `<species>-eyes.svg` —— 黑眼珠 + 高光    | `<species>-eyes-closed.svg` — 不需要,WXSS scaleY 即可 |
|                                      | `<species>-wing-left/right.svg` — 翅膀 |
|                                      | `<species>-leg-left/right.svg` — 跨腿  |

**命名规范**:全部以 `<species>-` 前缀 + 部位名,小写连字符。
**侧面 / 其它视角**额外加 `-side-` / `-back-` 等中缀(参见 §1.1):

| 视角         | 文件名 pattern                       | 示例                                 |
|-------------|-------------------------------------|-------------------------------------|
| 正面(默认) | `<species>-<part>.svg`              | `parrot-body.svg`、`parrot-eyes.svg` |
| 侧面         | `<species>-side-<part>.svg`         | `parrot-side-body.svg`、`parrot-side-leg-front.svg` |
| 后视(未来)| `<species>-back-<part>.svg`         | `parrot-back-tail.svg`(暂未实现)  |

侧面 rig 推荐拆成 **6 层**:`-side-body` / `-side-head` / `-side-eye`
(单眼)/ `-side-wing`(单翼)/ `-side-leg-front` / `-side-leg-back`。
默认朝向**右**(chest 朝右),走路时由 `.side-flip` 包一层
`scaleX(-1)` 翻成朝左。

每个文件的 viewBox 与原始 SVG 一致,只画自己那部分。这样图层叠在一起
重组完整造型,而每层的 `transform-origin` 直接用百分比就能锚定到部位。

### 7.2 WXML

在 [pages/pet/index.wxml](pages/pet/index.wxml) 里再加一个 `wx:if`
分支,引用新种类的 part SVG。已有的鹦鹉分支即模板。

### 7.3 WXSS

照鹦鹉范例,在 [pages/pet/index.wxss](pages/pet/index.wxss) 末尾加
`.<species>-figure / .<species>-stage / .part-*` + 一组
`.<species>-anim-<state> { animation: ... }` 规则 + keyframes。

**通用建议**:

- 时长沿用 §2 的表(idle 2.8s / walking 9s / flying 3.5s / eating 1.8s /
  celebrating 2s / sleeping 5s),保证状态机切换节奏一致。
- 关键帧名以 `<species>-` 前缀避免冲突(`parrot-breath`、`cat-breath` 各管各)。
- `transform-origin` 用百分比,根据部位锚点写。

### 7.4 JS

**无需改动**。`pages/pet/index.js` 的 `isParrot()` 应改为更通用的
`hasRig(species)` 表(下个版本要做的最小重构),目前先复用同一个
`currentAnim` 字段 + 不同 class 前缀即可让其他物种共用同一状态机。

> 为下个版本的扩展点:把 `isParrot` 替换成
>
> ```js
> const ANIMATED_SPECIES = ['parrot', /* 'cat', 'dog', ... */]
> function hasAnimRig(pet) { return pet && ANIMATED_SPECIES.includes(pet.species) }
> ```
>
> 加新物种就加进数组。

### 7.5 触发点

- **eating** 已经是 species 无关的:任何宠物买 fullness > 0 道具都触发。
- **celebrating** 跨页信号也是 species 无关的。
- **happy** 是 §1.5 规范化新增,所有物种点击宠物本体均触发。
- **flying** 仍是物种限定:`_scheduleFlying` 内白名单 `parrot` / `chicken`,
  其它物种自动跳过这个独立计时器。

### 7.6 加新 Standard 档物种(无需写 SVG / keyframe)

1. 把 `<species>.svg` 单层 SVG 放到 `/assets/pets/`。
2. 在 `pages/pet/index.js` 的 `PET_ANIM_SEQUENCES` 加一行 `[species]: [...]`,
   决定开发者点击循环哪些动作(也是 spec §1.5 的「每物种动作清单」)。
3. **不需要改 WXML / WXSS**,Standard 渲染分支已是 species-agnostic。
4. 想给该物种 1–2 个专属动作,**仅写 CSS override**:
   ```css
   .species-<id>.pet-anim-<action>          { animation: pet-anim-<keyframe> ... }
   .species-<id>.pet-anim-<action> .pet-art { animation: pet-anim-<keyframe> ... }
   ```
   keyframe 复用 §5.5 已有的或新增到 `pet-anim.wxss`(以 `pet-anim-` 前缀)。

---

## 8. 每种内置宠物的动作集(V1 已落地)

§1.5 已是 single source of truth,这里只做"实现 vs. 待补"对账。

| 物种      | V1 已落地                                              | 待补 / 后续 PR              |
|----------|------------------------------------------------------|----------------------------|
| 🦜 parrot | 6 件套 + flying(Premium 侧面 rig)                     | speech-mimic(鞠躬)         |
| 🐱 cat    | 6 件套(`happy = stretch`)                            | grooming(舔爪)             |
| 🐶 dog    | 6 件套 + wagging(idle 叠加)                          | fetch(向前冲)              |
| 🐰 rabbit | 6 件套(`walking = hopping`)                           | twitch-nose                 |
| 🐤 chicken | 6 件套 + flying(Standard hop + flap-jitter)          | peck(eating 加强)          |
| 🐮 cow    | 6 件套(`eating = chewing`)                           | low-moo                     |
| 🐷 pig    | 6 件套(`celebrating = rolling`)                       | snout-sniff                 |
| 🐑 sheep  | 6 件套通用                                              | fluff-shake / graze         |
| 🦙 alpaca | 6 件套(`walking = gallop`)                           | shoulder-shrug              |

> 排期建议:V1 之后下一波专属动作按"物种使用率"补 —— 看后台数据,
> 选种最多的优先升级到第二版动作。

---

## 9. 已知简化 / Trade-offs

- **single-slot 队列**:`queueAnim` 只缓存 1 个待播 oneShot,后到的会覆盖前一个。
  对于"短时间连续完成多项作业"的场景,只播最后一次的 celebrating(够用)。
- **flying 不规避 stage 边界**:`overflow: hidden` 决定鹦鹉飞出屏幕外被裁,
  这是预期的"穿越"效果。
- **scaleY 模拟眨眼**没有真做"上下眼皮闭合",视觉上是眼睛被压扁,
  小程序里足够"卡通可爱"。
- **state machine 当前耦合在 pet 页**:还没抽成独立 module。等做第二种动画
  宠物时再抽,避免过早抽象。

---

## 10. 开发者测试入口(tap-to-cycle)

为了在手机上肉眼验证每个动画(否则 `flying` 要等 25–40s 才有机会),
**点击宠物本体**(`.pet-stage` 区域)会按当前物种的动作清单依次切换:

```js
PET_ANIM_SEQUENCES = {
  parrot:  ['idle', 'walking', 'flying', 'eating', 'celebrating', 'sleeping', 'happy'],
  cat:     ['idle', 'walking', 'eating', 'celebrating', 'sleeping', 'happy'],   // happy = stretch
  dog:     ['idle', 'walking', 'eating', 'celebrating', 'sleeping', 'happy'],   // idle 叠加 wag
  chicken: ['idle', 'walking', 'flying', 'eating', 'celebrating', 'sleeping', 'happy'],
  rabbit:  ['idle', 'walking', 'eating', 'celebrating', 'sleeping', 'happy'],   // walking = hop
  cow:     ['idle', 'walking', 'eating', 'celebrating', 'sleeping', 'happy'],   // eating = chew
  pig:     ['idle', 'walking', 'eating', 'celebrating', 'sleeping', 'happy'],   // celebrating = roll
  sheep:   ['idle', 'walking', 'eating', 'celebrating', 'sleeping', 'happy'],
  alpaca:  ['idle', 'walking', 'eating', 'celebrating', 'sleeping', 'happy'],   // walking = gallop
}
```

每次点击:

1. `currentAnim` 立刻切到当前物种 sequence 中的下一个状态。
2. 屏幕上方浮一个 `.dev-anim-label`(白字黑底胶囊,1.5 秒淡出)
   显示当前动画名,方便对照。
3. **自动状态机暂停 8 秒**(`DEV_TAP_PAUSE_MS`)—— 否则点完
   立刻被 `_scheduleNextAuto` 抽回 idle,根本看不清。
4. 8 秒后,自动状态机回到 idle 并重新开始正常循环;
   `_scheduleFlying` 也通过同一个 `_devOverrideUntil` 时间戳
   在窗口期内直接重排,不抢占。
5. 物种 sequence 里没有的动作不会出现 —— 兔子点不出 `flying`,
   它的 walking 直接渲染为 hopping(同一 `currentAnim`,CSS 替身)。

**实现位于** [`pages/pet/index.js`](pages/pet/index.js) 的
`_cyclePetAnimForDev()` + `handleTapPet()`,常量在文件顶部:
`PET_ANIM_SEQUENCES` / `DEV_TAP_PAUSE_MS` / `DEV_LABEL_DURATION_MS`。

> 这是**测试入口而不是产品功能**。speech 气泡同时还会弹(原有行为保留),
> 用户在正常使用中也只会偶尔点宠物,不会刻意连点;真要彻底关掉就把
> `handleTapPet` 里的 `_cyclePetAnimForDev()` 调用注释掉即可。
