// 读 asar 头，导出里面的 package.json —— 用来看一个「能正常启动的 Electron 应用」
// 到底用的是什么模块格式，作为我们的对照。
import fs from 'node:fs'

const asar = process.argv[2]
const fd = fs.openSync(asar, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(12)
const header = Buffer.alloc(headerSize)
fs.readSync(fd, header, 0, headerSize, 16)
const json = JSON.parse(header.toString('utf8').replace(/\0+$/, ''))

function readFile(entry) {
  const buf = Buffer.alloc(entry.size)
  fs.readSync(fd, buf, 0, entry.size, 16 + headerSize + Number(entry.offset))
  return buf.toString('utf8')
}

console.log('asar 顶层条目:', Object.keys(json.files).slice(0, 20).join(', '))
const pkg = json.files['package.json']
if (pkg !== undefined) {
  console.log('\n--- package.json ---')
  console.log(readFile(pkg).slice(0, 800))
}
fs.closeSync(fd)
