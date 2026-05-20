#!/usr/bin/env node
// 把云端 ocr-result 页保存的样本拉回本地 samples/,跑离线 eval。
//
// 用户每次完成「拍照-识别-导入」,页面会把(图片 fileID + 用户最终确认的作业列表)
// 上传到 cloud://.../homework-register-samples/<stem>.json。本脚本:
//   1. tcb storage list homework-register-samples/ --json 拿到所有样本
//   2. 逐个下载 sample JSON,读出 imageFileID,再下载对应图片到 samples/<stem>.jpg
//   3. 把 JSON 改写成 samples/README.md 里描述的 ground-truth schema,
//      写到 samples/<stem>.json
//
// 用法:
//   node miniapp-starter/scripts/pull-ocr-samples.js               # 全量拉,覆盖本地
//   node miniapp-starter/scripts/pull-ocr-samples.js --keep        # 本地已有同名跳过
//   node miniapp-starter/scripts/pull-ocr-samples.js --dry-run     # 只列出会做什么
//
// 前置:本机装好 tcb-cli(`npm i -g @cloudbase/cli`),并 `tcb login` 过。
//      envId 走 ../cloudbaserc.json,跟项目对齐。

'use strict'

const fs = require('fs')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const SAMPLES_DIR = path.join(PROJECT_ROOT, 'samples')
const TMP_DIR = path.join(PROJECT_ROOT, '.cache', 'ocr-samples')
const REMOTE_PREFIX = 'homework-register-samples'

function parseArgs() {
  const args = { keep: false, dryRun: false }
  for (const a of process.argv.slice(2)) {
    if (a === '--keep' || a === '--keep-existing') args.keep = true
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n')
        .filter((l) => l.startsWith('//')).join('\n'))
      process.exit(0)
    }
  }
  return args
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }) }

function tcb(args, opts = {}) {
  const r = spawnSync('tcb', args, { encoding: 'utf8', cwd: PROJECT_ROOT, ...opts })
  if (r.status !== 0) {
    const err = new Error(`tcb ${args.join(' ')} 失败 (code=${r.status})`)
    err.stdout = r.stdout
    err.stderr = r.stderr
    throw err
  }
  return r.stdout
}

function listRemoteSamples() {
  // tcb storage list 没 --recursive,需要先拿目录再过滤
  const raw = tcb(['storage', 'list', `${REMOTE_PREFIX}/`, '--json'])
  let parsed
  try { parsed = JSON.parse(raw) } catch (_) {
    // 兜底:有些版本 --json 返回的是数组,有些是 { data: [...] }
    parsed = []
  }
  const arr = Array.isArray(parsed) ? parsed : (parsed && parsed.data) || []
  return arr
    .map((item) => item.Key || item.key || item.name || item.cloudPath || '')
    .filter((k) => k.endsWith('.json'))
}

function parseFileIDToCloudPath(fileID) {
  // cloud://<env-with-suffix>/path/to/file.ext → path/to/file.ext
  if (!fileID || !fileID.startsWith('cloud://')) return ''
  const idx = fileID.indexOf('/', 'cloud://'.length)
  return idx > 0 ? fileID.slice(idx + 1) : ''
}

function basenameStem(p) {
  return path.basename(p).replace(/\.[^.]+$/, '')
}

function main() {
  const args = parseArgs()
  ensureDir(SAMPLES_DIR)
  ensureDir(TMP_DIR)

  console.log(`[1/3] 列出云端 ${REMOTE_PREFIX}/ ...`)
  let remoteKeys
  try {
    remoteKeys = listRemoteSamples()
  } catch (e) {
    console.error('云端列样本失败:', e.message)
    if (e.stderr) console.error(e.stderr)
    console.error('确认已 tcb login,且 cloudbaserc.json 里的 envId 正确。')
    process.exit(1)
  }
  console.log(`  发现 ${remoteKeys.length} 个 JSON 样本`)

  let imported = 0, skipped = 0, failed = 0
  for (const cloudKey of remoteKeys) {
    const stem = basenameStem(cloudKey)
    const targetJson = path.join(SAMPLES_DIR, `${stem}.json`)
    const targetImg = path.join(SAMPLES_DIR, `${stem}.jpg`)

    if (args.keep && fs.existsSync(targetJson)) {
      console.log(`  ⊙ skip ${stem} (本地已有)`)
      skipped++
      continue
    }

    if (args.dryRun) {
      console.log(`  ▷ would pull ${stem}`)
      imported++
      continue
    }

    const tmpJson = path.join(TMP_DIR, `${stem}.json`)
    try {
      tcb(['storage', 'download', cloudKey, tmpJson])
    } catch (e) {
      console.warn(`  ✗ ${stem}.json 下载失败:${e.message}`)
      failed++
      continue
    }

    let sample
    try {
      sample = JSON.parse(fs.readFileSync(tmpJson, 'utf8'))
    } catch (_) {
      console.warn(`  ✗ ${stem}.json 解析失败`)
      failed++
      continue
    }

    const imageCloudPath = parseFileIDToCloudPath(sample.imageFileID || '')
    if (!imageCloudPath) {
      console.warn(`  ✗ ${stem}.json 缺 imageFileID,跳过`)
      failed++
      continue
    }

    try {
      tcb(['storage', 'download', imageCloudPath, targetImg])
    } catch (e) {
      console.warn(`  ✗ ${stem}.jpg 下载失败 (${imageCloudPath}):${e.message}`)
      failed++
      continue
    }

    const normalized = {
      groundTruth: sample.groundTruth || [],
      ocrSource: sample.ocrSource || '',
      ocrRawText: sample.ocrRawText || '',
      ocrDrafts: sample.ocrDrafts || [],
      capturedAt: sample.capturedAt || '',
      createdAt: sample.createdAt || ''
    }
    fs.writeFileSync(targetJson, JSON.stringify(normalized, null, 2) + '\n', 'utf8')

    console.log(`  ✓ ${stem}.jpg + ${stem}.json  (groundTruth=${normalized.groundTruth.length} 条)`)
    imported++
  }

  console.log(`[2/3] 拉取完成:导入 ${imported},跳过 ${skipped},失败 ${failed}`)
  console.log(`[3/3] 本地路径:${path.relative(process.cwd(), SAMPLES_DIR)}`)
  console.log('')
  console.log('下一步:')
  console.log('  - 检查 samples/<id>.json 的 groundTruth 是否真的是期望')
  console.log('  - 要把通过的样本入仓,用 `git add -f samples/<id>.jpg samples/<id>.json`')
  console.log('  - 跑 `node miniapp-starter/scripts/eval-homework-ocr.js` 做离线评估')
}

if (require.main === module) main()
