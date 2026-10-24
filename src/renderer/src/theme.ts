// 系统深浅色跟随。
//
// 为什么不能只靠 CSS 的 prefers-color-scheme：
// Android WebView 在部分系统版本/机型上不会把系统深色透传给这个媒体查询
// （Activity 的 uiMode 已经是 NIGHT_YES，页面里仍然 matches=false）。结果是
// 系统开了深色、应用还是白底。这里以**原生 uiMode** 为准，把它翻译成
// `html[data-theme="dark"]`，CSS 两条入口都认；桌面端没有原生桥，退回媒体查询。
//
// 不提供手动开关：应用只跟随系统。

interface NativeThemeBridge {
  isNightMode?: () => boolean
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

function nativeDark(): boolean | null {
  if (typeof window === 'undefined') {
    return null
  }
  const bridge = (window as unknown as { GuncatAndroid?: NativeThemeBridge }).GuncatAndroid
  if (bridge === undefined || typeof bridge.isNightMode !== 'function') {
    return null
  }
  try {
    return bridge.isNightMode() === true
  } catch {
    return null
  }
}

function mediaDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(DARK_QUERY).matches
  )
}

/** 当前是否深色：显式属性优先（原生桥写过），否则看系统媒体查询 */
export function isDarkTheme(): boolean {
  if (typeof document !== 'undefined') {
    const value = document.documentElement.dataset.theme
    if (value === 'dark') {
      return true
    }
    if (value === 'light') {
      return false
    }
  }
  const native = nativeDark()
  return native === null ? mediaDark() : native
}

function applyTheme(dark: boolean): void {
  if (typeof document === 'undefined') {
    return
  }
  const root = document.documentElement
  root.dataset.theme = dark ? 'dark' : 'light'
  root.style.colorScheme = dark ? 'dark' : 'light'
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta !== null) {
    meta.setAttribute('content', dark ? '#18181a' : '#f6f6f7')
  }
}

/**
 * 安装系统主题跟随。启动时调用一次；之后原生 `onConfigurationChanged`
 * 会通过 window.__guncatThemeChanged 推进来，桌面端则监听媒体查询变化。
 */
export function installSystemTheme(): void {
  if (typeof window === 'undefined') {
    return
  }
  applyTheme(isDarkTheme())

  if (typeof window.matchMedia === 'function') {
    const query = window.matchMedia(DARK_QUERY)
    const onChange = (): void => {
      // 有原生桥时以原生为准，避免媒体查询的旧值把正确的深色覆盖掉
      if (nativeDark() === null) {
        applyTheme(query.matches)
      }
    }
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange)
    } else if (typeof query.addListener === 'function') {
      query.addListener(onChange)
    }
  }

  // Android 原生侧在 uiMode 变化时调用（Activity 声明了 configChanges=uiMode，
  // 不会重建页面，只能靠这个回调把新值送进来）。
  ;(window as unknown as { __guncatThemeChanged?: (dark: boolean) => void }).__guncatThemeChanged = (
    dark: boolean
  ): void => {
    applyTheme(dark === true)
  }
}
