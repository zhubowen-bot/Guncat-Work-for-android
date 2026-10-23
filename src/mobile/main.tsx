import './polyfills'
import React from 'react'
import ReactDOM from 'react-dom/client'
import '../renderer/src/styles.css'
import './mobile.css'
import 'katex/dist/katex.min.css'

const container = document.getElementById('root')

async function start(): Promise<void> {
  if (container === null) {
    throw new Error('找不到 #root 挂载点')
  }
  const { bootMobile } = await import('./boot')
  await bootMobile()

  const { default: App } = await import('../renderer/src/App')
  container.replaceChildren()
  ReactDOM.createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

start().catch((error: unknown) => {
  console.error('[guncat] 启动失败', error)
  if (container !== null) {
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
    container.innerHTML =
      '<div class="boot-error"><h1>启动失败</h1><pre></pre>' +
      '<p>请把这段信息反馈给开发者。数据保存在应用私有目录，重装不会清空。</p></div>'
    const pre = container.querySelector('pre')
    if (pre !== null) {
      pre.textContent = message
    }
  }
})
