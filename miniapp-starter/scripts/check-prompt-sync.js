#!/usr/bin/env node
// 校验 cloudfunctions/homeworkOCR/index.js 里的 prompt 跟 scripts/lib/homework-ocr.js
// 里的导出常量是否完全一致(字符级)。改了任意一边都跑一下,exit code 0 = 一致。
//
//   node miniapp-starter/scripts/check-prompt-sync.js

'use strict'

const fs = require('fs')
const path = require('path')
const lib = require('./lib/homework-ocr')

const CLOUD_FN = path.resolve(__dirname, '..', 'cloudfunctions', 'homeworkOCR', 'index.js')

function extractTemplate(source, varName) {
  // 抓 `const <varName> = [\n  '...',\n  ...\n].join('\n')` 块,eval 出实际字符串
  const re = new RegExp(`const\\s+${varName}\\s*=\\s*(\\[[\\s\\S]*?\\]\\.join\\([^)]+\\))`)
  const m = source.match(re)
  if (!m) throw new Error(`没在 ${path.basename(CLOUD_FN)} 找到 ${varName}`)
  return eval(m[1])
}

function firstDiffLine(a, b) {
  const la = a.split('\n')
  const lb = b.split('\n')
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) {
      return { lineNo: i + 1, cloud: la[i], lib: lb[i] }
    }
  }
  return null
}

const src = fs.readFileSync(CLOUD_FN, 'utf8')
const pairs = [
  ['systemInstructions', 'SYSTEM_INSTRUCTIONS', lib.SYSTEM_INSTRUCTIONS],
  ['userPromptText', 'USER_PROMPT', lib.USER_PROMPT]
]

let bad = 0
for (const [cloudVar, libVar, libValue] of pairs) {
  const cloudValue = extractTemplate(src, cloudVar)
  if (cloudValue === libValue) {
    console.log(`✓ ${cloudVar} (cloud) === ${libVar} (lib)  [${libValue.length} chars]`)
  } else {
    const d = firstDiffLine(cloudValue, libValue)
    console.log(`✗ ${cloudVar} (cloud) !== ${libVar} (lib)`)
    if (d) {
      console.log(`  first diff at line ${d.lineNo}:`)
      console.log(`    cloud: ${JSON.stringify(d.cloud)}`)
      console.log(`    lib:   ${JSON.stringify(d.lib)}`)
    } else {
      console.log(`  cloud: ${cloudValue.length} chars`)
      console.log(`  lib:   ${libValue.length} chars`)
    }
    bad++
  }
}

if (bad > 0) {
  console.error(`\n${bad} prompt(s) out of sync. 改了一边别忘了同步另一边。`)
  process.exit(1)
}
