# V1 — Pet Animation Spec

> 第一版"丰富宠物动画"方案。鹦鹉 🦜 已作为原型跑通,本文档把流程沉下来,
> 后续 8 种宠物按"如何为新宠物加动画"小节加即可。

落地代码:
- 状态机:[pages/pet/index.js](pages/pet/index.js)
- 视觉规则:[pages/pet/index.wxss](pages/pet/index.wxss)
- WXML 模板:[pages/pet/index.wxml](pages/pet/index.wxml)
- 拆分后的鹦鹉 SVG:[assets/pets/](assets/pets/)(`parrot-body.svg` / `parrot-head.svg` / `parrot-eyes.svg` / `parrot-wing-left.svg` / `parrot-wing-right.svg`)
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

---

## 2. 状态列表

| 状态           | 类型      | 默认时长(ms) | 触发条件                                    |
|----------------|-----------|---------------|-------------------------------------------|
| `idle`         | 循环      | 2800          | 默认 / 无干预                                |
| `walking`      | 循环      | 9000          | 自动循环抽中 / 仅在状态正常时               |
| `sleeping`     | 循环      | 5000          | 自动循环抽中(不舒服时概率提升)             |
| `flying`       | 单次       | 3500          | 独立计时器 25–40s 一次,健康/清洁正常时      |
| `eating`       | 单次       | 1800          | 用户在商店买"提升 fullness"的食物            |
| `celebrating`  | 单次       | 2000          | 用户在首页完成作业,跨页 `globalData` 信号    |

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

| 动作          | 元素 / 类                                           | 时长          | 关键帧 / 备注                                     |
|---------------|----------------------------------------------------|---------------|------------------------------------------------|
| **idle**      | `.parrot-stage`(scale 1→1.03)                      | 3.0s 循环      | `parrot-breath` — 0%/100% scale1, 50% scale 1.03 + Y −4rpx |
|               | `.part-eyes`(scaleY 1→0.05)                        | 4.5s 循环      | `parrot-blink` — 95–97% scaleY 0.05,其余 1     |
|               | `.part-wing-left/right`                            | 3.0s 循环      | `parrot-flutter-l/r` — ±6° 慢扇                |
| **walking**   | `.parrot-figure`(translateX)                       | 9.0s 循环      | `parrot-walk-x` — 0/50/100% center,25% −80rpx,75% +80rpx |
|               | `.parrot-stage`(translateY)                        | 0.55s 循环     | `parrot-walk-bounce` — Y ±6rpx 模拟脚步        |
|               | wings                                              | 0.55s 循环     | `parrot-flutter-l/r`(走路时翅膀也轻颤)        |
| **flying**    | `.parrot-figure`(X)                                | 3.5s 1 次      | `parrot-fly-x` — 从 −260rpx 飞到 +260rpx,首尾淡出 |
|               | `.parrot-stage`(Y)                                 | 3.5s 1 次      | `parrot-fly-y` — 中点抬升 Y −60rpx 形成弧线    |
|               | wings(±15° → ∓30°)                                | 0.16s 循环     | `parrot-flap-l/r-fast` — 大幅高频扇动          |
| **eating**    | `.part-head` + `.part-eyes`                        | 0.42s 循环     | `parrot-nod` — 50% rotate −22° + Y +6rpx       |
|               | `.parrot-stage`(translateX)                        | 0.84s 循环     | `parrot-sway` — ±6rpx 身体小摆                 |
| **celebrating** | `.parrot-figure`(rotate)                          | 2.0s 1 次      | `parrot-celebrate-rot` — 0→360° 转一圈         |
|               | `.parrot-stage`(translateY)                        | 1.0s ×2        | `parrot-celebrate-jump` — Y −50rpx 两次起跳   |
|               | wings                                              | 0.22s 循环     | `parrot-flap-l/r-big` — ±20° → ∓50° 大扇       |
| **sleeping**  | `.parrot-stage`(scale + Y)                         | 4.0s 循环      | `parrot-sleep-breath` — 极慢呼吸               |
|               | `.part-eyes`(static)                               | —             | `transform: scaleY(0.05)` 直接闭眼             |

### transform-origin 表(以 200-单位 viewBox 为基)

| Part            | origin       | 对应原始 SVG 坐标             |
|-----------------|--------------|----------------------------|
| `part-wing-left`  | 29% 65%    | (58, 130) — 左肩            |
| `part-wing-right` | 71% 65%    | (142, 130) — 右肩            |
| `part-head`       | 50% 56%    | (100, 112) — 颈根            |
| `part-eyes`       | 50% 35%    | (100, 70) — 眼线             |
| `part-body`       | 50% 70%    | 默认底部缩放点              |

**双层 transform 设计要点**:locomotion(整图位移)放
`.parrot-figure`(走 / 飞 / 转圈),姿态(呼吸 / 弹跳 / 摇晃)放
`.parrot-stage` 内层。两层独立元素互不抢 `transform`,可以叠加。

---

## 6. 鹦鹉 vs. 其它宠物的渲染分支

[pages/pet/index.wxml](pages/pet/index.wxml):

```wxml
<view wx:if="{{pet.species === 'parrot'}}"
      class="pet-figure parrot-figure parrot-anim-{{currentAnim}}">
  <view class="parrot-stage">
    <image class="part part-body"       src="/assets/pets/parrot-body.svg" .../>
    <image class="part part-wing-left"  .../>
    <image class="part part-wing-right" .../>
    <image class="part part-head"       .../>
    <image class="part part-eyes"       .../>
  </view>
  ...state-icon overlays
</view>
<view wx:else class="pet-figure anim-{{animState}}">
  <image class="pet-art" src="/assets/pets/{{pet.species}}.svg" .../>
  ...
</view>
```

> 其它 8 种宠物保留原有 `<image>` + `anim-{{animState}}` 的单图渲染,
> 不受本次改动影响。原 `parrot.svg` 保留(选种网格、换宠面板仍用它)。

---

## 7. 如何为新宠物加动画

Recipe 化的步骤,无需动 JS:

### 7.1 SVG 拆分约定

把整体宠物 SVG 拆成 **同一个 viewBox**(推荐 `0 0 200 200`)的若干层文件:

| 必备                                  | 可选                                     |
|--------------------------------------|----------------------------------------|
| `<species>-body.svg` —— 含躯干、尾、足  | `<species>-tail.svg` — 单独尾巴(摆尾用) |
| `<species>-head.svg` —— 含头、嘴、配饰   | `<species>-ear-left/right.svg` — 单耳朵 |
| `<species>-eyes.svg` —— 黑眼珠 + 高光    | `<species>-eyes-closed.svg` — 不需要,WXSS scaleY 即可 |
|                                      | `<species>-wing-left/right.svg` — 翅膀 |
|                                      | `<species>-leg-left/right.svg` — 跨腿  |

**命名规范**:全部以 `<species>-` 前缀 + 部位名,小写连字符。

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
- 未来若某种动作只属于个别物种(如鹦鹉的 flying、青蛙的 jumping),
  在 ANIM_RECIPES 里加 `species` 限制字段或在 `_scheduleFlying`
  类的入口处判断即可。

---

## 8. 每种内置宠物建议的动作集(草稿,**不在本次范围**)

这里只列建议,未来分别开 PR 实现。每种都默认带 idle / walking / eating /
celebrating / sleeping 通用 5 组,加上各自特色的 1–2 组特技动作。

| 物种      | 特色动作建议                                               |
|----------|----------------------------------------------------------|
| 🦜 parrot | **flying**(已实现)、speech-mimic(说话时小幅鞠躬)            |
| 🐱 cat    | **stretch**(伸懒腰,2 段)、**grooming**(舔爪 / 清洁特化的 eating 替身) |
| 🐶 dog    | **tail-wag**(高频摇尾,可叠加在 idle/walking)、**fetch**(向前冲一下) |
| 🐰 rabbit | **hop**(walking 替换为跳跃位移)、**twitch-nose**(idle 时鼻子轻颤) |
| 🐔 chicken | **peck**(eating 加强版,头连点)、**flap-without-fly**(原地扑腾) |
| 🐮 cow    | **chew**(eating 替身,嘴左右摆)、**low-moo**(speech 时头微仰) |
| 🐷 pig    | **roll**(celebrating 替换为打滚 360°)、**snout-sniff**(idle 时鼻动) |
| 🐑 sheep  | **fluff-shake**(walking 时身体小颤)、**graze**(eating 替身,头一直低着) |
| 🦙 alpaca | **gallop**(walking 速度加倍版)、**shoulder-shrug**(idle 偶尔耸肩) |

> 排期建议:先把 cat / dog 这两个最常用的物种做了(覆盖率最高),其它按需补。

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
