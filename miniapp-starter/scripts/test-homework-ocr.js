#!/usr/bin/env node
// 单图 ad-hoc 测试:跑一张图,可选附带 sample JSON(自带 ground truth)做对比。
// 想做批量评估(整个 samples/ 目录)用 scripts/eval-homework-ocr.js。
//
// 用法:
//   # 用 sample(自带 ground truth):
//   AZURE_OPENAI_API_KEY=...  AZURE_OPENAI_ENDPOINT=...  AZURE_OPENAI_DEPLOYMENT=gpt-5.5 \
//     node miniapp-starter/scripts/test-homework-ocr.js samples/homework-2026-04-20.json
//
//   # 直接给图片路径(只识别不评分):
//     node miniapp-starter/scripts/test-homework-ocr.js ~/Downloads/作业登记本.jpg
//
//   # OCR_REASONING_EFFORT=low|none|medium|high 可调

'use strict'

const fs = require('fs')
const path = require('path')
const lib = require('./lib/homework-ocr')

async function main() {
  const arg = process.argv[2]
  if (!arg) {
    console.error('用法: node scripts/test-homework-ocr.js <image_path | sample.json>')
    process.exit(1)
  }
  const abs = path.resolve(arg)
  if (!fs.existsSync(abs)) {
    console.error(`文件不存在: ${abs}`)
    process.exit(1)
  }

  let imagePath, sample = null
  if (abs.endsWith('.json')) {
    sample = lib.loadSample(abs)
    imagePath = sample.imageAbsPath
  } else {
    imagePath = abs
  }

  console.log(`[info] 图片: ${imagePath} (${fs.statSync(imagePath).size} bytes)`)
  console.log(`[info] provider: ${lib.isAzure() ? 'Azure OpenAI' : 'OpenAI'}`)
  console.log(`[info] endpoint: ${lib.getEndpoint()}`)
  console.log(`[info] model/deployment: ${lib.getDeploymentOrModel()}`)
  if (lib.isReasoningModel(lib.getDeploymentOrModel())) {
    console.log(`[info] reasoning effort: ${lib.getReasoningEffort()}`)
  }
  console.log('[info] 调用中...')

  const result = await lib.callOcr(imagePath)
  console.log(`[info] 通道: ${result.source}, 耗时: ${result.elapsedMs} ms`)

  console.log('\n=== rawText ===')
  console.log(result.rawText || '(空)')

  console.log(`\n=== drafts (${result.drafts.length}) ===`)
  result.drafts.forEach((d, i) => {
    console.log(`#${i + 1} [${d.subject || '?'}] ${d.content}  (置信度=${d.confidence}, needsConfirm=${d.needsConfirm})`)
    if (d.rawText && d.rawText !== d.content) console.log(`    原文: ${d.rawText}`)
  })

  if (!sample) return

  // 有 sample → 做评分
  const score = lib.scoreDrafts(result.drafts, sample.groundTruth)
  console.log('\n=== 与 ground truth 对比 ===')
  const matchByExp = new Map(score.matches.map((m) => [m.expected, m]))
  for (const exp of sample.groundTruth) {
    const m = matchByExp.get(exp)
    const subj = exp.subject || '?'
    if (m) {
      console.log(`✓ score=${m.score.toFixed(2)}  期望:[${subj}] ${exp.content}  → ${m.draft.content}`)
    } else {
      console.log(`✗ MISS         期望:[${subj}] ${exp.content}`)
    }
  }
  if (score.unmatchedDrafts.length) {
    console.log('\n--- 多出的 drafts(可能过拆 / 误识别 / 模板字段) ---')
    for (const d of score.unmatchedDrafts) {
      console.log(`  ? [${d.subject || '?'}] ${d.content}`)
    }
  }
  console.log(`\nRecall:    ${(score.recall * 100).toFixed(1)}%  (${score.matches.length}/${sample.groundTruth.length})`)
  console.log(`Precision: ${(score.precision * 100).toFixed(1)}%  (${score.matches.length}/${result.drafts.length})`)
  console.log(`AvgScore:  ${score.avgScore.toFixed(2)}  (命中 pair 的平均 Dice)`)
}

main().catch((err) => {
  console.error('[error]', err.message)
  if (err.body) console.error(JSON.stringify(err.body, null, 2))
  process.exit(99)
})
