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

// === Test 5: level cost table ===
console.log('\n[level] cost curve:')
store = freshStore()
check('getLevelCost(1) = 180', store.getLevelCost(1), 180)
check('getLevelCost(2) = 500', store.getLevelCost(2), 500)
check('getLevelCost(3) = 1000', store.getLevelCost(3), 1000)
check('getLevelCost(4) = 2000', store.getLevelCost(4), 2000)
check('getLevelCost(5) = 2000 (plateau)', store.getLevelCost(5), 2000)
check('getLevelCost(8) = 2000 (plateau)', store.getLevelCost(8), 2000)

// === Test 6: levelUpPet — gates on coins, deducts cost, increments level ===
console.log('\n[level] levelUpPet:')
seedNTasksToday(0)  // re-seed so we have a pet at level 1
store = freshStore()
const r1 = store.levelUpPet()
check('coins=0 → not-enough-coins', r1.ok, false)

// Manually grant 200 coins via finishing... easier to mutate the storage.
const cur = JSON.parse(storage['homework-pet-v1'])
cur.coins = 200
storage['homework-pet-v1'] = JSON.stringify(cur)
store = freshStore()
const r2 = store.levelUpPet()
check('coins=200 ≥ 180 → ok', r2.ok, true)
check('level becomes 2', r2.level, 2)
const afterLvl = store.getStateWithComputed()
check('coins decremented by 180', afterLvl.coins, 20)
check('pet.level = 2', afterLvl.pet.level, 2)

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
check('shop totals match design', items.map((i) => i.price), [16, 28, 18, 32, 18, 20, 35, 50])

// Each primary stat needs at least 2 items (cheap + mid tier). The "primary"
// stat is whichever attribute the item lifts the most.
const STAT_KEYS = ['fullness', 'cleanliness', 'happiness', 'health']
const primaryCounts = { fullness: 0, cleanliness: 0, happiness: 0, health: 0 }
for (const it of items) {
  let primary = STAT_KEYS[0]
  for (const k of STAT_KEYS) if ((it[k] | 0) > (it[primary] | 0)) primary = k
  if ((it[primary] | 0) > 0) primaryCounts[primary]++
}
for (const k of STAT_KEYS) {
  check(`stat "${k}" has ≥2 items`, primaryCounts[k] >= 2, true)
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
check('REWARD_DAILY_PERFECT_PER_TASK = 10', store.REWARD_DAILY_PERFECT_PER_TASK, 10)
check('REWARD_WEEKLY_STREAK = 50', store.REWARD_WEEKLY_STREAK, 50)
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
check('lastReward.dailyBonus = 200 (min(25,20)×10)', s.lastReward.dailyBonus, 200)

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

// === Test 12: findNotebookByName + duplicate-name validation ===
console.log('\n[name-dup] findNotebookByName:')
seedNTasksToday(0)
store = freshStore()
const dupNb = store.addNotebook({
  name: '语文', mode: 'one-shot', startDate: today, endDate: today
})
const found = store.findNotebookByName('语文')
check('finds existing by exact name', !!found, true)
check('returns null for unknown name', store.findNotebookByName('不存在'), null)
check('case-sensitive (different chars → no match)',
  store.findNotebookByName('语 文'), null)
check('trims whitespace before compare', !!store.findNotebookByName('  语文  '), true)
const foundId = found && found.id
check('excludeId skips itself (so editing same nb is allowed)',
  store.findNotebookByName('语文', foundId), null)
// Add a second notebook to confirm the function doesn't accidentally match
// a different name.
store.addNotebook({ name: '数学', mode: 'one-shot', startDate: today, endDate: today })
check('still finds 语文 alongside 数学', !!store.findNotebookByName('语文'), true)
check('does not match 数学 when asked for 语文',
  store.findNotebookByName('语文').name, '语文')

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

// === Test 14: duplicate-name handling on share-save ===
console.log('\n[share-import] rename / merge / overwrite:')
seedNTasksToday(0)
store = freshStore()
const existing = store.addNotebook({
  name: '英语 Unit 5', mode: 'one-shot', startDate: today, endDate: today
})
// addNotebook returns full state; pick the new id from notebooks list
const existingId = store.findNotebookByName('英语 Unit 5').id
// Seed one existing task on it via addTask
store.addTask({ notebookId: existingId, subject: '英语', content: '原有作业 A', estimatedMinutes: 10 })

const sharePayload = {
  v: 1, from: '同学', sharer: '', nbId: 'remote-1',
  n: { name: '英语 Unit 5', mode: 'one-shot', startDate: today, endDate: today, recurrence: null },
  t: [
    { s: '英语', c: '分享作业 A' },
    { s: '英语', c: '分享作业 B' }
  ]
}

// rename: a NEW notebook gets created with " 复制" suffix; original untouched
const renameId = store.importSharedNotebook(sharePayload, { mode: 'rename' })
check('rename creates new notebook (different id)', renameId !== existingId, true)
const afterRename = store.getStateWithComputed()
const renamedNb = afterRename.notebooks.find((n) => n.id === renameId)
check('renamed nb name = "英语 Unit 5 复制"', renamedNb.name, '英语 Unit 5 复制')
const origAfterRename = afterRename.notebooks.find((n) => n.id === existingId)
check('original notebook unchanged after rename', origAfterRename.name, '英语 Unit 5')
check('original task list unchanged after rename',
  afterRename.tasks.filter((t) => t.notebookId === existingId).length, 1)
check('renamed nb received 2 imported tasks',
  afterRename.tasks.filter((t) => t.notebookId === renameId).length, 2)

// rename again — should add another " 复制" because "英语 Unit 5 复制" now exists
const rename2Id = store.importSharedNotebook(sharePayload, { mode: 'rename' })
const renamed2 = store.getStateWithComputed().notebooks.find((n) => n.id === rename2Id)
check('second rename → "英语 Unit 5 复制 复制"', renamed2.name, '英语 Unit 5 复制 复制')

// merge: append into existing
seedNTasksToday(0)
store = freshStore()
store.addNotebook({ name: '英语 Unit 5', mode: 'one-shot', startDate: today, endDate: today })
const mergeTargetId = store.findNotebookByName('英语 Unit 5').id
store.addTask({ notebookId: mergeTargetId, subject: '英语', content: '原有作业 A', estimatedMinutes: 10 })
const mergeId = store.importSharedNotebook(sharePayload, {
  mode: 'merge', targetNotebookId: mergeTargetId
})
check('merge returns target notebook id', mergeId, mergeTargetId)
const afterMerge = store.getStateWithComputed()
check('merge appended both shared tasks (1+2 = 3)',
  afterMerge.tasks.filter((t) => t.notebookId === mergeTargetId).length, 3)
const mergedTasks = afterMerge.tasks.filter((t) => t.notebookId === mergeTargetId)
check('all merged tasks land as todo',
  mergedTasks.every((t) => (t.status || 'todo') === 'todo'), true)

// overwrite: replace tasks but KEEP notebook id
seedNTasksToday(0)
store = freshStore()
store.addNotebook({ name: '英语 Unit 5', mode: 'one-shot', startDate: today, endDate: today })
const overwriteTargetId = store.findNotebookByName('英语 Unit 5').id
store.addTask({ notebookId: overwriteTargetId, subject: '英语', content: '原有作业 A', estimatedMinutes: 10 })
store.addTask({ notebookId: overwriteTargetId, subject: '英语', content: '原有作业 B', estimatedMinutes: 15 })
const overId = store.importSharedNotebook(sharePayload, {
  mode: 'overwrite', targetNotebookId: overwriteTargetId
})
check('overwrite preserves notebook id', overId, overwriteTargetId)
const afterOverwrite = store.getStateWithComputed()
check('overwrite drops old tasks + replaces with shared',
  afterOverwrite.tasks.filter((t) => t.notebookId === overwriteTargetId).length, 2)
const overwrittenContents = afterOverwrite.tasks
  .filter((t) => t.notebookId === overwriteTargetId)
  .map((t) => t.content).sort()
check('overwrite tasks come from share', overwrittenContents,
  ['分享作业 A', '分享作业 B'])

// === Test 15: import auto-estimates from history ===
console.log('\n[share-import] auto-estimate on import:')
// Seed a user with finished-task history for "口算练习", then import a share
// containing a "口算练习" — the imported task should pick up an estimate.
const seededHistory = [
  { name: '口算练习', subject: '数', minutes: 20, daysAgo: 1 },
  { name: '口算练习', subject: '数', minutes: 20, daysAgo: 2 },
  { name: '口算练习', subject: '数', minutes: 25, daysAgo: 3 }
]
seedFinishedTasks(seededHistory)
store = freshStore()
const importedId = store.importSharedNotebook({
  v: 1, from: '', sharer: '', nbId: 'remote-2',
  n: { name: '新作业本', mode: 'one-shot', startDate: today, endDate: today, recurrence: null },
  t: [
    { s: '数', c: '口算练习' },          // has history → should be estimated
    { s: '数', c: '从未做过的题' }      // no history → estimatedMinutes stays 0
  ]
}, { mode: 'new' })
const imported = store.getStateWithComputed().tasks.filter((t) => t.notebookId === importedId)
const matched = imported.find((t) => t.content === '口算练习')
const unmatched = imported.find((t) => t.content === '从未做过的题')
check('imported task with history → estimatedMinutes > 0',
  matched && matched.estimatedMinutes > 0, true)
check('imported task with history → estimatedMinutes is multiple of 5',
  matched.estimatedMinutes % 5, 0)
check('imported task w/o history → estimatedMinutes = 0',
  unmatched && unmatched.estimatedMinutes, 0)

console.log(`\n  ${pass} passed, ${fail} failed.\n`)
process.exit(fail === 0 ? 0 : 1)
