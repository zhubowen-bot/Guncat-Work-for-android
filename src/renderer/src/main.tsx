import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import 'katex/dist/katex.min.css'
import { reportStage, describeError } from './bootReport'

// 只有鼠标/触控板才启用 :hover。手机 WebView 会把上一次点击的 :hover 状态粘住，
// 表现为「点一下按钮一直深色，点空白才恢复」；这里给 CSS 一个总开关。
if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
  document.documentElement.classList.add('hoverable')
}

// 启动诊断的第一层：脚本级异常。
// 模块顶层抛错、脚本被 CSP 拦掉、import 失败这类问题会先落到这里；
// 而它们在白屏上跟「React 挂载失败」长得一模一样，只有上报能区分。
window.addEventListener('error', (event) => {
  reportStage('error', `window.onerror: ${event.message} @ ${event.filename}:${event.lineno}`)
})
window.addEventListener('unhandledrejection', (event) => {
  reportStage('error', `unhandledrejection: ${describeError(event.reason)}`)
})

const container = document.getElementById('root')
if (container === null) {
  // 连挂载点都没有：这是最彻底的白屏，必须留下证据（而不是抛一句没人看见的异常）
  reportStage('error', '找不到 #root 挂载点')
  throw new Error('找不到 #root 挂载点')
}

// 清掉 index.html 里的加载占位（窗口是立刻显示的，占位会一直显示到 React 接管为止）。
// 注意这一步的代价：占位一清，React 若没渲染出来就是纯白 —— 所以下面两个回调必须在上报链路上。
container.replaceChildren()

/**
 * 直接拿浏览器打开 dev server 的地址（http://localhost:5173/）时会发生什么：
 *
 * 5173 是**渲染进程的开发服务器**，不是应用页面 —— 页面所有数据都来自 preload 暴露的
 * `window.guncat.*`（主进程的 IPC 桥），而 preload 只在 Electron 窗口里注入。
 * 在浏览器里 `window.guncat` 是 undefined，`store.init()` 一调用就抛 TypeError，
 * 界面永远停在启动态并甩一屏红色异常 —— 用户看到的就是「打不开 / 白屏」。
 *
 * 所以这里提前判定并给出**能照做的**提示，而不是把异常留给用户猜。
 */
if (typeof window.guncat === 'undefined') {
  reportStage('error', '缺少 preload 桥（window.guncat）：当前不是 Electron 窗口')
  container.append(
    Object.assign(document.createElement('div'), {
      className: 'bridge-missing',
      innerHTML:
        '<h1>这个地址不是应用页面</h1>' +
        '<p>你打开的是渲染进程的开发服务器（Vite，默认 5173）。应用页面只能在 <b>Electron 窗口</b>里运行 —— ' +
        '它的数据全部来自 preload 注入的 <code>window.guncat</code>（主进程 IPC 桥），浏览器里没有这座桥。</p>' +
        '<p>正确做法：在项目根目录执行 <code>npm run dev</code>，等终端出现 <code>start electron app...</code>，' +
        '<b>Electron 窗口就是应用本体</b>，不需要手动打开任何网址。</p>' +
        '<p>如果 Electron 窗口没有出现或一片白：把 <code>start electron app...</code> 之后的终端输出发出来 —— ' +
        '主进程的报错会打在那里。</p>'
    })
  )
} else {
  ReactDOM.createRoot(container, {
    /**
     * React 19 的根级错误回调。
     * 没有它，渲染期抛出的异常只会走浏览器 console，而用户的启动日志里一条都不会有 ——
     * 这正是这次排查中最要命的缺口：日志显示「加载完成」，窗口一片白，却没有任何错误。
     */
    onUncaughtError: (error) => {
      reportStage('error', describeError(error))
    }
  }).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}
