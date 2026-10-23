// 构建期注入的全局常量。
// 桌面构建不定义它们，运行时走到 typeof 的默认分支。
declare const __GUNCAT_RESOURCE_BASE__: string
declare const __APP_VERSION__: string
