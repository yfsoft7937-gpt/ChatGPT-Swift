# ChatGPT Swift v0.4.1

This build upgrades the v0.3 line with **automatic near-viewport restore** and a more performance-focused update path for long ChatGPT sessions.

## New in v0.4.1
- Auto-restores virtualized messages when they approach the viewport
- Uses separate restore and virtualize thresholds to avoid placeholder flicker
- Batches auto-restores across animation frames to reduce scroll jank
- Reuses placeholders instead of recreating them repeatedly
- Processes heavy code blocks incrementally instead of rescanning all `pre` tags on every update
- Uses `ResizeObserver` to keep placeholder heights more accurate as live content changes
- Adds a lighter route-change detector and tighter mutation filtering
- Unifies defaults across content script, popup, options, and service worker

## Recommended defaults
- Min messages before virtualizing: 12
- Overscan: 3
- Keep newest live: 4
- Pause after typing: 800ms
- Auto restore above viewport: 320px
- Auto restore below viewport: 760px
- Virtualize above viewport: 1400px
- Virtualize below viewport: 1800px
- Auto restores per frame: 2

## Behavior summary
- Nearby messages stay live or auto-restore before you reach them
- Mid-distance messages are left alone to avoid unnecessary DOM churn
- Far-away history becomes placeholders to keep the live DOM small
- Safe mode keeps all messages in the DOM and applies browser-side containment instead of placeholder replacement

## Install
1. Open `chrome://extensions` or `edge://extensions`
2. Enable Developer mode
3. Click **Load unpacked**
4. Choose this folder
5. Reload ChatGPT


## v0.4.1

- Fixed auto restore by observing virtualized placeholders with IntersectionObserver so they restore when they approach the viewport.
- Kept restore batching and hysteresis so nearby history becomes visible automatically without causing heavy scroll jank.

---

# ChatGPT Swift v0.4.1 中文说明

这个版本在 v0.3 系列基础上，加入了**靠近视口自动恢复消息**的能力，并针对超长 ChatGPT 会话做了更偏性能优化的更新路径。

## v0.4.1 新增内容
- 当被虚拟化的消息接近视口时，会自动恢复为真实内容
- 将“恢复阈值”和“虚拟化阈值”分开，减少占位块闪烁
- 自动恢复按动画帧分批执行，降低滚动卡顿
- 复用已有占位符，而不是反复重新创建
- 对大型代码块做增量处理，而不是每次更新都重新扫描所有 `pre`
- 使用 `ResizeObserver` 更准确地同步真实消息变化后的占位高度
- 使用更轻量的路由变化检测与更严格的 DOM 变更过滤
- 统一 content script、popup、options 和 service worker 中的默认配置

## 推荐默认参数
- 开始虚拟化的最小消息数：12
- Overscan：3
- 始终保留最新消息数：4
- 输入后暂停虚拟化时间：800ms
- 视口上方自动恢复距离：320px
- 视口下方自动恢复距离：760px
- 视口上方虚拟化阈值：1400px
- 视口下方虚拟化阈值：1800px
- 每帧自动恢复数量：2

## 行为说明
- 靠近当前视口的消息会保持真实渲染，或在滚动接近前自动恢复
- 中距离消息会暂时保持不动，避免不必要的 DOM 抖动
- 远离视口的历史消息会替换为占位块，以减少实时 DOM 体量
- 安全模式不会替换 DOM，而是保留所有消息节点，仅使用浏览器侧 containment 优化

## 安装方式
1. 打开 `chrome://extensions` 或 `edge://extensions`
2. 开启开发者模式
3. 点击 **Load unpacked**
4. 选择当前项目文件夹
5. 重新加载 ChatGPT 页面

## v0.4.1 版本说明

- 通过 `IntersectionObserver` 观察已虚拟化的占位块，修复了自动恢复逻辑，使其在接近视口时自动还原。
- 保留恢复批处理与迟滞策略，让附近历史消息自动变为可见时不至于引入明显滚动卡顿。
