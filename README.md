# Chrome 一键录屏扩展

这是一个原生 `Manifest V3` Chrome 扩展，支持：

- 点击扩展图标后，图标角标显示 `3 -> 2 -> 1` 倒计时
- 倒计时结束后开始录制当前标签页
- 鼠标移动轨迹可视化
- 鼠标点击涟漪可视化
- 再次点击扩展图标停止录制
- 录制完成后自动保存到本地 `Downloads/recordings/`

## 文件说明

- `manifest.json`: 扩展配置
- `service-worker.js`: 图标点击、倒计时、状态管理
- `offscreen.html` / `offscreen.js`: 负责媒体录制与下载保存
- `content.js`: 在页面中绘制鼠标轨迹与点击动画

## 使用方式

1. 打开 `chrome://extensions/`
2. 打开右上角“开发者模式”
3. 选择“加载已解压的扩展程序”
4. 选择当前目录 `/Users/adib/Desktop/practices/chrome-record-ext`
5. 打开任意普通网页
6. 点击扩展图标开始 3 秒倒计时
7. 录制过程中再次点击扩展图标，视频会自动保存到本地

## 限制

- 当前版本录制的是“当前标签页”，不是整个桌面
- `chrome://`、扩展页、新标签页等受限页面无法录制
- 输出格式为 `webm`
