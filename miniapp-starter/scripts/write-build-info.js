// 在 upload 前跑一次,把 version + 当前 git commit short hash 写到
// utils/build-info.js,profile 页 require 它显示。
//
// 用法:
//   node scripts/write-build-info.js 1.0.0.YYMMDDNN
//
// 没传 version 时默认 'dev'(适合本地开发预览)。
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const version = process.argv[2] || 'dev'

let commitId = 'unknown'
try {
  commitId = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim()
} catch (e) {
  console.warn('git rev-parse failed, commitId=unknown:', e.message)
}

const content = `// 自动生成 —— 由 scripts/write-build-info.js 写入,不要手改。
module.exports = {
  version: '${version}',
  commitId: '${commitId}',
  builtAt: ${Date.now()}
}
`

const out = path.join(__dirname, '..', 'utils', 'build-info.js')
fs.writeFileSync(out, content)
console.log(`build-info: version=${version}, commitId=${commitId}`)
