#!/usr/bin/env node
// 批量评估 homeworkOCR prompt:对 samples/ 下所有(或指定的)样本跑一遍 Vision OCR,
// 按 Dice 系数 1-to-1 配对,输出每个样本的命中明细 + 总召回/精确度。
//
// 前置:~/.zshrc 里已有 AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT。
//      Azure 这台资源约定 deployment 名 == 模型名,所以不必单独设 DEPLOYMENT;
//      默认走 gpt-5.5,想换模型用 OPENAI_OCR_MODEL=gpt-5 覆盖。
//
// 用法:
//   # 跑所有样本(默认 gpt-5.5, reasoning='low')
//   node miniapp-starter/scripts/eval-homework-ocr.js
//
//   # 跑指定样本
//   node miniapp-starter/scripts/eval-homework-ocr.js samples/homework-2026-04-20.json
//
//   # 复现云函数 60s 限制下的行为
//   OCR_REASONING_EFFORT=none  node miniapp-starter/scripts/eval-homework-ocr.js
//
//   # 写 markdown 报告到 samples/_reports/
//   node miniapp-starter/scripts/eval-homework-ocr.js --report

'use strict'

const fs = require('fs')
const path = require('path')
const lib = require('./lib/homework-ocr')

const DEFAULT_SAMPLES_DIR = path.resolve(__dirname, '..', 'samples')
// 输出报告写到这个目录(可选,带 --report 才写)
const REPORT_DIR = path.resolve(__dirname, '..', 'samples', '_reports')

function parseArgs(argv) {
  const args = { paths: [], report: false, jsonOut: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--report') args.report = true
    else if (a === '--json') args.jsonOut = true
    else if (a === '-h' || a === '--help') args.help = true
    else args.paths.push(a)
  }
  return args
}

function helpText() {
  return [
    '用法: node scripts/eval-homework-ocr.js [options] [sample.json ...]',
    '',
    '不传 sample 路径时遍历 samples/*.json。',
    '',
    'Options:',
    '  --report   写一份 markdown 报告到 samples/_reports/<timestamp>.md',
    '  --json     stdout 输出整体 JSON(适合机读 / CI 解析),不打人类可读 summary',
    '  -h         本帮助',
    '',
    'Env(本机 ~/.zshrc 已配 KEY+ENDPOINT,通常不必再传):',
    '  AZURE_OPENAI_API_KEY      Azure key',
    '  AZURE_OPENAI_ENDPOINT     形如 https://<resource>.openai.azure.com',
    '  OPENAI_OCR_MODEL          覆盖默认模型(默认 gpt-5.5);本资源 deployment 名',
    '                            == 模型名,所以不必单独设 AZURE_OPENAI_DEPLOYMENT',
    '  OCR_REASONING_EFFORT      默认 \'low\'(本地最稳);云函数因 60s timeout 用',
    '                            \'none\',改 \'none\' 复现云端行为'
  ].join('\n')
}

function formatPair(label, draft, score) {
  if (!draft) return `  ${label}  ✗ MISS`
  const subj = draft.subject || '?'
  return `  ${label}  ✓ score=${score.toFixed(2)}  → [${subj}] ${draft.content}`
}

function evalOneSample(sample, ocrResult) {
  const { drafts } = ocrResult
  const score = lib.scoreDrafts(drafts, sample.groundTruth)
  return {
    sample: sample.id,
    capturedAt: sample.capturedAt,
    notes: sample.notes,
    image: sample.image,
    model: ocrResult.model,
    effort: ocrResult.effort,
    source: ocrResult.source,
    elapsedMs: ocrResult.elapsedMs,
    expected: sample.groundTruth.length,
    drafts: drafts.length,
    matched: score.matches.length,
    recall: score.recall,
    precision: score.precision,
    avgScore: score.avgScore,
    matches: score.matches,
    unmatchedExpected: score.unmatchedExpected,
    unmatchedDrafts: score.unmatchedDrafts,
    rawText: ocrResult.rawText,
    rawDrafts: drafts
  }
}

function printSampleHuman(result) {
  console.log(`\n=== ${result.sample}${result.capturedAt ? ' (' + result.capturedAt + ')' : ''} ===`)
  if (result.notes) console.log(`备注: ${result.notes}`)
  console.log(`模型: ${result.model}${result.effort ? ' / effort=' + result.effort : ''} / ${result.source} / ${result.elapsedMs}ms`)
  console.log(`drafts ${result.drafts}, expected ${result.expected}, matched ${result.matched}`)

  // 配对表:每条 expected 显示是否命中 + 哪条 draft 中
  // 把 matches 索引化方便查
  const matchByExpected = new Map()
  for (const m of result.matches) {
    matchByExpected.set(m.expected.content + '|' + (m.expected.subject || ''), m)
  }
  console.log('\n  Ground truth → draft:')
  for (const exp of [...result.matches.map((m) => m.expected), ...result.unmatchedExpected]) {
    // 顺序按原 groundTruth 来更直观;这里简化:matched 先列,unmatched 后列
  }
  // 直接重打一份按原顺序
  const matchSet = new Set(result.matches.map((m) => m.expected))
  const expectedAll = [...result.matches.map((m) => m.expected), ...result.unmatchedExpected]
  // 上面顺序可能跟原 groundTruth 不一致——简化处理:按 matched 先,再 missing
  for (const exp of expectedAll) {
    const m = result.matches.find((x) => x.expected === exp)
    const subj = exp.subject || '?'
    if (m) {
      console.log(`  ✓ score=${m.score.toFixed(2)}  期望:[${subj}] ${exp.content}  → ${m.draft.content}`)
    } else {
      console.log(`  ✗ MISS         期望:[${subj}] ${exp.content}`)
    }
  }
  if (result.unmatchedDrafts.length) {
    console.log('\n  多出的 drafts(可能是过拆 / 误识别 / 模板字段):')
    for (const d of result.unmatchedDrafts) {
      console.log(`  ? [${d.subject || '?'}] ${d.content}`)
    }
  }
  console.log(`\n  Recall:    ${(result.recall * 100).toFixed(1)}%  (${result.matched}/${result.expected})`)
  console.log(`  Precision: ${(result.precision * 100).toFixed(1)}%  (${result.matched}/${result.drafts})`)
  console.log(`  AvgScore:  ${result.avgScore.toFixed(2)}  (命中 pair 的平均 Dice)`)
}

function printAggregate(results) {
  const totals = results.reduce((acc, r) => {
    acc.expected += r.expected
    acc.drafts += r.drafts
    acc.matched += r.matched
    acc.elapsedMs += r.elapsedMs
    return acc
  }, { expected: 0, drafts: 0, matched: 0, elapsedMs: 0 })
  const recall = totals.expected ? totals.matched / totals.expected : 0
  const precision = totals.drafts ? totals.matched / totals.drafts : 0
  const avgScore = results.length
    ? results.reduce((s, r) => s + r.avgScore, 0) / results.length
    : 0

  console.log(`\n=== Aggregate (${results.length} samples) ===`)
  for (const r of results) {
    const perfect = r.recall === 1 && r.precision === 1
    const flag = perfect ? '✓✓✓' : (r.recall === 1 ? '✓R' : '⚠')
    console.log(`  ${flag} ${r.sample}: recall=${(r.recall * 100).toFixed(0)}% precision=${(r.precision * 100).toFixed(0)}% (${r.matched}/${r.expected} ↦ ${r.drafts}) ${r.elapsedMs}ms`)
  }
  console.log(`\n  总 Recall:    ${(recall * 100).toFixed(1)}%  (${totals.matched}/${totals.expected})`)
  console.log(`  总 Precision: ${(precision * 100).toFixed(1)}%  (${totals.matched}/${totals.drafts})`)
  console.log(`  AvgScore:     ${avgScore.toFixed(2)}`)
  console.log(`  Total time:   ${Math.round(totals.elapsedMs / 1000)}s`)
}

function buildMarkdownReport(results) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const totals = results.reduce((acc, r) => {
    acc.expected += r.expected; acc.drafts += r.drafts; acc.matched += r.matched; return acc
  }, { expected: 0, drafts: 0, matched: 0 })
  const recall = totals.expected ? totals.matched / totals.expected : 0
  const precision = totals.drafts ? totals.matched / totals.drafts : 0

  const lines = [
    `# homeworkOCR eval ${ts}`,
    '',
    `**Aggregate**: recall=${(recall * 100).toFixed(1)}% (${totals.matched}/${totals.expected}), precision=${(precision * 100).toFixed(1)}% (${totals.matched}/${totals.drafts})`,
    '',
    `Model: ${results[0] ? results[0].model : 'n/a'} / effort=${results[0] && results[0].effort ? results[0].effort : 'n/a'}`,
    '',
    '## Per-sample',
    '',
    '| Sample | Recall | Precision | Matched | Drafts | Expected | AvgScore | Time |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |'
  ]
  for (const r of results) {
    lines.push(`| ${r.sample} | ${(r.recall * 100).toFixed(1)}% | ${(r.precision * 100).toFixed(1)}% | ${r.matched} | ${r.drafts} | ${r.expected} | ${r.avgScore.toFixed(2)} | ${r.elapsedMs}ms |`)
  }
  // misses
  lines.push('', '## Misses')
  for (const r of results) {
    if (r.unmatchedExpected.length === 0 && r.unmatchedDrafts.length === 0) continue
    lines.push('', `### ${r.sample}`)
    if (r.unmatchedExpected.length) {
      lines.push('', '**漏识别 (ground truth not matched):**')
      for (const e of r.unmatchedExpected) {
        lines.push(`- [${e.subject || '?'}] ${e.content}`)
      }
    }
    if (r.unmatchedDrafts.length) {
      lines.push('', '**多出/错识别 (drafts not matched to any ground truth):**')
      for (const d of r.unmatchedDrafts) {
        lines.push(`- [${d.subject || '?'}] ${d.content}`)
      }
    }
  }
  return { content: lines.join('\n'), filename: `eval-${ts}.md` }
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    console.log(helpText())
    process.exit(0)
  }
  const samplePaths = args.paths.length ? args.paths : lib.listSamples(DEFAULT_SAMPLES_DIR)
  if (samplePaths.length === 0) {
    console.error(`没找到任何 sample。把 sample JSON 放到 ${DEFAULT_SAMPLES_DIR}/ 下,或显式传路径。`)
    process.exit(1)
  }

  const results = []
  for (let i = 0; i < samplePaths.length; i++) {
    const samplePath = samplePaths[i]
    if (!args.jsonOut) console.log(`\n[${i + 1}/${samplePaths.length}] ${samplePath}`)
    let sample, ocrResult
    try {
      sample = lib.loadSample(samplePath)
    } catch (err) {
      if (!args.jsonOut) console.error(`  加载失败: ${err.message}`)
      continue
    }
    try {
      ocrResult = await lib.callOcr(sample.imageAbsPath)
    } catch (err) {
      if (!args.jsonOut) {
        console.error(`  OCR 调用失败: ${err.message}`)
        if (err.body) console.error(JSON.stringify(err.body, null, 2))
      }
      // 仍记录,以便 aggregate 不会丢条目
      results.push({
        sample: sample.id, capturedAt: sample.capturedAt, notes: sample.notes,
        image: sample.image, model: '?', effort: null, source: 'error', elapsedMs: 0,
        expected: sample.groundTruth.length, drafts: 0, matched: 0,
        recall: 0, precision: 0, avgScore: 0,
        matches: [], unmatchedExpected: sample.groundTruth, unmatchedDrafts: [],
        rawText: '', rawDrafts: [], error: err.message
      })
      continue
    }
    const result = evalOneSample(sample, ocrResult)
    results.push(result)
    if (!args.jsonOut) printSampleHuman(result)
  }

  if (args.jsonOut) {
    console.log(JSON.stringify(results, null, 2))
  } else {
    printAggregate(results)
  }

  if (args.report) {
    if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true })
    const { content, filename } = buildMarkdownReport(results)
    const out = path.join(REPORT_DIR, filename)
    fs.writeFileSync(out, content, 'utf8')
    if (!args.jsonOut) console.log(`\n报告已写入: ${out}`)
  }
}

main().catch((err) => {
  console.error('[fatal]', err.message)
  if (err.body) console.error(JSON.stringify(err.body, null, 2))
  process.exit(99)
})
