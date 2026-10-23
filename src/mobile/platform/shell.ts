// Android 端的「内置 Shell」：没有 /bin/sh、没有 Python/Node 可执行文件，
// 因此 run_command 不是被砍掉，而是换成一套在 JS 里实现、**只作用于应用沙箱工作区**的
// POSIX 子集。支持管道、&&/||/;、重定向，以及 ls/cat/grep/find/sed 等文件操作命令。
//
// 边界必须诚实：git / python / npm / curl 这类需要真实可执行文件的命令会明确返回
// 「Android 版内置 Shell 不支持」，而不是假装成功。
import fs from 'node:fs'
import path from 'node:path'

export interface ShellRunResult {
  stdout: string
  stderr: string
  code: number
}

const UNSUPPORTED_EXECUTABLES: Record<string, string> = {
  python: 'Python 解释器',
  python3: 'Python 解释器',
  node: 'Node.js 解释器',
  npm: 'npm',
  npx: 'npx',
  pnpm: 'pnpm',
  yarn: 'yarn',
  pip: 'pip',
  pip3: 'pip3',
  git: 'git',
  curl: 'curl',
  wget: 'wget',
  ffmpeg: 'ffmpeg',
  convert: 'ImageMagick',
  magick: 'ImageMagick',
  libreoffice: 'LibreOffice',
  soffice: 'LibreOffice',
  pdflatex: 'LaTeX',
  xelatex: 'LaTeX',
  pandoc: 'pandoc',
  java: 'Java',
  gcc: 'GCC',
  make: 'make',
  docker: 'Docker',
  ssh: 'ssh',
  scp: 'scp',
  rsync: 'rsync'
}

interface Token {
  kind: 'word' | 'op'
  value: string
}

const OPERATORS = ['2>&1', '>>', '&&', '||', '2>', '|', ';', '>', '<']

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let current = ''
  let quote: '"' | "'" | '' = ''
  let i = 0

  const flush = (): void => {
    if (current !== '') {
      tokens.push({ kind: 'word', value: current })
      current = ''
    }
  }

  while (i < input.length) {
    const ch = input[i]
    if (quote !== '') {
      if (ch === quote) {
        quote = ''
        i++
        continue
      }
      if (ch === '\\' && quote === '"' && i + 1 < input.length) {
        current += input[i + 1]
        i += 2
        continue
      }
      current += ch
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      i++
      continue
    }
    if (ch === '\\' && i + 1 < input.length) {
      current += input[i + 1]
      i += 2
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      flush()
      i++
      continue
    }
    const matched = OPERATORS.find((op) => input.startsWith(op, i))
    if (matched !== undefined) {
      flush()
      tokens.push({ kind: 'op', value: matched })
      i += matched.length
      continue
    }
    current += ch
    i++
  }
  flush()
  return tokens
}

function expand(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a, b) => {
    const key = (a ?? b) as string
    return env[key] ?? ''
  })
}

function resolvePath(cwd: string, raw: string): string {
  const value = raw.startsWith('~') ? raw.replace(/^~/, '/guncat/data') : raw
  if (value.startsWith('/')) {
    return path.posix.normalize(value)
  }
  return path.posix.normalize(path.posix.join(cwd, value))
}

function outputOf(text: string): string {
  return text
}

class ShellState {
  cwd: string
  env: Record<string, string>
  stdout: string = ''
  stderr: string = ''

  constructor(cwd: string, env: Record<string, string>) {
    this.cwd = cwd
    this.env = { ...env, PWD: cwd }
  }

  write(text: string): void {
    this.stdout += text
  }

  warn(text: string): void {
    this.stderr += text
  }

  resolve(raw: string): string {
    const full = resolvePath(this.cwd, raw)
    // 与桌面版的工作区边界一致：内置 Shell 只能碰应用数据目录（memfs 内的 /guncat），
    // 越界不是「读不到」而是明确拒绝。
    if (full !== '/guncat' && !full.startsWith('/guncat/')) {
      throw new Error(`路径越界：Android 版内置 Shell 只能访问应用沙箱（${raw}）`)
    }
    return full
  }

  fail(code: number, message: string): number {
    this.stderr += message.endsWith('\n') ? message : message + '\n'
    return code
  }
}

function formatMode(stat: fs.Stats): string {
  const type = stat.isDirectory() ? 'd' : '-'
  const bits = ['r', 'w', 'x', 'r', 'w', 'x', 'r', 'w', 'x'].map((c, index) =>
    (stat.mode >> (8 - index)) & 1 ? c : '-'
  )
  return type + bits.join('')
}

function listLong(state: ShellState, full: string, name: string): string {
  try {
    const stat = fs.statSync(full)
    const size = String(stat.size).padStart(8)
    const date = new Date(stat.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')
    return `${formatMode(stat)} ${size} ${date} ${name}\n`
  } catch {
    return ''
  }
}

function readInputs(state: ShellState, args: string[], stdin: string): { text: string; code: number } {
  if (args.length === 0) {
    return { text: stdin, code: 0 }
  }
  let text = ''
  let code = 0
  for (const arg of args) {
    if (arg === '-') {
      text += stdin
      continue
    }
    const full = state.resolve(arg)
    try {
      if (fs.statSync(full).isDirectory()) {
        code = state.fail(1, `cat: ${arg}: 是一个目录`)
        continue
      }
      text += fs.readFileSync(full, 'utf8')
    } catch {
      code = state.fail(1, `cat: ${arg}: 找不到文件`)
    }
  }
  return { text, code }
}

function cmdLs(state: ShellState, args: string[]): number {
  let long = false
  let all = false
  const targets: string[] = []
  for (const arg of args) {
    if (arg === '-l' || arg === '-la' || arg === '-al') {
      long = true
      all = true
    } else if (arg === '-a') {
      all = true
    } else if (arg === '-h') {
      // 大小已经是人类可读的十进制字节
    } else if (arg.startsWith('-')) {
      // 忽略未知短选项
    } else {
      targets.push(arg)
    }
  }
  const list = targets.length === 0 ? ['.'] : targets
  let code = 0
  for (const target of list) {
    const full = state.resolve(target)
    let names: string[]
    try {
      const stat = fs.statSync(full)
      if (!stat.isDirectory()) {
        state.write(long ? listLong(state, full, path.posix.basename(full)) : path.posix.basename(full) + '\n')
        continue
      }
      names = fs.readdirSync(full)
    } catch {
      code = state.fail(1, `ls: ${target}: 找不到目录`)
      continue
    }
    names.sort()
    if (all) {
      names = ['.', '..', ...names]
    }
    if (list.length > 1) {
      state.write(`${target}:\n`)
    }
    for (const name of names) {
      const child = full.endsWith('/') ? full + name : full + '/' + name
      state.write(long ? listLong(state, child, name) : name + '\n')
    }
  }
  return code
}

function cmdCat(state: ShellState, args: string[], stdin: string): number {
  const result = readInputs(state, args.filter((a) => !a.startsWith('-')), stdin)
  state.write(result.text)
  return result.code
}

function cmdHeadTail(state: ShellState, args: string[], stdin: string, tail: boolean): number {
  let count = 10
  const files: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n' && i + 1 < args.length) {
      count = Number(args[++i]) || 10
    } else if (/^-\d+$/.test(args[i])) {
      count = Number(args[i].slice(1))
    } else if (!args[i].startsWith('-')) {
      files.push(args[i])
    }
  }
  const result = readInputs(state, files, stdin)
  const lines = result.text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  const selected = tail ? lines.slice(-count) : lines.slice(0, count)
  state.write(selected.join('\n') + (selected.length > 0 ? '\n' : ''))
  return result.code
}

function cmdWc(state: ShellState, args: string[], stdin: string): number {
  const flags = new Set(args.filter((arg) => arg.startsWith('-')).flatMap((arg) => arg.slice(1).split('')))
  const files = args.filter((a) => !a.startsWith('-'))
  const result = readInputs(state, files, stdin)
  const text = result.text
  const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length
  const chars = text.length
  const numbers: number[] = []
  if (flags.size === 0 || flags.has('l')) {
    numbers.push(lines)
  }
  if (flags.size === 0 || flags.has('w')) {
    numbers.push(words)
  }
  if (flags.size === 0 || flags.has('c')) {
    numbers.push(chars)
  }
  const target = files.length === 1 ? ' ' + files[0] : ''
  state.write(`${numbers.join(' ')}${target}\n`)
  return result.code
}

function cmdGrep(state: ShellState, args: string[], stdin: string): number {
  let insensitive = false
  let lineNumber = false
  let recursive = false
  let filesOnly = false
  const rest: string[] = []
  for (const arg of args) {
    if (arg === '-i') {
      insensitive = true
    } else if (arg === '-n') {
      lineNumber = true
    } else if (arg === '-r' || arg === '-R') {
      recursive = true
    } else if (arg === '-l') {
      filesOnly = true
    } else if (!arg.startsWith('-')) {
      rest.push(arg)
    }
  }
  if (rest.length === 0) {
    return state.fail(2, 'grep: 缺少匹配模式')
  }
  const pattern = rest[0]
  const targets = rest.slice(1)
  let regex: RegExp
  try {
    regex = new RegExp(pattern, insensitive ? 'i' : '')
  } catch (e) {
    return state.fail(2, `grep: 无效的正则表达式: ${(e as Error).message}`)
  }

  const scan = (full: string, label: string, showLabel: boolean): boolean => {
    let text = ''
    try {
      text = fs.readFileSync(full, 'utf8')
    } catch {
      return false
    }
    let matched = false
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!regex.test(lines[i])) {
        continue
      }
      matched = true
      if (!filesOnly) {
        const prefix = showLabel ? `${label}:` : ''
        state.write(`${prefix}${lineNumber ? `${i + 1}:` : ''}${lines[i]}\n`)
      }
    }
    if (filesOnly && matched) {
      state.write(label + '\n')
    }
    return matched
  }

  const visit = (full: string, label: string): boolean => {
    try {
      const stat = fs.statSync(full)
      if (stat.isDirectory()) {
        if (!recursive) {
          state.fail(2, `grep: ${label}: 是一个目录（加 -r 递归）`)
          return false
        }
        let matched = false
        for (const name of fs.readdirSync(full)) {
          matched = visit(path.posix.join(full, name), path.posix.join(label, name)) || matched
        }
        return matched
      }
      return scan(full, label, targets.length + (recursive ? 1 : 0) > 1)
    } catch {
      state.fail(2, `grep: ${label}: 找不到文件`)
      return false
    }
  }

  if (targets.length === 0) {
    const lines = stdin.split('\n')
    let matched = false
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matched = true
        state.write(`${lineNumber ? `${i + 1}:` : ''}${lines[i]}\n`)
      }
    }
    return matched ? 0 : 1
  }

  let any = false
  for (const target of targets) {
    any = visit(state.resolve(target), target) || any
  }
  return any ? 0 : 1
}

function cmdFind(state: ShellState, args: string[]): number {
  let root = '.'
  let namePattern = ''
  let type = ''
  let maxDepth = Infinity
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-name' && i + 1 < args.length) {
      namePattern = args[++i].replace(/^\*|\*$/g, '')
    } else if (args[i] === '-type' && i + 1 < args.length) {
      type = args[++i]
    } else if (args[i] === '-maxdepth' && i + 1 < args.length) {
      maxDepth = Number(args[++i])
    } else if (!args[i].startsWith('-')) {
      root = args[i]
    }
  }
  const base = state.resolve(root)
  let code = 0
  const walk = (full: string, depth: number, label: string): void => {
    if (depth > maxDepth) {
      return
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(full)
    } catch {
      code = state.fail(1, `find: ${label}: 找不到路径`)
      return
    }
    const matched =
      (namePattern === '' || label.includes(namePattern)) &&
      (type === '' || (type === 'd' ? stat.isDirectory() : type === 'f' ? stat.isFile() : true))
    if (matched) {
      state.write(label + '\n')
    }
    if (stat.isDirectory()) {
      let names: string[] = []
      try {
        names = fs.readdirSync(full)
      } catch {
        return
      }
      for (const name of names) {
        walk(path.posix.join(full, name), depth + 1, path.posix.join(label, name))
      }
    }
  }
  walk(base, 0, root)
  return code
}

function cmdMkdir(state: ShellState, args: string[]): number {
  const paths = args.filter((a) => !a.startsWith('-'))
  let code = 0
  for (const target of paths) {
    try {
      fs.mkdirSync(state.resolve(target), { recursive: true })
    } catch (e) {
      code = state.fail(1, `mkdir: ${target}: ${(e as Error).message}`)
    }
  }
  return code
}

function cmdRm(state: ShellState, args: string[]): number {
  let recursive = false
  const paths: string[] = []
  for (const arg of args) {
    if (arg === '-r' || arg === '-rf' || arg === '-fr' || arg === '-R') {
      recursive = true
    } else if (arg === '-f') {
      // 强制
    } else if (!arg.startsWith('-')) {
      paths.push(arg)
    }
  }
  let code = 0
  for (const target of paths) {
    const full = state.resolve(target)
    try {
      const stat = fs.statSync(full)
      if (stat.isDirectory() && !recursive) {
        code = state.fail(1, `rm: ${target}: 是一个目录（加 -r）`)
        continue
      }
      fs.rmSync(full, { recursive, force: true })
    } catch {
      code = state.fail(1, `rm: ${target}: 找不到文件`)
    }
  }
  return code
}

function cmdCpMv(state: ShellState, args: string[], move: boolean): number {
  const recursive = args.includes('-r') || args.includes('-R') || args.includes('-rf')
  const paths = args.filter((a) => !a.startsWith('-'))
  if (paths.length < 2) {
    return state.fail(1, `${move ? 'mv' : 'cp'}: 需要源与目标`)
  }
  const dest = state.resolve(paths[paths.length - 1])
  const sources = paths.slice(0, -1)
  let code = 0
  for (const source of sources) {
    const src = state.resolve(source)
    try {
      const stat = fs.statSync(src)
      let target = dest
      if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) {
        target = path.posix.join(dest, path.posix.basename(src))
      }
      if (stat.isDirectory()) {
        if (!recursive) {
          code = state.fail(1, `${move ? 'mv' : 'cp'}: ${source}: 是目录（加 -r）`)
          continue
        }
        fs.cpSync(src, target, { recursive: true })
        if (move) {
          fs.rmSync(src, { recursive: true, force: true })
        }
      } else {
        fs.copyFileSync(src, target)
        if (move) {
          fs.rmSync(src, { force: true })
        }
      }
    } catch (e) {
      code = state.fail(1, `${move ? 'mv' : 'cp'}: ${source}: ${(e as Error).message}`)
    }
  }
  return code
}

function cmdTouch(state: ShellState, args: string[]): number {
  const now = new Date()
  for (const target of args.filter((a) => !a.startsWith('-'))) {
    const full = state.resolve(target)
    try {
      if (fs.existsSync(full)) {
        fs.utimesSync(full, now, now)
      } else {
        fs.writeFileSync(full, '')
      }
    } catch (e) {
      return state.fail(1, `touch: ${target}: ${(e as Error).message}`)
    }
  }
  return 0
}

function cmdStat(state: ShellState, args: string[]): number {
  const target = args.find((a) => !a.startsWith('-'))
  if (target === undefined) {
    return state.fail(1, 'stat: 缺少文件')
  }
  try {
    const full = state.resolve(target)
    const stat = fs.statSync(full)
    state.write(
      `  File: ${target}\n  Size: ${stat.size}\t${stat.isDirectory() ? 'directory' : 'regular file'}\n` +
        `Modify: ${new Date(stat.mtimeMs).toISOString()}\n  Mode: ${formatMode(stat)}\n`
    )
    return 0
  } catch {
    return state.fail(1, `stat: ${target}: 找不到文件`)
  }
}

function cmdSort(state: ShellState, args: string[], stdin: string): number {
  const numeric = args.includes('-n')
  const reverse = args.includes('-r')
  const lines = stdin.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  lines.sort((a, b) => (numeric ? Number(a) - Number(b) : a.localeCompare(b)))
  if (reverse) {
    lines.reverse()
  }
  state.write(lines.join('\n') + (lines.length > 0 ? '\n' : ''))
  return 0
}

function cmdUniq(state: ShellState, _args: string[], stdin: string): number {
  const lines = stdin.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  let previous: string | null = null
  for (const line of lines) {
    if (line !== previous) {
      state.write(line + '\n')
    }
    previous = line
  }
  return 0
}

function cmdCut(state: ShellState, args: string[], stdin: string): number {
  let delimiter = '\t'
  let fields = '1'
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-d' && i + 1 < args.length) {
      delimiter = args[++i]
    } else if (args[i] === '-f' && i + 1 < args.length) {
      fields = args[++i]
    }
  }
  const indexes = fields.split(',').map((n) => Math.max(1, Number(n)) - 1)
  const lines = stdin.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  for (const line of lines) {
    const cells = line.split(delimiter)
    state.write(indexes.map((i) => cells[i] ?? '').join(delimiter) + '\n')
  }
  return 0
}

function cmdTr(state: ShellState, args: string[], stdin: string): number {
  if (args.length >= 2) {
    const [from, to] = args
    let out = ''
    for (const ch of stdin) {
      const index = from.indexOf(ch)
      out += index >= 0 ? to[index] ?? to[to.length - 1] ?? '' : ch
    }
    state.write(out)
    return 0
  }
  state.write(stdin)
  return 0
}

function cmdBase64(state: ShellState, args: string[], stdin: string): number {
  if (args.includes('-d') || args.includes('--decode')) {
    try {
      const binary = atob(stdin.replace(/\s+/g, ''))
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
      }
      state.write(new TextDecoder().decode(bytes))
      return 0
    } catch (e) {
      return state.fail(1, `base64: 解码失败: ${(e as Error).message}`)
    }
  }
  const bytes = new TextEncoder().encode(stdin)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  state.write(btoa(binary) + '\n')
  return 0
}

function cmdSed(state: ShellState, args: string[], stdin: string): number {
  const scripts = args.filter((a) => !a.startsWith('-'))
  if (scripts.length === 0) {
    state.write(stdin)
    return 0
  }
  const match = /^s(.)(.*?)\1(.*?)\1([gi]*)$/.exec(scripts[0])
  if (match === null) {
    return state.fail(1, 'sed: 只支持 s/匹配/替换/[gi] 形式')
  }
  let regex: RegExp
  try {
    regex = new RegExp(match[2], match[4].includes('g') ? 'g' : '')
  } catch (e) {
    return state.fail(1, `sed: 无效表达式: ${(e as Error).message}`)
  }
  const lines = stdin.split('\n')
  state.write(lines.map((line) => line.replace(regex, match[3])).join('\n'))
  return 0
}

function cmdTest(state: ShellState, args: string[]): number {
  const op = args[0]
  const target = args[1]
  if (target === undefined) {
    return 1
  }
  const full = state.resolve(target)
  let ok = false
  switch (op) {
    case '-e':
      ok = fs.existsSync(full)
      break
    case '-d':
      ok = fs.existsSync(full) && fs.statSync(full).isDirectory()
      break
    case '-f':
      ok = fs.existsSync(full) && fs.statSync(full).isFile()
      break
    case '-s':
      ok = fs.existsSync(full) && fs.statSync(full).size > 0
      break
    default:
      ok = op !== '' && target === '='
  }
  return ok ? 0 : 1
}

function runCommand(
  state: ShellState,
  name: string,
  args: string[],
  stdin: string
): number {
  switch (name) {
    case 'pwd':
      state.write(state.cwd + '\n')
      return 0
    case 'cd': {
      const target = state.resolve(args[0] ?? '/guncat/data')
      try {
        if (!fs.statSync(target).isDirectory()) {
          return state.fail(1, `cd: ${args[0] ?? ''}: 不是目录`)
        }
      } catch {
        return state.fail(1, `cd: ${args[0] ?? ''}: 找不到目录`)
      }
      state.cwd = target
      state.env.PWD = target
      return 0
    }
    case 'ls':
      return cmdLs(state, args)
    case 'cat':
      return cmdCat(state, args, stdin)
    case 'head':
      return cmdHeadTail(state, args, stdin, false)
    case 'tail':
      return cmdHeadTail(state, args, stdin, true)
    case 'wc':
      return cmdWc(state, args, stdin)
    case 'grep':
    case 'egrep':
      return cmdGrep(state, args, stdin)
    case 'find':
      return cmdFind(state, args)
    case 'mkdir':
      return cmdMkdir(state, args)
    case 'rm':
      return cmdRm(state, args)
    case 'cp':
      return cmdCpMv(state, args, false)
    case 'mv':
      return cmdCpMv(state, args, true)
    case 'touch':
      return cmdTouch(state, args)
    case 'stat':
      return cmdStat(state, args)
    case 'sort':
      return cmdSort(state, args, stdin)
    case 'uniq':
      return cmdUniq(state, args, stdin)
    case 'cut':
      return cmdCut(state, args, stdin)
    case 'tr':
      return cmdTr(state, args, stdin)
    case 'base64':
      return cmdBase64(state, args, stdin)
    case 'sed':
      return cmdSed(state, args, stdin)
    case 'echo': {
      const noNewline = args[0] === '-n'
      const body = (noNewline ? args.slice(1) : args).join(' ')
      state.write(body + (noNewline ? '' : '\n'))
      return 0
    }
    case 'printf': {
      if (args.length === 0) {
        return 0
      }
      let format = args[0]
      const values = args.slice(1)
      let index = 0
      format = format.replace(/%[sd]/g, () => values[index++] ?? '')
      state.write(format)
      return 0
    }
    case 'true':
      return 0
    case 'false':
      return 1
    case 'test':
    case '[':
      return cmdTest(state, args.filter((a) => a !== ']'))
    case 'date':
      state.write(new Date().toISOString() + '\n')
      return 0
    case 'uname':
      state.write('Android WebView\n')
      return 0
    case 'whoami':
      state.write('guncat\n')
      return 0
    case 'env':
      for (const key of Object.keys(state.env).sort()) {
        state.write(`${key}=${state.env[key]}\n`)
      }
      return 0
    case 'which': {
      const target = args[0] ?? ''
      if (['ls', 'cat', 'grep', 'find', 'sed', 'echo', 'pwd', 'cd'].includes(target)) {
        state.write(`builtin:${target}\n`)
        return 0
      }
      return state.fail(1, `which: 没有 ${target}`)
    }
    case 'sleep': {
      // 同步等待会占用主线程：上限 5 秒，避免模型写 sleep 3600 把界面卡死
      const seconds = Math.min(5, Math.max(0, Number(args[0] ?? '0')))
      const ms = seconds * 1000
      if (ms > 0) {
        const end = Date.now() + ms
        while (Date.now() < end) {
          // 同步等待
        }
      }
      return 0
    }
    case 'clear':
      return 0
    case 'exit':
      return Number(args[0] ?? '0') || 0
    default:
      if (UNSUPPORTED_EXECUTABLES[name] !== undefined) {
        return state.fail(
          127,
          `Android 版内置 Shell 不支持 ${UNSUPPORTED_EXECUTABLES[name]}（${name}）。` +
            '\n可用的是文件操作类命令：ls/cat/head/tail/wc/grep/find/sed/mkdir/rm/cp/mv/touch/stat/sort/uniq/cut/tr/base64。'
        )
      }
      return state.fail(127, `Android 版内置 Shell: 找不到命令 ${name}`)
  }
}

interface Segment {
  words: string[]
  stdinFile: string | null
  stdoutFile: string | null
  append: boolean
  stderrFile: string | null
}

function parseSegment(tokens: Token[]): Segment {
  const segment: Segment = {
    words: [],
    stdinFile: null,
    stdoutFile: null,
    append: false,
    stderrFile: null
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.kind === 'word') {
      segment.words.push(token.value)
      continue
    }
    const next = tokens[i + 1]
    if (next === undefined || next.kind !== 'word') {
      continue
    }
    i++
    if (token.value === '<') {
      segment.stdinFile = next.value
    } else if (token.value === '>' || token.value === '>>') {
      segment.stdoutFile = next.value
      segment.append = token.value === '>>'
    } else if (token.value === '2>') {
      segment.stderrFile = next.value
    }
    // 2>&1 直接当作合并输出（本实现本来就合并）
  }
  return segment
}

function executePipeline(state: ShellState, tokens: Token[]): number {
  const groups: Token[][] = [[]]
  for (const token of tokens) {
    if (token.kind === 'op' && token.value === '|') {
      groups.push([])
    } else {
      groups[groups.length - 1].push(token)
    }
  }
  let stdin = ''
  let code = 0
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]
    const segment = parseSegment(group)
    const words = segment.words.map((word) => expand(word, state.env))
    if (words.length === 0) {
      continue
    }
    if (segment.stdinFile !== null) {
      try {
        stdin = fs.readFileSync(state.resolve(segment.stdinFile), 'utf8')
      } catch {
        code = state.fail(1, `重定向: 找不到 ${segment.stdinFile}`)
        stdin = ''
      }
    }
    const before = state.stdout.length
    const beforeErr = state.stderr.length
    const name = words[0]
    try {
      code = runCommand(state, name, words.slice(1), stdin)
    } catch (e) {
      code = state.fail(1, (e as Error).message)
    }
    const chunk = state.stdout.slice(before)

    // 管道：中间级只把本段输出交给下一段，不留在最终 stdout 里
    if (index < groups.length - 1) {
      state.stdout = state.stdout.slice(0, before)
    }

    if (segment.stdoutFile !== null) {
      state.stdout = state.stdout.slice(0, before)
      try {
        fs.writeFileSync(state.resolve(segment.stdoutFile), chunk, {
          encoding: 'utf8',
          flag: segment.append ? 'a' : 'w'
        })
      } catch (e) {
        state.stderr += `重定向失败: ${(e as Error).message}\n`
        code = 1
      }
    }
    if (segment.stderrFile !== null) {
      const errChunk = state.stderr.slice(beforeErr)
      state.stderr = state.stderr.slice(0, beforeErr)
      try {
        fs.writeFileSync(state.resolve(segment.stderrFile), errChunk, { encoding: 'utf8' })
      } catch {
        // 忽略
      }
    }
    stdin = chunk
  }
  return code
}

/**
 * 执行一条 shell 命令（支持 `;` `&&` `||` 与管道）。
 * 与真实 shell 的差异：没有通配符展开、没有作业控制、没有交互式 TTY。
 */
export function runShell(command: string, cwd: string, env: Record<string, string> = {}): ShellRunResult {
  const tokens = tokenize(command)
  const state = new ShellState(cwd, env)
  const chunks: Token[][] = [[]]
  for (const token of tokens) {
    if (token.kind === 'op' && (token.value === ';' || token.value === '&&' || token.value === '||')) {
      chunks.push([{ kind: 'op', value: token.value }])
      chunks.push([])
    } else {
      chunks[chunks.length - 1].push(token)
    }
  }

  let code = 0
  let operator = ''
  for (const chunk of chunks) {
    if (chunk.length === 0) {
      continue
    }
    const first = chunk[0]
    if (first.kind === 'op' && (first.value === '&&' || first.value === '||' || first.value === ';')) {
      operator = first.value
      continue
    }
    if (operator === '&&' && code !== 0) {
      operator = ''
      continue
    }
    if (operator === '||' && code === 0) {
      operator = ''
      continue
    }
    code = executePipeline(state, chunk)
    operator = ''
  }

  return { stdout: state.stdout, stderr: state.stderr, code }
}

export { outputOf }
