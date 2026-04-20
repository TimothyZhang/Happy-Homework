'use strict'

/**
 * homeworkOCR 云函数骨架
 *
 * 当前版本先返回结构化 mock 数据，方便小程序端对接真实调用流程。
 * 下一步可在这里替换成真实 OCR 服务：
 * 1. 接收图片 fileID 或临时 URL
 * 2. 调用 OCR API 获取整页文本
 * 3. 运行 parseHomeworkRegister(rawText)
 * 4. 返回 drafts 给小程序端确认导入
 */

exports.main = async (event) => {
  const rawText = `语文：抄写第3课生字两遍\n数学：练习册第12页第1-5题\n英语：背诵单词1-20\n带彩纸一张，周三手工课用`

  return {
    ok: true,
    source: 'mock-cloud-function',
    imageFileID: event.imageFileID || '',
    rawText,
    drafts: parseHomeworkRegister(rawText)
  }
}

function parseHomeworkRegister(rawText) {
  const lines = String(rawText || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)

  return lines.map((line, index) => {
    const subjectMatch = line.match(/^(语文|数学|英语|科学|道法|美术|音乐|体育|劳动)[：: ]?/)
    const subject = subjectMatch ? subjectMatch[1] : ''
    const content = subjectMatch ? line.replace(subjectMatch[0], '').trim() : line

    return {
      id: `draft-${Date.now()}-${index}`,
      subject,
      content,
      rawText: line,
      confidence: subject ? '高' : '低',
      needsConfirm: !subject
    }
  })
}

module.exports = {
  parseHomeworkRegister
}
