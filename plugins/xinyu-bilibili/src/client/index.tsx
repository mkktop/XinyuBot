// 浏览器半边入口：在左侧边栏「全局面板」注册「新雨机器人」入口（order 5，
// 位于官方「自动化任务」上方）。注册模式与官方面板一致：
//   1) ctx.slots.inject("main", ...)            —— 面板内容组件（按 key 寻址）
//   2) ctx.slots.inject("sidebar.panellist", …) —— 左侧按钮（图标组件 + order）
// 面板通过 dsh 的 owner-only Connection Fetch 复用登录态（见 panel.tsx 的 api()）。

import { XinyuPanel } from './panel.js'

const PANEL_ID = 'dsh-xinyu-bilibili'

export const inject = ['slots']

export function apply(ctx: any) {
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, XinyuPanel))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    // 官方排位：插件 0、自动化任务 10、任务 20；取 5 恰好位于自动化任务上方
    order: 5,
    label: '新雨机器人',
  }, XinyuPanelIcon))
}

function XinyuPanelIcon(props: any) {
  const size = typeof props?.size === 'number' ? props.size : 18
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H12l-4.2 3.4a.5.5 0 0 1-.8-.4V17.5H4A1.5 1.5 0 0 1 2.5 16V7A1.5 1.5 0 0 1 4 5.5Z" />
      <path d="M12 14.2s-3.4-2.1-3.4-4.2c0-1.1.9-2 2-2 .7 0 1.2.3 1.4.9.2-.6.7-.9 1.4-.9 1.1 0 2 .9 2 2 0 2.1-3.4 4.2-3.4 4.2Z" fill="currentColor" stroke="none" />
      <line x1="7" y1="8.6" x2="7" y2="10.6" />
      <line x1="17" y1="8.6" x2="17" y2="10.6" />
    </svg>
  )
}
