// Numeric verification for V1 economy rules. Asserts the values in
// V1-VALUES-DESIGN.md match what the store actually implements.
// Run: `node scripts/values-check.js` (no deps).

let storage = {}
global.wx = {
  getStorageSync: (k) => (k in storage ? JSON.parse(storage[k]) : ''),
  setStorageSync: (k, v) => { storage[k] = JSON.stringify(v) },
  cloud: undefined,
  showToast: () => {},
  showModal: () => {}
}

// Pin "now" to a fixed late-evening moment (22:00 today, local) so reward
// assertions don't drift with wall-clock time. 22:00 is past the last
// early-finish tier (21:00) so the early-bird bonus is 0 by default. Tests
// that need a specific hour-of-day (early-finish tiers) override this
// themselves.
const _realDateNow = Date.now
function setNowHour(h, m) {
  const d = new Date()
  d.setHours(h, m || 0, 0, 0)
  const fixed = d.getTime()
  Date.now = () => fixed
}
function restoreNow() { Date.now = _realDateNow }
setNowHour(22, 0)

function pad2(n) { return String(n).padStart(2, '0') }
function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
function dateAtOffset(dayOffset) {
  const d = new Date()
  d.setDate(d.getDate() + dayOffset)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

// Seed N one-shot tasks scheduled for `taskDate`, all 'todo'. The pet is set
// up but no per-task pet boost is applied — finishTask is reward-only.
function seedTasksOnDate(n, taskDate) {
  const tasks = []
  for (let i = 1; i <= n; i++) {
    tasks.push({
      id: `t${i}`, notebookId: 'nb_seed', subject: '语', content: `task ${i}`,
      estimatedMinutes: 5, order: i, createdAt: i,
      status: 'todo', startedAt: null, currentSegmentStartedAt: null,
      accumulatedMs: 0, completedAt: null, actualMinutes: null
    })
  }
  storage = {}
  storage['homework-pet-v1'] = JSON.stringify({
    schemaVersion: 2, coins: 0, streakDays: 0, perfectDays: [],
    bonusByDay: {}, completionsByDay: {},
    pendingShareCoins: 0,
    editTaskId: null, editNotebookId: null,
    ocrCurrentJob: null, ocrJobs: [],
    pet: {
      species: 'cat', emoji: '🐱', name: 'p',
      bornAt: Date.now(), lastDecayAt: Date.now(),
      level: 1, happiness: 80, fullness: 80, cleanliness: 80, health: 80
    },
    shopItems: [],
    notebooks: [{
      id: 'nb_seed', name: 'seed', mode: 'one-shot',
      startDate: taskDate, endDate: taskDate, recurrence: null,
      createdAt: 1, order: 0
    }],
    tasks,
    profile: { nickname: '' }
  })
}
function seedNTasksToday(n) { seedTasksOnDate(n, todayStr()) }

let pass = 0, fail = 0
function check(label, got, want) {
  const sg = JSON.stringify(got)
  const sw = JSON.stringify(want)
  if (sg === sw) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}`)
    console.log(`    got:  ${sg}`)
    console.log(`    want: ${sw}`)
  }
}

function freshStore() {
  const path = require('path').resolve(__dirname, '../utils/store.js')
  delete require.cache[require.resolve(path)]
  return require(path)
}

// === Test 1: per-task +10, 7/8 done = 70 coins ===
console.log('\n[reward] per-task and partial-day:')
seedNTasksToday(8)
let store = freshStore()
const today = todayStr()
for (let i = 1; i <= 7; i++) store.finishTask(`t${i}`, today)
check('finish 7 of 8 → coins = 70', store.getStateWithComputed().coins, 70)

// === Test 2: 8th completion triggers daily bonus → 70 + 10 + 80 = 160 ===
console.log('\n[reward] all-done daily bonus:')
store.finishTask('t8', today)
const after8 = store.getStateWithComputed()
check('finish 8/8 → coins = 160', after8.coins, 160)
check('lastReward.dailyBonus = 80', after8.lastReward.dailyBonus, 80)
check('streakDays = 1', after8.streakDays, 1)
check('perfectDays includes today', after8.perfectDays.includes(today), true)

// === Test 3: revert claws back single +10 AND the daily bonus ===
// Picking up from test 2: 8/8 done, coins=160, perfectDays=[today], streak=1.
console.log('\n[revert] all-done revert claws back single + bonus:')
store.revertTask('t8', today)
const afterRevert8 = store.getStateWithComputed()
check('revert breaks all-done → coins = 70 (refund 10 + 80)', afterRevert8.coins, 70)
check('streakDays restored to 0', afterRevert8.streakDays, 0)
check('perfectDays no longer has today', afterRevert8.perfectDays.includes(today), false)

// === Test 3b: re-finishing the same task re-pays the bonus (back to 160) ===
store.finishTask('t8', today)
const afterRedo = store.getStateWithComputed()
check('redo restores to 160 (single +10 + bonus +80)', afterRedo.coins, 160)
check('streakDays back to 1', afterRedo.streakDays, 1)

// === Test 3c: anti-farm — finish→revert cycled 5× nets zero ===
// Each cycle: finish(+10+80) → revert(-10-80). End coins must equal start.
const beforeFarm = store.getStateWithComputed().coins
for (let i = 0; i < 5; i++) {
  store.revertTask('t8', today)
  store.finishTask('t8', today)
}
const afterFarm = store.getStateWithComputed()
check('5× finish/revert cycle → coins unchanged', afterFarm.coins, beforeFarm)
check('5× cycle → still 1 perfect day on streak', afterFarm.streakDays, 1)

// === Test 3d: revert middle task (not the one that triggered all-done) ===
// Same logic must fire: any revert from a perfect-day state breaks the day.
seedNTasksToday(8)
store = freshStore()
for (let i = 1; i <= 8; i++) store.finishTask(`t${i}`, today)
check('seed: 8/8 → 160', store.getStateWithComputed().coins, 160)
store.revertTask('t3', today)  // middle task, not the 8th
const afterMiddle = store.getStateWithComputed()
check('revert middle → coins = 70 (bonus still clawed)', afterMiddle.coins, 70)
check('revert middle → streakDays back to 0', afterMiddle.streakDays, 0)

// === Test 3e: revert without all-done only refunds the single +10 ===
seedNTasksToday(3)
store = freshStore()
store.finishTask('t1', today)
store.finishTask('t2', today)  // 2/3, not perfect → no bonus credited yet
const before2of3 = store.getStateWithComputed()
check('seed: 2/3 done → coins = 20', before2of3.coins, 20)
store.revertTask('t2', today)
const after2of3 = store.getStateWithComputed()
check('revert non-perfect-day task → coins = 10', after2of3.coins, 10)
check('streakDays untouched', after2of3.streakDays, 0)

// === Test 3f: clip-to-zero — refund larger than current balance ===
seedNTasksToday(1)
store = freshStore()
store.finishTask('t1', today)
const fix = JSON.parse(storage['homework-pet-v1'])
fix.coins = 3  // user spent most of it; only 3 left
storage['homework-pet-v1'] = JSON.stringify(fix)
store = freshStore()
store.revertTask('t1', today)
check('refund > balance → coins clipped to 0', store.getStateWithComputed().coins, 0)

// === Test 4: 12-task day matches design's 12 × 20 = 240 ===
console.log('\n[reward] 12-task perfect day = 240:')
seedNTasksToday(12)
store = freshStore()
for (let i = 1; i <= 12; i++) store.finishTask(`t${i}`, today)
check('12/12 → coins = 240', store.getStateWithComputed().coins, 240)

// === Test 5: XP cost curve — getXpForLevel = level × 33 + 87 ===
// 曲线设计目标:满速(240 XP/天)下 Lv.1→2 = 0.5 天, Lv.99→100 ≈ 14 天。
console.log('\n[level] xp cost curve:')
store = freshStore()
check('LEVEL_MAX = 100', store.LEVEL_MAX, 100)
check('XP_PER_LEVEL_BASE = 33',   store.XP_PER_LEVEL_BASE,   33)
check('XP_PER_LEVEL_OFFSET = 87', store.XP_PER_LEVEL_OFFSET, 87)
check('XP_PER_HOUR_FULL = 10',    store.XP_PER_HOUR_FULL,    10)
check('getXpForLevel(1)   = 120',  store.getXpForLevel(1),   120)
check('getXpForLevel(2)   = 153',  store.getXpForLevel(2),   153)
check('getXpForLevel(10)  = 417',  store.getXpForLevel(10),  417)
check('getXpForLevel(50)  = 1737', store.getXpForLevel(50),  1737)
check('getXpForLevel(90)  = 3057', store.getXpForLevel(90),  3057)
check('getXpForLevel(99)  = 3354', store.getXpForLevel(99),  3354)
check('getXpForLevel(100) = 0 (max level)', store.getXpForLevel(100), 0)
check('getXpForLevel(101) = 0 (above max)', store.getXpForLevel(101), 0)

// === Test 5b: attrMultiplier — 四属性平均 / 100,clip [0,1] ===
console.log('\n[level] attrMultiplier + currentXpPerHour:')
const fullPet  = { species: 'cat', happiness: 100, fullness: 100, cleanliness: 100, health: 100 }
const halfPet  = { species: 'cat', happiness: 50,  fullness: 50,  cleanliness: 50,  health: 50  }
const emptyPet = { species: 'cat', happiness: 0,   fullness: 0,   cleanliness: 0,   health: 0   }
const skewPet  = { species: 'cat', happiness: 80,  fullness: 40,  cleanliness: 60,  health: 20  } // avg=50
const noPet    = {}
check('full 100/100/100/100 → 1.0',   store.attrMultiplier(fullPet),  1)
check('half 50/50/50/50 → 0.5',       store.attrMultiplier(halfPet),  0.5)
check('empty 0/0/0/0 → 0',            store.attrMultiplier(emptyPet), 0)
check('skewed avg=50 → 0.5',          store.attrMultiplier(skewPet),  0.5)
check('no pet (no species) → 0',      store.attrMultiplier(noPet),    0)
check('currentXpPerHour(fullPet)  = 10', store.currentXpPerHour(fullPet),  10)
check('currentXpPerHour(halfPet)  = 5',  store.currentXpPerHour(halfPet),  5)
check('currentXpPerHour(emptyPet) = 0',  store.currentXpPerHour(emptyPet), 0)
check('currentXpPerHour(noPet)    = 0',  store.currentXpPerHour(noPet),    0)

// === Test 5c: 完成作业不再发 XP(漏洞修复:XP 跟作业脱钩) ===
console.log('\n[xp] finishTask 不发 XP,只发金币:')
seedNTasksToday(3)
// 把 pet 拉满 + lastDecayAt 设到现在(模拟刚 commit,没有 catch-up XP)
let noXpRaw = JSON.parse(storage['homework-pet-v1'])
noXpRaw.pet.happiness = 100; noXpRaw.pet.fullness = 100
noXpRaw.pet.cleanliness = 100; noXpRaw.pet.health = 100
noXpRaw.pet.xp = 0
noXpRaw.pet.lastDecayAt = Date.now()
storage['homework-pet-v1'] = JSON.stringify(noXpRaw)
store = freshStore()
store.finishTask('t1', today)
store.finishTask('t2', today)
store.finishTask('t3', today)
const s5c = store.getStateWithComputed()
check('finishTask 完成 3 题 → 金币照发 (3×10 + perfect 30 = 60)', s5c.coins, 60)
check('finishTask 完成 3 题 → pet.xp 仍为 0(完全脱钩)', s5c.pet.xp, 0)
check('finishTask 不再写 occurrence.xpPaid 字段',
  s5c.tasks.find((t) => t.id === 't1').xpPaid, undefined)
check('lastReward 不再带 taskXp / dailyXp / weeklyXp',
  s5c.lastReward.taskXp === undefined && s5c.lastReward.dailyXp === undefined, true)

// === Test 5d: XP 按时间挂机累计(trapezoidal,衰减前/后 mult 平均) ===
console.log('\n[xp] time-based accrual via petWithDecay:')
// 模拟"24 小时前喂满,期间没操作"。24h 满速 = 10 × 24 = 240 XP。
// 但属性会衰减:fullness 100→0(rate 4×24>=96 → 4),cleanliness 100→? 等。
// 用 commitPetDecay 路径:trapezoidal avg。
seedNTasksToday(0)
let xpRaw = JSON.parse(storage['homework-pet-v1'])
const TWENTY_FOUR_HOURS_AGO = Date.now() - 24 * 3600 * 1000
xpRaw.pet = {
  species: 'cat', emoji: '🐱', name: 'p',
  bornAt: TWENTY_FOUR_HOURS_AGO, lastDecayAt: TWENTY_FOUR_HOURS_AGO,
  level: 1, xp: 0,
  happiness: 100, fullness: 100, cleanliness: 100, health: 100
}
storage['homework-pet-v1'] = JSON.stringify(xpRaw)
store = freshStore()
const xpAccrued = store.getStateWithComputed().pet
// 24h 衰减后属性: fullness 100-4×24=4(round)→clip 0 实际算 100-96=4;但 rate 4×24=96,100-96=4
// 各属性 24h 后:fullness=4, cleanliness=100-3×24=28, happiness=28, health=100-2.5×24=40
// avg_start = (100+100+100+100)/4=100 → mult_start=1.0
// avg_end = (4+28+28+40)/4=25 → mult_end=0.25
// avg_mult=(1.0+0.25)/2=0.625
// xp_gained = floor(24 × 10 × 0.625) = 150
check('24h 挂机(初始全满,衰减到 avg=25)→ pet.xp ≈ 150',
  xpAccrued.xp, 150)
check('24h 挂机 → fullness 衰减到 4', xpAccrued.fullness, 4)
check('24h 挂机 → cleanliness 衰减到 28', xpAccrued.cleanliness, 28)
check('24h 挂机 → health 衰减到 40', xpAccrued.health, 40)

// 全空属性(mult=0)→ 任何时长都不发 XP
seedNTasksToday(0)
let zeroRaw = JSON.parse(storage['homework-pet-v1'])
zeroRaw.pet = {
  species: 'cat', emoji: '🐱', name: 'p',
  bornAt: TWENTY_FOUR_HOURS_AGO, lastDecayAt: TWENTY_FOUR_HOURS_AGO,
  level: 1, xp: 0,
  happiness: 0, fullness: 0, cleanliness: 0, health: 0
}
storage['homework-pet-v1'] = JSON.stringify(zeroRaw)
store = freshStore()
check('全空属性挂机 24h → pet.xp = 0', store.getStateWithComputed().pet.xp, 0)

// 半属性挂机 1h(短窗口,衰减影响小,接近线性)
seedNTasksToday(0)
const ONE_HOUR_AGO = Date.now() - 1 * 3600 * 1000
let halfRaw = JSON.parse(storage['homework-pet-v1'])
halfRaw.pet = {
  species: 'cat', emoji: '🐱', name: 'p',
  bornAt: ONE_HOUR_AGO, lastDecayAt: ONE_HOUR_AGO,
  level: 1, xp: 0,
  happiness: 50, fullness: 50, cleanliness: 50, health: 50
}
storage['homework-pet-v1'] = JSON.stringify(halfRaw)
store = freshStore()
const halfXp = store.getStateWithComputed().pet.xp
// 1h:start mult=0.5,end mult=(50-3+50-4+50-3+50-2.5)/4/100 ≈ 0.47
// trapezoid = (0.5+0.47)/2=0.485,xp = floor(1×10×0.485)=4
check('1h 挂机 半属性(avg≈0.485) → pet.xp = 4', halfXp, 4)

// === Test 6: levelUpPet — 扣 getXpForLevel(level) XP 升级,溢出留作下一级 ===
console.log('\n[level] levelUpPet (xp-cost):')
seedNTasksToday(0)
// pet.xp 手动塞 200 → Lv.1→2 (cost=120) 能升,剩 80 不够升 Lv.2→3 (cost=153)。
// lastDecayAt 设到 now 避免 commit 时再 catch-up XP 把 80 拉高。
const raw = JSON.parse(storage['homework-pet-v1'])
raw.pet.xp = 200
raw.pet.lastDecayAt = Date.now()
storage['homework-pet-v1'] = JSON.stringify(raw)
store = freshStore()

const r1 = store.levelUpPet()
check('xp=200 → ok at Lv.1', r1.ok, true)
check('level becomes 2', r1.level, 2)
check('xp after Lv.1→2 = 80 (溢出保留)', store.getStateWithComputed().pet.xp, 80)
check('返回值 xp = 80', r1.xp, 80)

// 再 levelUp 一次 → Lv.2→3 需 153,xp=80 → insufficient-xp,need=73
const r2 = store.levelUpPet()
check('xp=80 → insufficient-xp', r2.ok, false)
check('insufficient-xp reason', r2.reason, 'insufficient-xp')
check('need = 73 (cost 153 - xp 80)', r2.need, 73)
check('level unchanged at 2', store.getStateWithComputed().pet.level, 2)
check('xp unchanged at 80',    store.getStateWithComputed().pet.xp,    80)

// no-pet 时返 no-pet
seedTasksOnDate(0, today)
const raw2 = JSON.parse(storage['homework-pet-v1'])
raw2.pet = {}
storage['homework-pet-v1'] = JSON.stringify(raw2)
store = freshStore()
const r3 = store.levelUpPet()
check('no pet → no-pet reason', r3.ok === false && r3.reason, 'no-pet')

// max-level 时返 max-level,不扣 xp
seedTasksOnDate(0, today)
const raw3 = JSON.parse(storage['homework-pet-v1'])
raw3.pet = { species: 'cat', emoji: '🐱', name: 'p', level: 100, xp: 9999,
  bornAt: Date.now(), lastDecayAt: Date.now(),
  happiness: 100, fullness: 100, cleanliness: 100, health: 100 }
storage['homework-pet-v1'] = JSON.stringify(raw3)
store = freshStore()
const r4 = store.levelUpPet()
check('max level → max-level reason', r4.ok === false && r4.reason, 'max-level')
check('max level → xp unchanged', store.getStateWithComputed().pet.xp, 9999)

// === Test 7: decay rates — 16h on each stat ===
console.log('\n[decay] 16h drop sanity check:')
const decay = store.PET_DECAY_PER_HOUR
check('fullness rate = 4',    decay.fullness, 4)
check('cleanliness rate = 3', decay.cleanliness, 3)
check('happiness rate = 3',   decay.happiness, 3)
check('health rate = 2.5',    decay.health, 2.5)
// 16h drops: fullness 100→36, cleanliness 100→52, happiness 100→52, health 100→60
// (rates × 16, rounded to int by petWithDecay)
const sixteenHoursAgo = Date.now() - 16 * 3600 * 1000
const cur2 = JSON.parse(storage['homework-pet-v1'])
cur2.pet = {
  species: 'cat', emoji: '🐱', name: 'p',
  bornAt: sixteenHoursAgo, lastDecayAt: sixteenHoursAgo,
  level: 1, happiness: 100, fullness: 100, cleanliness: 100, health: 100
}
storage['homework-pet-v1'] = JSON.stringify(cur2)
store = freshStore()
const decayed = store.getStateWithComputed().pet
check('16h fullness = 36',    decayed.fullness, 36)
check('16h cleanliness = 52', decayed.cleanliness, 52)
check('16h happiness = 52',   decayed.happiness, 52)
check('16h health = 60',      decayed.health, 60)

// === Test 8: shop item shape — every item lifts at least one stat ===
console.log('\n[shop] item sanity:')
// Read shopItems from defaultState (the canonical source) — the seeded
// fixture above intentionally set shopItems: [] to keep test 1 lean.
storage = {}
store = freshStore()
const items = store.defaultState.shopItems
// 道具现在覆盖 4 个 stat(开心 / 饱腹 / 清洁 / 健康),开心度走玩具球 + 礼物盒。
check('8 shop items', items.length, 8)
for (const it of items) {
  const sum = (it.happiness | 0) + (it.fullness | 0) + (it.cleanliness | 0) + (it.health | 0)
  if (sum <= 0) {
    fail++
    console.log(`  ✗ item ${it.id} (${it.name}) has no stat boost`)
  }
}
const carrot = items.find((i) => i.id === 1)
check('carrot price = 16',        carrot.price, 16)
check('carrot fullness = 30',     carrot.fullness, 30)
check('shop totals match design', items.map((i) => i.price), [16, 28, 18, 32, 20, 20, 35, 36])

// 四项 stat 各需要 ≥1 道具(开心走玩具球/礼物盒)。
const STAT_KEYS = ['happiness', 'fullness', 'cleanliness', 'health']
const primaryCounts = { happiness: 0, fullness: 0, cleanliness: 0, health: 0 }
for (const it of items) {
  let primary = STAT_KEYS[0]
  for (const k of STAT_KEYS) if ((it[k] | 0) > (it[primary] | 0)) primary = k
  if ((it[primary] | 0) > 0) primaryCounts[primary]++
}
for (const k of STAT_KEYS) {
  check(`stat "${k}" has ≥1 item`, primaryCounts[k] >= 1, true)
}
// Price tiers: cheap 15-25, mid 25-40, high 50-80.
for (const it of items) {
  const inRange =
    (it.price >= 15 && it.price <= 25) ||
    (it.price >= 25 && it.price <= 40) ||
    (it.price >= 50 && it.price <= 80)
  if (!inRange) {
    fail++
    console.log(`  ✗ item ${it.id} (${it.name}) price ${it.price} outside design tiers`)
  }
}

// === Test 9: reward constants exported for UI/tests ===
console.log('\n[reward] exported constants:')
check('REWARD_TASK_OVERDUE = 5',  store.REWARD_TASK_OVERDUE, 5)
check('REWARD_TASK_TODAY = 10',   store.REWARD_TASK_TODAY, 10)
check('REWARD_TASK_FUTURE = 15',  store.REWARD_TASK_FUTURE, 15)
check('REWARD_WEEKLY_STREAK = 100', store.REWARD_WEEKLY_STREAK, 100)
check('DAILY_COMPLETION_CAP = 20', store.DAILY_COMPLETION_CAP, 20)
check('EARLY_BIRD_TIERS length = 3', store.EARLY_BIRD_TIERS.length, 3)
check('tier[0] bonus = 50', store.EARLY_BIRD_TIERS[0].bonus, 50)
check('tier[1] bonus = 30', store.EARLY_BIRD_TIERS[1].bonus, 30)
check('tier[2] bonus = 20', store.EARLY_BIRD_TIERS[2].bonus, 20)

// === Test 9b: earlyBirdBonus — hourly tiers ===
console.log('\n[reward] earlyBirdBonus by hour:')
function atHour(h, m) { const d = new Date(); d.setHours(h, m || 0, 0, 0); return d }
check('05:00 → +50', store.earlyBirdBonus(atHour(5, 0)),   50)
check('14:00 → +50', store.earlyBirdBonus(atHour(14, 0)),  50)
check('18:59 → +50', store.earlyBirdBonus(atHour(18, 59)), 50)
check('19:00 → +30', store.earlyBirdBonus(atHour(19, 0)),  30)
check('19:59 → +30', store.earlyBirdBonus(atHour(19, 59)), 30)
check('20:00 → +20', store.earlyBirdBonus(atHour(20, 0)),  20)
check('20:30 → +20', store.earlyBirdBonus(atHour(20, 30)), 20)
check('21:00 → +0',  store.earlyBirdBonus(atHour(21, 0)),  0)
check('23:30 → +0',  store.earlyBirdBonus(atHour(23, 30)), 0)

// === Test 9c: finishTask honors the bonus at the moment of last finish ===
console.log('\n[reward] early-finish tiers applied on all-done:')
function runAllDoneAtHour(h, taskCount) {
  setNowHour(h, 0)
  seedNTasksToday(taskCount)
  const s = freshStore()
  for (let i = 1; i <= taskCount; i++) s.finishTask(`t${i}`, today)
  return s.getStateWithComputed().coins
}
// 8 tasks: per-task 80 + daily-perfect 80 + early-bird bonus (tier-dependent)
check('8/8 at 18:30 → 80 + 80 + 50 = 210', runAllDoneAtHour(18, 8), 210)
check('8/8 at 19:00 → 80 + 80 + 30 = 190', runAllDoneAtHour(19, 8), 190)
check('8/8 at 20:30 → 80 + 80 + 20 = 180', runAllDoneAtHour(20, 8), 180)
check('8/8 at 22:00 → 80 + 80 + 0 = 160',  runAllDoneAtHour(22, 8), 160)
// Restore late-evening for the rest of the file's tests.
setNowHour(22, 0)

// === Test 9d: perTaskReward pure helper ===
console.log('\n[reward] perTaskReward by task-day vs today:')
check('overdue (yesterday vs today) → 5/overdue',
  store.perTaskReward('2026-05-13', '2026-05-14'), { amount: 5, kind: 'overdue' })
check('today (==today) → 10/today',
  store.perTaskReward('2026-05-14', '2026-05-14'), { amount: 10, kind: 'today' })
check('future (tomorrow) → 15/future',
  store.perTaskReward('2026-05-15', '2026-05-14'), { amount: 15, kind: 'future' })

// === Test 9e: finishTask pays the right tier + writes rewardPaid/kind ===
console.log('\n[reward] per-task tier wiring through finishTask:')
const yesterday = dateAtOffset(-1)
const tomorrow  = dateAtOffset(1)

// Overdue: 2 tasks scheduled yesterday, finish only t1 today (22:00). 2 tasks
// (not 1) so finishing one doesn't accidentally trigger yesterday's perfect-day.
seedTasksOnDate(2, yesterday)
store = freshStore()
store.finishTask('t1', yesterday)
let s = store.getStateWithComputed()
check('overdue task → coins = 5', s.coins, 5)
check('overdue task → lastReward.taskReward = 5', s.lastReward.taskReward, 5)
check('overdue task → lastReward.rewardKind = overdue', s.lastReward.rewardKind, 'overdue')
check('overdue task → completionsByDay[today] = 1',
  s.completionsByDay[today], 1)

// Today: already covered by Test 1 (8 of 8 at +10). Spot-check the signal.
seedNTasksToday(1)
store = freshStore()
store.finishTask('t1', today)
s = store.getStateWithComputed()
// 1 task today completes the perfect-day → +10 per-task + 10 bonus + 0 early-bird = 20
check('today task (1/1 perfect) → coins = 20', s.coins, 20)
check('today task → lastReward.taskReward = 10', s.lastReward.taskReward, 10)
check('today task → lastReward.rewardKind = today', s.lastReward.rewardKind, 'today')

// Future: 2 tasks scheduled tomorrow, finish only t1 today. 2-task seed for
// same reason as overdue — avoid tripping tomorrow's perfect-day.
seedTasksOnDate(2, tomorrow)
store = freshStore()
store.finishTask('t1', tomorrow)
s = store.getStateWithComputed()
check('future task → coins = 15', s.coins, 15)
check('future task → lastReward.taskReward = 15', s.lastReward.taskReward, 15)
check('future task → lastReward.rewardKind = future', s.lastReward.rewardKind, 'future')

// === Test 9f: 20-task daily cap on the per-task reward ===
console.log('\n[reward] 20/day completion cap:')
// 25 tasks scheduled today, finish them in order. The first 20 each pay +10
// (200), the last 5 pay 0. All-done fires on the 25th → daily-perfect base
// = min(25, 20) × 10 = 200; early-bird +0 (22:00). Total = 200 + 200 = 400.
seedNTasksToday(25)
store = freshStore()
for (let i = 1; i <= 25; i++) store.finishTask(`t${i}`, today)
s = store.getStateWithComputed()
check('25 today finishes → coins = 400 (200 per-task capped + 200 base)', s.coins, 400)
check('completionsByDay[today] = 20 (clamped)', s.completionsByDay[today], 20)
// 21st onward stamped with rewardPaid=0 + rewardKind=capped on the task.
const taskList = s.tasks
const t1 = taskList.find((t) => t.id === 't1')
const t21 = taskList.find((t) => t.id === 't21')
check('t1.rewardPaid = 10 (paid)',  t1.rewardPaid, 10)
check('t1.rewardKind = today',      t1.rewardKind, 'today')
check('t21.rewardPaid = 0 (capped)', t21.rewardPaid, 0)
check('t21.rewardKind = capped',     t21.rewardKind, 'capped')

// Last lastReward is for t25 → also capped + perfect-day fired.
check('lastReward.taskReward = 0 (t25 was capped)', s.lastReward.taskReward, 0)
check('lastReward.rewardKind = capped',             s.lastReward.rewardKind, 'capped')
check('lastReward.dailyBonus = 200 (sum of 25 rewardPaid)', s.lastReward.dailyBonus, 200)

// === Test 9g: revert refunds the exact rewardPaid + frees a cap slot ===
console.log('\n[reward] revert respects rewardPaid + cap counter:')
// Continuing from 25-task seed above. Revert t21 (was capped) → refunds 0
// AND claws back the perfect-day bonus (200). Revert is from a perfect-day
// state so the daily/weekly bonus is fully undone.
store.revertTask('t21', today)
s = store.getStateWithComputed()
check('revert capped task → coins = 200 (only bonus clawed)', s.coins, 200)
check('revert capped task → completionsByDay unchanged (was capped, no slot held)',
  s.completionsByDay[today], 20)
check('revert capped task → perfect-day broken', s.perfectDays.includes(today), false)

// Revert a paid task (t1). Refunds 10 AND frees a slot in the counter.
store.revertTask('t1', today)
s = store.getStateWithComputed()
check('revert paid task → coins = 190 (refund 10)', s.coins, 190)
check('revert paid task → completionsByDay[today] = 19', s.completionsByDay[today], 19)

// Now re-finish a fresh task (refinish t1 — it was reverted to paused).
// Slot is free, so it pays +10 again.
store.finishTask('t1', today)
s = store.getStateWithComputed()
check('refinish freed slot → coins = 200 (+10)', s.coins, 200)
check('refinish freed slot → completionsByDay[today] = 20', s.completionsByDay[today], 20)

// === Test 9h: daily-perfect base = sum(rewardPaid), not N × 10 ===
// Future perfect-day: 2 tomorrow tasks finished today.
// Per-task: 2×15=30. Daily-perfect base = sum(rewardPaid) = 30.
// 22:00 (no early-bird). Total = 30 + 30 = 60.
console.log('\n[reward] daily-perfect = sum of rewardPaid (per-tier):')
seedTasksOnDate(2, tomorrow)
store = freshStore()
store.finishTask('t1', tomorrow)
store.finishTask('t2', tomorrow)
s = store.getStateWithComputed()
check('2 future all-done → coins = 60 (30 + 30)', s.coins, 60)
check('  → lastReward.dailyBonus = 30',  s.lastReward.dailyBonus, 30)

// Overdue perfect-day: 2 yesterday tasks finished today.
// Per-task: 2×5=10. Daily-perfect base = 10. Total = 20.
seedTasksOnDate(2, yesterday)
store = freshStore()
store.finishTask('t1', yesterday)
store.finishTask('t2', yesterday)
s = store.getStateWithComputed()
check('2 overdue all-done → coins = 20 (10 + 10)', s.coins, 20)
check('  → lastReward.dailyBonus = 10',  s.lastReward.dailyBonus, 10)

// 25-task cap recap: same coin total (400) as before but verified the path
// goes through sum(rewardPaid) instead of min(N,20)×10 — confirmed by the
// 200 daily-perfect being 20×10+5×0 (not 25×10 reduced via cap arithmetic).
seedNTasksToday(25)
store = freshStore()
for (let i = 1; i <= 25; i++) store.finishTask(`t${i}`, today)
s = store.getStateWithComputed()
check('25 today re-check → dailyBonus = 200 (sum of 20×10 + 5×0)',
  s.lastReward.dailyBonus, 200)

// === Test 9i: projectedReward — pure helper for "完成所有可获得 X 金币" tips ===
console.log('\n[reward] projectedReward forecasts:')
{
  const T = today  // today string from outer scope, pinned at 22:00
  const Y = dateAtOffset(-1)
  const M = dateAtOffset(1)
  const emptyState = { completionsByDay: {}, perfectDays: [] }

  // No items at all → 0
  check('empty items → 0', store.projectedReward(emptyState, [], 19), 0)

  // 1 pending today, cutoff=19: per-task 10 + daily-perfect (10 + 50) = 70
  check('1 today pending, cutoff=19 → 70',
    store.projectedReward(emptyState,
      [{ occurrenceDate: T, occurrence: { status: 'todo' } }], 19), 70)

  // Same, cutoff=22 (no early-bird): 10 + 10 = 20
  check('1 today pending, cutoff=22 → 20',
    store.projectedReward(emptyState,
      [{ occurrenceDate: T, occurrence: { status: 'todo' } }], 22), 20)

  // 1 done today (paid 10) + 1 pending today, cutoff=19:
  // per-task 10 + daily-perfect (10 done + 10 pending + 50) = 80
  check('1 done + 1 pending today, cutoff=19 → 80',
    store.projectedReward(emptyState, [
      { occurrenceDate: T, occurrence: { status: 'done', rewardPaid: 10 } },
      { occurrenceDate: T, occurrence: { status: 'todo' } }
    ], 19), 80)

  // 1 pending overdue + 1 pending today, cutoff=19:
  // per-task: 5 (overdue) + 10 (today) = 15
  // daily-perfect for today: 10 (the pending today) + 50 = 60
  // total = 75
  check('1 overdue + 1 today pending, cutoff=19 → 75',
    store.projectedReward(emptyState, [
      { occurrenceDate: Y, occurrence: { status: 'todo' } },
      { occurrenceDate: T, occurrence: { status: 'todo' } }
    ], 19), 75)

  // 1 pending future (no today item), cutoff=19:
  // per-task: 15. No today items → no daily-perfect projected.
  // total = 15.
  check('1 future pending (no today), cutoff=19 → 15',
    store.projectedReward(emptyState,
      [{ occurrenceDate: M, occurrence: { status: 'todo' } }], 19), 15)

  // Today already a perfect day, 0 pending today, but 1 overdue pending:
  // perfect skipped (today is perfect). Only per-task overdue 5.
  check('today already perfect + 1 overdue pending → 5',
    store.projectedReward({ completionsByDay: {}, perfectDays: [T] },
      [{ occurrenceDate: Y, occurrence: { status: 'todo' } }], 19), 5)

  // Cap exhausted (completionsToday = 20): 3 pending today pay 0.
  // todayRewardPaidSum = 0 (no rewardPaid), early-bird 50 still applies because
  // the projection still completes today's perfect-day (all 3 done, just paid 0).
  // total = 0 + 50 = 50.
  check('cap exhausted, 3 today pending, cutoff=19 → 50 (early-bird only)',
    store.projectedReward({ completionsByDay: { [T]: 20 }, perfectDays: [] }, [
      { occurrenceDate: T, occurrence: { status: 'todo' } },
      { occurrenceDate: T, occurrence: { status: 'todo' } },
      { occurrenceDate: T, occurrence: { status: 'todo' } }
    ], 19), 50)

  // Partial cap: completionsToday = 18, 5 pending today. First 2 pay 10, rest 0.
  // perTask = 20. todayRewardPaidSum = 20. daily-perfect = 20 + 50 = 70.
  // total = 90.
  check('partial cap (2 slots left), 5 today pending, cutoff=19 → 90',
    store.projectedReward({ completionsByDay: { [T]: 18 }, perfectDays: [] },
      Array.from({ length: 5 }, () =>
        ({ occurrenceDate: T, occurrence: { status: 'todo' } })
      ), 19), 90)

  // Three cutoff comparison (3 today pending, no done):
  //   cutoff=19: per-task 30 + (30 + 50) = 110
  //   cutoff=20: per-task 30 + (30 + 30) = 90
  //   cutoff=21: per-task 30 + (30 + 20) = 80
  const threeToday = Array.from({ length: 3 }, () =>
    ({ occurrenceDate: T, occurrence: { status: 'todo' } })
  )
  check('3 today pending, cutoff=19 → 110', store.projectedReward(emptyState, threeToday, 19), 110)
  check('3 today pending, cutoff=20 → 90',  store.projectedReward(emptyState, threeToday, 20), 90)
  check('3 today pending, cutoff=21 → 80',  store.projectedReward(emptyState, threeToday, 21), 80)
}

// === Test 10: PET_SPECIES includes parrot ===
console.log('\n[species] roster:')
const species = store.PET_SPECIES
check('PET_SPECIES.length = 9', species.length, 9)
const parrot = species.find((s) => s.id === 'parrot')
check('parrot entry exists', !!parrot, true)
check('parrot emoji = 🦜', parrot && parrot.emoji, '🦜')
check('parrot label = 鹦鹉', parrot && parrot.label, '鹦鹉')

// === Test 11: switchPetSpecies — gate, deduct, preserve attrs ===
console.log('\n[switch] switchPetSpecies:')
seedNTasksToday(0)
store = freshStore()
// Set up pet at level 3 with custom name + middling stats, plus 50 coins (not enough)
let cur3 = JSON.parse(storage['homework-pet-v1'])
cur3.coins = 50
cur3.pet = {
  species: 'cat', emoji: '🐱', name: '豆豆',
  bornAt: Date.now() - 86400000, lastDecayAt: Date.now(),
  level: 3, happiness: 70, fullness: 65, cleanliness: 80, health: 88
}
storage['homework-pet-v1'] = JSON.stringify(cur3)
store = freshStore()
check('PET_SWITCH_COST = 100', store.PET_SWITCH_COST, 100)
const sw1 = store.switchPetSpecies('parrot')
check('coins=50 → not-enough-coins', sw1.ok, false)
check('reason = not-enough-coins', sw1.reason, 'not-enough-coins')
check('pet.species unchanged after rejected switch', store.getStateWithComputed().pet.species, 'cat')
check('coins unchanged after rejected switch', store.getStateWithComputed().coins, 50)

// Top up to 150 and switch — should succeed and preserve everything
const cur4 = JSON.parse(storage['homework-pet-v1'])
cur4.coins = 150
storage['homework-pet-v1'] = JSON.stringify(cur4)
store = freshStore()
const sw2 = store.switchPetSpecies('parrot')
check('coins=150 ≥ 100 → ok', sw2.ok, true)
check('returned species = parrot', sw2.species, 'parrot')
const afterSwitch = store.getStateWithComputed()
check('coins decremented by 100', afterSwitch.coins, 50)
check('pet.species = parrot', afterSwitch.pet.species, 'parrot')
check('pet.emoji = 🦜', afterSwitch.pet.emoji, '🦜')
check('pet.name preserved', afterSwitch.pet.name, '豆豆')
check('pet.level preserved', afterSwitch.pet.level, 3)
// Stats: decay-commit may shave them slightly (see commitPetDecay), so just
// verify they're close to original — this proves the switch isn't a reset.
check('pet.cleanliness still ≥ 70 (preserved, not reset to 100)',
  afterSwitch.pet.cleanliness >= 70 && afterSwitch.pet.cleanliness <= 80, true)
check('pet.health still ≥ 80 (preserved, not reset to 100)',
  afterSwitch.pet.health >= 80 && afterSwitch.pet.health <= 88, true)

// Switching to same species → rejected
const sw3 = store.switchPetSpecies('parrot')
check('same-species switch rejected', sw3.ok, false)
check('reason = same-species', sw3.reason, 'same-species')

// Unknown species → rejected
const sw4 = store.switchPetSpecies('dragon')
check('unknown species rejected', sw4.ok, false)

// Test 12 (findNotebookByName / 重命名校验) 在 v3 拍平作业本后已无意义,删除。

// === Test 13: estimateTaskMinutes — 0/1/3 history + weighting ===
console.log('\n[estimate] estimateTaskMinutes:')
function seedFinishedTasks(samples) {
  const today = todayStr()
  const tasks = samples.map((s, i) => ({
    id: `tf${i}`, notebookId: 'nb_today',
    subject: s.subject || '语', content: s.name,
    estimatedMinutes: 5, order: i, createdAt: 1,
    status: 'done', startedAt: null, currentSegmentStartedAt: null,
    accumulatedMs: s.minutes * 60000,
    completedAt: Date.now() - s.daysAgo * 86400000,
    actualMinutes: s.minutes
  }))
  storage = {}
  storage['homework-pet-v1'] = JSON.stringify({
    schemaVersion: 2, coins: 0, streakDays: 0, perfectDays: [],
    pendingShareCoins: 0,
    editTaskId: null, editNotebookId: null,
    ocrCurrentJob: null, ocrJobs: [],
    pet: {}, shopItems: [],
    notebooks: [{
      id: 'nb_today', name: 'today', mode: 'one-shot',
      startDate: today, endDate: today, recurrence: null,
      createdAt: 1, order: 0
    }],
    tasks, profile: { nickname: '' }
  })
}

// 0 history → null
seedFinishedTasks([])
store = freshStore()
check('0 history → null', store.estimateTaskMinutes('口算', '数'), null)
check('findFinishedTasksByName returns empty for 0 history',
  store.findFinishedTasksByName('口算', '数').length, 0)

// 1 history → null (need ≥2 samples)
seedFinishedTasks([{ name: '口算', subject: '数', minutes: 20, daysAgo: 1 }])
store = freshStore()
check('1 history → null (need ≥2)', store.estimateTaskMinutes('口算', '数'), null)
check('findFinishedTasksByName returns 1 row',
  store.findFinishedTasksByName('口算', '数').length, 1)

// 3 history (similar minutes, all recent) → returns rounded, multiple of 5,
// in the right neighborhood
seedFinishedTasks([
  { name: '口算', subject: '数', minutes: 20, daysAgo: 1 },
  { name: '口算', subject: '数', minutes: 25, daysAgo: 2 },
  { name: '口算', subject: '数', minutes: 30, daysAgo: 3 }
])
store = freshStore()
const est3 = store.estimateTaskMinutes('口算', '数')
check('3 history → returns a number', typeof est3 === 'number', true)
check('3 history → multiple of 5', est3 % 5, 0)
check('3 history → between 20 and 30', est3 >= 20 && est3 <= 30, true)

// Weighted: 60min one day ago vs 10min thirty days ago. With TAU=7d the
// 30-day-old sample's weight ≈ exp(-30/7) ≈ 0.0136, vs the 1-day-old
// sample's weight ≈ exp(-1/7) ≈ 0.867. Weighted avg ≈ (60*.867 + 10*.0136)/
// (.867 + .0136) ≈ 59.2 → rounds to 60. So result must clearly bias toward 60.
seedFinishedTasks([
  { name: '阅读', subject: '语', minutes: 60, daysAgo: 1 },
  { name: '阅读', subject: '语', minutes: 10, daysAgo: 30 }
])
store = freshStore()
const estW = store.estimateTaskMinutes('阅读', '语')
check('weighted: recent 60 dominates 30-day-old 10 → ≥ 50', estW >= 50, true)
check('weighted: result ≤ 60 (the recent sample)', estW <= 60, true)

// Estimate ignores subject mismatch
seedFinishedTasks([
  { name: '复习', subject: '数', minutes: 20, daysAgo: 1 },
  { name: '复习', subject: '数', minutes: 25, daysAgo: 2 }
])
store = freshStore()
check('estimate matches when subject matches',
  typeof store.estimateTaskMinutes('复习', '数') === 'number', true)
check('estimate returns null when subject mismatches',
  store.estimateTaskMinutes('复习', '英'), null)

// Trim whitespace on the lookup name
seedFinishedTasks([
  { name: '抄写课文', subject: '语', minutes: 15, daysAgo: 1 },
  { name: '抄写课文', subject: '语', minutes: 20, daysAgo: 2 }
])
store = freshStore()
check('whitespace-trimmed lookup matches stored name',
  typeof store.estimateTaskMinutes('  抄写课文 ', '语') === 'number', true)

// === Test 13b: inferSubjectByName — frequency vote on done history ===
console.log('\n[infer] inferSubjectByName:')
seedFinishedTasks([])
store = freshStore()
check('0 history → null', store.inferSubjectByName('口算'), null)

// 1 history → return that lone subject (no rival to tie with).
seedFinishedTasks([{ name: '口算', subject: '数', minutes: 20, daysAgo: 1 }])
store = freshStore()
const inf1 = store.inferSubjectByName('口算')
check('1 history → returns the lone subject', inf1 && inf1.subject, '数')
check('1 history → confidence = 1', inf1 && inf1.confidence, 1)

// 3 history with 2 数 + 1 语 → 数 (top1 strictly beats top2).
seedFinishedTasks([
  { name: '阅读', subject: '数', minutes: 20, daysAgo: 1 },
  { name: '阅读', subject: '数', minutes: 20, daysAgo: 2 },
  { name: '阅读', subject: '语', minutes: 25, daysAgo: 3 }
])
store = freshStore()
const inf3 = store.inferSubjectByName('阅读')
check('2v1 → returns 数', inf3 && inf3.subject, '数')
check('2v1 → confidence = 2', inf3 && inf3.confidence, 2)

// 2 数 + 2 语 (perfectly even) → null. Caller leaves it to the user.
seedFinishedTasks([
  { name: '复习', subject: '数', minutes: 15, daysAgo: 1 },
  { name: '复习', subject: '数', minutes: 15, daysAgo: 2 },
  { name: '复习', subject: '语', minutes: 15, daysAgo: 3 },
  { name: '复习', subject: '语', minutes: 15, daysAgo: 4 }
])
store = freshStore()
check('2v2 even split → null', store.inferSubjectByName('复习'), null)

// Whitespace on the lookup name should still match (same trim as estimate).
seedFinishedTasks([
  { name: '听写', subject: '语', minutes: 10, daysAgo: 1 },
  { name: '听写', subject: '语', minutes: 10, daysAgo: 2 }
])
store = freshStore()
const infTrim = store.inferSubjectByName('  听写  ')
check('trims lookup name', infTrim && infTrim.subject, '语')

// Test 14 (notebook merge / rename / overwrite) 在 v3 已无意义,删除。
// 分享接收页现在按 task 勾选导入,语义简单(append-only),无 rename/merge/overwrite 分支。

// === Test 15: import auto-estimates from history (v2 payload, v3 importSharedTasks) ===
console.log('\n[share-import] auto-estimate on import:')
// Seed 历史 "口算练习" 完成记录,导入 v2 share 携带 "口算练习" → 接收方按历史估时。
const seededHistory = [
  { name: '口算练习', subject: '数', minutes: 20, daysAgo: 1 },
  { name: '口算练习', subject: '数', minutes: 20, daysAgo: 2 },
  { name: '口算练习', subject: '数', minutes: 25, daysAgo: 3 }
]
seedFinishedTasks(seededHistory)
store = freshStore()
const importedIds = store.importSharedTasks({
  v: 2, from: '', sharer: '', shareId: 'remote-2', d: today,
  t: [
    { s: '数', o: '其他', c: '口算练习', mo: 'one-shot', sd: today, ed: today, r: null },
    { s: '数', o: '其他', c: '从未做过的题', mo: 'one-shot', sd: today, ed: today, r: null }
  ]
})
check('importSharedTasks returns 2 new ids', importedIds && importedIds.length, 2)
const imported = store.getStateWithComputed().tasks.filter((t) => importedIds.indexOf(t.id) >= 0)
const matched = imported.find((t) => t.content === '口算练习')
const unmatched = imported.find((t) => t.content === '从未做过的题')
check('imported task with history → estimatedMinutes > 0',
  matched && matched.estimatedMinutes > 0, true)
check('imported task with history → estimatedMinutes is multiple of 5',
  matched.estimatedMinutes % 5, 0)
check('imported task w/o history → estimatedMinutes = 0',
  unmatched && unmatched.estimatedMinutes, 0)

// Test 16 (duplicateNotebook) 在 v3 已无意义,删除。

console.log(`\n  ${pass} passed, ${fail} failed.\n`)
process.exit(fail === 0 ? 0 : 1)
