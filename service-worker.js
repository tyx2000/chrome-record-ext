// 这个 service worker 是整个扩展的控制中枢，负责四类事情：
// 1. 响应用户对扩展图标的点击
// 2. 维护录制状态机，例如空闲、倒计时、录制中、停止中
// 3. 协调页面 content script 和 offscreen 录制文档之间的消息
// 4. 动态绘制扩展图标，让工具栏图标本身变成倒计时和录制提示

const RECORDING_STATE = {
  IDLE: "idle",
  COUNTDOWN: "countdown",
  STARTING: "starting",
  RECORDING: "recording",
  STOPPING: "stopping",
};

// 固定的 3 秒倒计时。
const COUNTDOWN_SECONDS = 3;

// 工具栏和扩展菜单里常见的图标尺寸，分别生成可以避免缩放模糊。
const ICON_SIZES = [16, 32];

// 圆形图标尽量铺满整个方形画布，这样视觉上就是“替换整个扩展图标”。
const ICON_CIRCLE_RADIUS = 0.47;

// 中间红点半径
const RECORDING_DOT_RADIUS = 0.25;

// 一次完整闪烁周期为 1.6 秒，所以每 800ms 切换一次显示 / 隐藏。
const RECORDING_BLINK_HALF_CYCLE_MS = 800;

// 两个取消录制入口分别对应两个右键菜单。
const ACTION_CANCEL_MENU_ID = "cancel-recording-action";
const PAGE_CANCEL_MENU_ID = "cancel-recording-page";
const WORKFLOW_STATE_STORAGE_KEY = "workflow-state-v1";
const PENDING_DOWNLOADS_STORAGE_KEY = "pending-downloads-v1";

// 这是整个录制流程的唯一状态源。
// 所有入口都依赖这份状态协同工作：
// - 点击扩展图标
// - 关闭标签页
// - 页面中按 Esc
// - 右键菜单取消
// - offscreen 录制完成或失败的回调
const state = {
  status: RECORDING_STATE.IDLE,
  tabId: null,
  countdownToken: 0,
  recordingBlinkIntervalId: null,
  recordingBlinkVisible: true,
};

// 下载任务提交给浏览器后，会脱离当前调用栈异步完成。
// 这里记录 downloadId 和录制会话的对应关系，目的是在真正下载完成或失败时，
// 再回到 offscreen 清理对应会话的 IndexedDB 分片和 object URL。
const pendingDownloads = new Map();

// MV3 下 offscreen 文档创建是异步的，这个变量用来防止并发重复创建。
let creatingOffscreenDocument = null;
let runtimeReadyPromise = null;
let runtimeReady = false;

// 扩展安装或在扩展页中重新加载时执行。
// 这里统一重建菜单、清空 badge，并恢复默认图标。
chrome.runtime.onInstalled.addListener(async () => {
  await ensureRuntimeReady();
});

// MV3 的 service worker 不是常驻的，浏览器重启后也要把菜单和图标恢复出来。
chrome.runtime.onStartup.addListener(async () => {
  await ensureRuntimeReady();
});

// 扩展图标右键菜单和页面右键菜单都走同一个取消逻辑：
// 停止录制，但不保存文件。
chrome.contextMenus.onClicked.addListener((info) => {
  void (async () => {
    await ensureRuntimeReady();

    if (
      info.menuItemId === ACTION_CANCEL_MENU_ID ||
      info.menuItemId === PAGE_CANCEL_MENU_ID
    ) {
      await cancelWorkflow();
    }
  })();
});

// 这是主交互入口：
// - 空闲时点击：开始倒计时
// - 倒计时中 / 启动中点击：取消，不保存
// - 录制中点击：结束并保存
// - 停止中点击：忽略，避免重复触发
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await ensureRuntimeReady();

    if (
      state.status === RECORDING_STATE.COUNTDOWN ||
      state.status === RECORDING_STATE.STARTING
    ) {
      await cancelWorkflow();
      return;
    }

    if (state.status === RECORDING_STATE.RECORDING) {
      await stopWorkflow();
      return;
    }

    if (state.status === RECORDING_STATE.STOPPING) {
      return;
    }

    await startWorkflow(tab);
  } catch (error) {
    console.error("Action click failed", error);
    await cleanupTabUi(state.tabId ?? tab?.id);
    await showTemporaryError(tab?.id, "ERR");
    await resetState();
  }
});

// 被录制的标签页如果被关闭，当前实现按“取消录制”处理，而不是直接保存残缺文件。
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ensureRuntimeReady();

  if (tabId === state.tabId && state.status !== RECORDING_STATE.IDLE) {
    await cancelWorkflow();
  }
});

// 同一个 tab 刷新、跳转、重载时，页面执行环境会被重建。
// 此时继续录制既会丢失页面内的点击可视化和 Esc 热键，也会让录制内容和“开始录制时的页面”不一致，
// 所以这里统一按取消处理。
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  await ensureRuntimeReady();

  if (
    tabId === state.tabId &&
    isCancelableState(state.status) &&
    changeInfo.status === "loading"
  ) {
    await cancelWorkflow();
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await ensureRuntimeReady();

  if (state.tabId && isCancelableState(state.status) && tabId !== state.tabId) {
    await cancelWorkflow();
  }
});

// 这里监听真实下载状态，而不是只看 download() 是否返回 downloadId。
// 这样可以把“下载成功 / 失败后的清理”做在真正终态上，避免 IndexedDB 过早或漏清理。
chrome.downloads.onChanged.addListener((downloadDelta) => {
  void (async () => {
    await ensureRuntimeReady();
    await handleDownloadChanged(downloadDelta);
  })();
});

// 这里是跨上下文消息总线。
// service worker 充当桥梁，因为 content script 和 offscreen 文档都可以给它发消息。
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) {
    return false;
  }

  const withRuntimeReady = async (handler) => {
    await ensureRuntimeReady();
    return handler();
  };

  // offscreen 文档把录制结果转成 blob URL 后，通过这里让后台执行下载保存。
  if (message.type === "offscreen:save-recording") {
    void withRuntimeReady(() => saveRecording(message))
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((error) => {
        console.error("Save recording failed", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  // 页面里按 Esc 触发的是“请求取消”，真正是否能取消由后台状态机判断。
  if (message.type === "recorder:cancel-request") {
    void withRuntimeReady(() => cancelWorkflow())
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("Cancel request failed", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  // 下面两类是 offscreen 录制文档回传的生命周期事件。
  if (message.type === "offscreen:recording-stopped") {
    void withRuntimeReady(() => handleRecordingStopped(message.tabId));
    return false;
  }

  if (message.type === "offscreen:recording-error") {
    void withRuntimeReady(() =>
      handleRecordingError(message.tabId, message.error),
    );
    return false;
  }

  return false;
});

// 启动完整录制流程。
// 主要步骤：
// 1. 校验当前标签页是否可录
// 2. 进入倒计时状态
// 3. 注入 content script，让页面侧的取消热键和点击效果就位
// 4. 切换图标显示倒计时
// 5. 获取 tabCapture 的 stream id
// 6. 通知 offscreen 文档开始录制
async function startWorkflow(tab) {
  if (!tab?.id) {
    throw new Error("No active tab available");
  }

  // 当前版本只支持普通网页，不支持 chrome:// 或扩展页这类受限页面。
  if (!isRecordableTab(tab.url)) {
    throw new Error("This page cannot be recorded");
  }

  await setWorkflowState(RECORDING_STATE.COUNTDOWN, tab.id);
  state.countdownToken += 1;
  await syncContextMenuState();

  await ensureContentScript(tab.id);
  await safeSendToTab(tab.id, { type: "recorder:prepare" });

  // 这个 token 用来防止异步倒计时循环“过期后仍然继续执行”。
  // 例如用户中途取消了，但老的循环还在跑，这里就可以把它拦下来。
  const activeCountdownToken = state.countdownToken;

  for (let remaining = COUNTDOWN_SECONDS; remaining >= 1; remaining -= 1) {
    if (!isActiveCountdown(activeCountdownToken)) {
      return;
    }

    await setTitle(tab.id, `倒计时 ${remaining} 秒后开始录制`);
    await setCountdownIcon(tab.id, String(remaining));
    await wait(1000);
  }

  if (!isActiveCountdown(activeCountdownToken)) {
    return;
  }

  await ensureOffscreenDocument();

  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id,
  });

  // getMediaStreamId 也是异步的。
  // 如果用户在等待这一步时已经切 tab、刷新或手动取消，这里必须立刻停住，
  // 不能再继续把流程推进到 STARTING / RECORDING。
  if (!isActiveCountdown(activeCountdownToken)) {
    return;
  }

  // 这里先进入 STARTING 态。
  // 这是专门用来解决一个竞态问题：
  // 倒计时结束后，到 offscreen 录制器真正开始工作之间有一个很短窗口，
  // 用户可能在这时切 tab、按 Esc 或触发取消。
  // 如果仍然直接把状态当成 COUNTDOWN 或 RECORDING，都可能被旧异步流程覆盖。
  await setWorkflowState(RECORDING_STATE.STARTING, tab.id);
  await syncContextMenuState();

  // STARTING 是一个很短的过渡态，但依然可能被用户操作打断。
  // 所以在继续推进前，先确认状态仍然属于这次录制。
  if (state.status !== RECORDING_STATE.STARTING || state.tabId !== tab.id) {
    return;
  }

  // 点击可视化要在真正开始录制前一刻打开，这样视频里能看到点击效果，
  // 但倒计时阶段不会提前出现录制态视觉元素。
  await safeSendToTab(tab.id, { type: "recorder:start-visuals" });

  // start-visuals 本身也是异步窗口。
  // 如果这一步期间已经取消，再发起 offscreen:start-recording 就会重新点燃一条已终止的流程。
  if (state.status !== RECORDING_STATE.STARTING || state.tabId !== tab.id) {
    return;
  }

  await chrome.runtime.sendMessage({
    type: "offscreen:start-recording",
    streamId,
    tabId: tab.id,
  });

  // 如果这时状态已经不是 STARTING，说明用户在启动窗口里已经取消了，
  // 这里不能再把状态强行写回 RECORDING。
  if (state.status !== RECORDING_STATE.STARTING || state.tabId !== tab.id) {
    return;
  }

  await setWorkflowState(RECORDING_STATE.RECORDING, tab.id);
  await syncContextMenuState();
  await setTitle(tab.id, "录制中，点击扩展图标结束并保存");
  await startRecordingBlink(tab.id);
}

// 停止录制，表示“结束并保存”。
// 这是正常成功路径，由再次点击扩展图标触发。
async function stopWorkflow() {
  const currentTabId = state.tabId;

  if (!currentTabId) {
    await resetState();
    return;
  }

  if (state.status === RECORDING_STATE.COUNTDOWN) {
    // 如果还在倒计时阶段，停止相当于“中止开始”，因为实际上还没开始采集。
    state.countdownToken += 1;
    await cleanupTabUi(currentTabId);
    await setIdleIcon(currentTabId);
    await setTitle(currentTabId, "一键录屏");
    await resetState();
    return;
  }

  if (
    state.status !== RECORDING_STATE.RECORDING &&
    state.status !== RECORDING_STATE.STARTING
  ) {
    return;
  }

  await setWorkflowState(RECORDING_STATE.STOPPING, currentTabId);
  stopRecordingBlink();
  await syncContextMenuState();
  await setIdleIcon(currentTabId);

  // 提前关闭页面上的点击效果，避免录制尾帧还残留视觉覆盖层。
  await cleanupTabUi(currentTabId);

  try {
    await chrome.runtime.sendMessage({
      type: "offscreen:stop-recording",
      tabId: currentTabId,
    });
  } catch (error) {
    console.error("Failed to stop offscreen recorder", error);
    await resetState();
  }
}

// 取消录制，表示“停止但不保存”。
// 会被以下行为触发：
// - 关闭被录制 tab
// - 页面中按 Esc
// - 扩展图标右键菜单取消
// - 页面右键菜单取消
async function cancelWorkflow() {
  const currentTabId = state.tabId;

  if (!currentTabId) {
    await resetState();
    return;
  }

  if (state.status === RECORDING_STATE.COUNTDOWN) {
    // 倒计时阶段还没开始采集，这里只需要清理 UI 即可。
    state.countdownToken += 1;
    await cleanupTabUi(currentTabId);
    await setIdleIcon(currentTabId);
    await setTitle(currentTabId, "一键录屏");
    await resetState();
    return;
  }

  if (
    state.status !== RECORDING_STATE.RECORDING &&
    state.status !== RECORDING_STATE.STARTING
  ) {
    return;
  }

  await setWorkflowState(RECORDING_STATE.STOPPING, currentTabId);
  stopRecordingBlink();
  await syncContextMenuState();
  await cleanupTabUi(currentTabId);
  await setIdleIcon(currentTabId);
  await setTitle(currentTabId, "一键录屏");

  try {
    await chrome.runtime.sendMessage({
      type: "offscreen:cancel-recording",
      tabId: currentTabId,
    });
  } catch (error) {
    console.error("Failed to cancel offscreen recorder", error);
    await resetState();
  }
}

// offscreen 文档完全停止之后回调这里。
async function handleRecordingStopped(tabId) {
  stopRecordingBlink();

  if (tabId) {
    await cleanupTabUi(tabId);
    await setIdleIcon(tabId);
    await setTitle(tabId, "一键录屏");
  }

  await resetState();
}

// 所有录制错误统一走这里，确保图标、标题、页面覆盖层都回到一致状态。
async function handleRecordingError(tabId, errorMessage) {
  console.error("Recording error", errorMessage);
  stopRecordingBlink();

  if (tabId) {
    await cleanupTabUi(tabId);
    await showTemporaryError(tabId, "ERR");
  }

  await resetState();
}

// 真正执行文件保存。
// offscreen 文档只负责录制和产出 blob URL，保存由 service worker 调用 chrome.downloads 完成。
async function saveRecording(message) {
  if (!chrome.downloads?.download) {
    throw new Error(
      "chrome.downloads API is unavailable in the background context",
    );
  }

  if (!message.url || !message.filename) {
    throw new Error("Missing recording download payload");
  }

  const downloadId = await chrome.downloads.download({
    url: message.url,
    filename: message.filename,
    saveAs: false,
  });

  // 只有拿到真实 downloadId 后，后续才能精确监听这次下载的终态。
  // 这样成功和失败都会走到对应的最终清理，而不是只在 download() 返回时“假定成功”。
  if (typeof message.sessionId === "string" && message.sessionId) {
    await rememberPendingDownload(downloadId, {
      sessionId: message.sessionId,
      tabId: typeof message.tabId === "number" ? message.tabId : null,
    });
  }

  return downloadId;
}

// 向目标 tab 注入 content script。
// content script 自己有幂等保护，重复注入不会重复创建覆盖层。
async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
    // 显式固定在扩展的隔离世界里执行。
    // 这样即使页面自身也定义了同名变量或函数，也不会和扩展脚本互相污染作用域。
    world: "ISOLATED",
  });
}

// 懒加载创建 offscreen 文档。
// 整个扩展只需要一个 offscreen 录制页面，所以这里做了并发保护。
async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl],
  });

  if (existingContexts.length > 0) {
    return;
  }

  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
    return;
  }

  creatingOffscreenDocument = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification:
      "Capture the current tab and encode the recording as a local video file.",
  });

  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = null;
  }
}

// 当前实现只允许普通 http / https 页面进入录制流程。
function isRecordableTab(url = "") {
  return /^https?:\/\//.test(url);
}

// 判断当前倒计时循环是否仍然有效。
function isActiveCountdown(token) {
  return (
    state.status === RECORDING_STATE.COUNTDOWN && state.countdownToken === token
  );
}

function isCancelableState(status) {
  return (
    status === RECORDING_STATE.COUNTDOWN ||
    status === RECORDING_STATE.STARTING ||
    status === RECORDING_STATE.RECORDING
  );
}

// 用错误图标短暂提示失败，然后恢复默认状态。
async function showTemporaryError(tabId, text, title = "录屏失败") {
  if (!tabId) {
    return;
  }

  await setTitle(tabId, title);
  await setErrorIcon(tabId, text);
  await wait(1500);
  await setIdleIcon(tabId);
  await setTitle(tabId, "一键录屏");
}

// 将扩展状态重置为空闲，并同步关闭所有取消入口。
async function resetState() {
  stopRecordingBlink();
  await setWorkflowState(RECORDING_STATE.IDLE, null);
  await syncContextMenuState();
}

// worker 不是常驻进程，第一次被唤醒时要先恢复 UI 和录制状态。
// 这里的恢复策略是：
// 1. 先从 storage.session 读出上一次存下来的状态
// 2. 再向 offscreen 文档询问录制器是否还真的活着
// 3. 如果还活着，就把内存状态和图标恢复成录制中
// 4. 如果已经不活了，就清掉陈旧状态，避免 UI 与真实状态脱节
async function ensureRuntimeReady() {
  if (runtimeReady) {
    return;
  }

  if (runtimeReadyPromise) {
    await runtimeReadyPromise;
    return;
  }

  runtimeReadyPromise = initializeRuntime();

  try {
    await runtimeReadyPromise;
    runtimeReady = true;
  } finally {
    runtimeReadyPromise = null;
  }
}

async function initializeRuntime() {
  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: "一键录屏" });
  await setupContextMenu();
  await hydrateStateFromStorage();
  await hydratePendingDownloadsFromStorage();
  await reconcilePendingDownloads();
  await recoverWorkerState();
}

async function hydrateStateFromStorage() {
  if (!chrome.storage?.session) {
    return;
  }

  const stored = await chrome.storage.session.get(WORKFLOW_STATE_STORAGE_KEY);
  const workflowState = stored[WORKFLOW_STATE_STORAGE_KEY];

  if (!workflowState) {
    state.status = RECORDING_STATE.IDLE;
    state.tabId = null;
    return;
  }

  state.status = workflowState.status || RECORDING_STATE.IDLE;
  state.tabId =
    typeof workflowState.tabId === "number" ? workflowState.tabId : null;
}

async function recoverWorkerState() {
  const offscreenStatus = await getOffscreenStatus();

  if (!offscreenStatus.active) {
    await setIdleIcon();
    await resetState();
    return;
  }

  // COUNTDOWN / STARTING / STOPPING 这类过渡态无法跨 worker 生命周期精确恢复。
  // 如果探测到 offscreen 实际还在录，就统一收敛成 RECORDING，
  // 至少能保证用户还能看到正确图标，并能正常结束或取消。
  const recoveredTabId =
    typeof offscreenStatus.tabId === "number" ? offscreenStatus.tabId : state.tabId;

  if (!recoveredTabId) {
    await chrome.runtime.sendMessage({
      type: "offscreen:cancel-recording",
      tabId: state.tabId,
    });
    await setIdleIcon();
    await resetState();
    return;
  }

  await setWorkflowState(RECORDING_STATE.RECORDING, recoveredTabId);
  await syncContextMenuState();
  await setTitle(recoveredTabId, "录制中，点击扩展图标结束并保存");
  await startRecordingBlink(recoveredTabId);
}

async function getOffscreenStatus() {
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl],
  });

  if (existingContexts.length === 0) {
    return { active: false, tabId: null };
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "offscreen:get-status",
    });

    return response?.ok
      ? { active: Boolean(response.active), tabId: response.tabId ?? null }
      : { active: false, tabId: null };
  } catch (error) {
    console.warn("Failed to query offscreen status", error);
    return { active: false, tabId: null };
  }
}

async function setWorkflowState(status, tabId) {
  state.status = status;
  state.tabId = typeof tabId === "number" ? tabId : null;

  if (!chrome.storage?.session) {
    return;
  }

  if (status === RECORDING_STATE.IDLE && state.tabId === null) {
    await chrome.storage.session.remove(WORKFLOW_STATE_STORAGE_KEY);
    return;
  }

  await chrome.storage.session.set({
    [WORKFLOW_STATE_STORAGE_KEY]: {
      status,
      tabId: state.tabId,
      updatedAt: Date.now(),
    },
  });
}

async function hydratePendingDownloadsFromStorage() {
  pendingDownloads.clear();

  if (!chrome.storage?.session) {
    return;
  }

  const stored = await chrome.storage.session.get(PENDING_DOWNLOADS_STORAGE_KEY);
  const downloadEntries = stored[PENDING_DOWNLOADS_STORAGE_KEY];

  if (!downloadEntries || typeof downloadEntries !== "object") {
    return;
  }

  for (const [downloadIdText, value] of Object.entries(downloadEntries)) {
    const downloadId = Number(downloadIdText);

    if (!Number.isFinite(downloadId) || typeof value?.sessionId !== "string") {
      continue;
    }

    pendingDownloads.set(downloadId, {
      sessionId: value.sessionId,
      tabId: typeof value.tabId === "number" ? value.tabId : null,
    });
  }
}

async function persistPendingDownloads() {
  if (!chrome.storage?.session) {
    return;
  }

  if (pendingDownloads.size === 0) {
    await chrome.storage.session.remove(PENDING_DOWNLOADS_STORAGE_KEY);
    return;
  }

  await chrome.storage.session.set({
    [PENDING_DOWNLOADS_STORAGE_KEY]: Object.fromEntries(
      pendingDownloads.entries(),
    ),
  });
}

async function rememberPendingDownload(downloadId, payload) {
  pendingDownloads.set(downloadId, payload);
  await persistPendingDownloads();
}

// worker 可能在下载过程中被回收，所以重启时要把“挂起下载”重新核对一遍。
// 如果文件其实已经完成或失败了，但映射还残留在 storage.session，会造成脏状态。
async function reconcilePendingDownloads() {
  const pendingIds = [...pendingDownloads.keys()];
  const downloadItems = await chrome.downloads.search({});

  for (const downloadId of pendingIds) {
    try {
      // downloads.search 的过滤能力在不同版本上并不稳定覆盖到 id 字段，
      // 这里直接取列表后按 id 精确匹配，兼容性更稳。
      const downloadItem = downloadItems.find((item) => item.id === downloadId);

      if (!downloadItem) {
        await finalizePendingDownload(downloadId, false, "DOWNLOAD_NOT_FOUND");
        continue;
      }

      if (downloadItem.state === "complete") {
        await finalizePendingDownload(downloadId, true);
        continue;
      }

      if (downloadItem.state === "interrupted") {
        await finalizePendingDownload(
          downloadId,
          false,
          downloadItem.error || "DOWNLOAD_INTERRUPTED",
        );
      }
    } catch (error) {
      console.warn("Failed to reconcile pending download", downloadId, error);
    }
  }
}

async function handleDownloadChanged(downloadDelta) {
  if (!pendingDownloads.has(downloadDelta.id)) {
    return;
  }

  if (downloadDelta.state?.current === "complete") {
    await finalizePendingDownload(downloadDelta.id, true);
    return;
  }

  if (
    downloadDelta.state?.current === "interrupted" ||
    typeof downloadDelta.error?.current === "string"
  ) {
    await finalizePendingDownload(
      downloadDelta.id,
      false,
      downloadDelta.error?.current || "DOWNLOAD_INTERRUPTED",
    );
  }
}

async function finalizePendingDownload(downloadId, succeeded, failureReason = "") {
  const pendingDownload = pendingDownloads.get(downloadId);

  if (!pendingDownload) {
    return;
  }

  pendingDownloads.delete(downloadId);
  await persistPendingDownloads();

  try {
    // IndexedDB 分片和 object URL 都由 offscreen 持有，所以真正终态到来后，
    // 需要回到 offscreen 执行最终释放，避免 service worker 只删自己的状态。
    await chrome.runtime.sendMessage({
      type: "offscreen:finalize-download-artifact",
      sessionId: pendingDownload.sessionId,
      succeeded,
      error: failureReason,
    });
  } catch (error) {
    console.warn("Failed to finalize download artifact", downloadId, error);
  }

  if (!succeeded && pendingDownload.tabId) {
    console.error("Recording download failed", failureReason || "unknown");
    await showTemporaryError(
      pendingDownload.tabId,
      "ERR",
      "录制已结束，但文件保存失败",
    );
  }
}

// 向页面发消息时要允许失败，因为页面可能已经关闭、跳转或脚本未就绪。
// “Receiving end does not exist” 在这类场景下属于可接受情况。
async function safeSendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);

    if (!messageText.includes("Receiving end does not exist")) {
      console.warn("Message to tab failed", error);
    }
  }
}

// 统一清理页面侧的交互状态。
// 当前实现里 stop-visuals 不只是关闭点击可视化，还会顺带移除 Esc 取消热键。
async function cleanupTabUi(tabId) {
  if (!tabId) {
    return;
  }

  await safeSendToTab(tabId, { type: "recorder:stop-visuals" });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// tab 被关闭时，Chrome 清理图标 / 标题状态可能会抛 “No tab with id”，这里视为可忽略。
function isMissingTabError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("No tab with id");
}

// 设置扩展图标 hover 时显示的标题提示。
async function setTitle(tabId, title) {
  try {
    await chrome.action.setTitle({ tabId, title });
  } catch (error) {
    if (!isMissingTabError(error)) {
      throw error;
    }
  }
}

// 空闲态图标：
// 白色底、红色外圈、中间红点。
// 同时这也是 manifest 中声明的静态扩展图标样式。
async function setIdleIcon(tabId) {
  await setActionIcon({
    tabId,
    backgroundColor: "#ffffff",
    borderColor: "#dc2626",
    glyph: "dot",
    glyphColor: "#dc2626",
    dotRadius: RECORDING_DOT_RADIUS,
  });
}

// 倒计时图标：
// 整个红色圆形背景，中间白字数字。
async function setCountdownIcon(tabId, text) {
  await setActionIcon({
    tabId,
    backgroundColor: "#dc2626",
    glyph: "text",
    text,
    textColor: "#ffffff",
  });
}

// 录制中亮态图标：
// 红色外圈、白色背景、中间红点。
async function setRecordingIcon(tabId) {
  await setActionIcon({
    tabId,
    backgroundColor: "#ffffff",
    borderColor: "#dc2626",
    glyph: "dot",
    glyphColor: "#dc2626",
    dotRadius: RECORDING_DOT_RADIUS,
  });
}

// 录制中暗态图标：
// 保留外圈，把中间点画成白色，视觉上就像红点“熄灭”。
async function setRecordingDimIcon(tabId) {
  await setActionIcon({
    tabId,
    backgroundColor: "#ffffff",
    borderColor: "#dc2626",
    glyph: "dot",
    glyphColor: "#ffffff",
    dotRadius: RECORDING_DOT_RADIUS,
  });
}

// 错误态图标：
// 用红底白字 ERR，尽量保证异常一眼可见。
async function setErrorIcon(tabId, text) {
  await setActionIcon({
    tabId,
    backgroundColor: "#b91c1c",
    glyph: "text",
    text,
    textColor: "#ffffff",
  });
}

// 所有图标更新都统一走这里，这样 badge 清理和异常处理都能保持一致。
async function setActionIcon(options) {
  const { tabId } = options;
  const badgeArgs =
    typeof tabId === "number" ? { tabId, text: "" } : { text: "" };

  try {
    await chrome.action.setBadgeText(badgeArgs);
    await chrome.action.setIcon({
      ...(typeof tabId === "number" ? { tabId } : {}),
      imageData: buildIconSet(options),
    });
  } catch (error) {
    if (!isMissingTabError(error)) {
      throw error;
    }
  }
}

// 只有倒计时中或录制中，取消菜单才应该可点击。
// 平时保留菜单项，但会被禁用。
async function syncContextMenuState() {
  const enabled =
    state.status === RECORDING_STATE.COUNTDOWN ||
    state.status === RECORDING_STATE.STARTING ||
    state.status === RECORDING_STATE.RECORDING;

  await updateContextMenu(ACTION_CANCEL_MENU_ID, enabled);
  await updateContextMenu(PAGE_CANCEL_MENU_ID, enabled);
}

// 统一重建右键菜单。
// service worker 可能被回收重建，直接 removeAll 后重新 create 最稳妥。
async function setupContextMenu() {
  await chrome.contextMenus.removeAll();

  chrome.contextMenus.create({
    id: ACTION_CANCEL_MENU_ID,
    title: "取消录制（不保存）",
    contexts: ["action"],
    enabled: false,
  });

  chrome.contextMenus.create({
    id: PAGE_CANCEL_MENU_ID,
    title: "取消录制（不保存）",
    contexts: [
      "page",
      "frame",
      "selection",
      "link",
      "editable",
      "image",
      "video",
      "audio",
    ],
    enabled: false,
  });
}

// 单个菜单更新失败不应该影响整个录制流程，所以这里只做警告日志。
async function updateContextMenu(id, enabled) {
  try {
    await chrome.contextMenus.update(id, { enabled });
  } catch (error) {
    console.warn("Context menu update failed", id, error);
  }
}

// 启动录制中闪烁效果。
// 本质上是定时在“亮态红点”和“暗态白点”之间切换。
async function startRecordingBlink(tabId) {
  stopRecordingBlink();
  state.recordingBlinkVisible = true;
  await setRecordingIcon(tabId);

  state.recordingBlinkIntervalId = setInterval(() => {
    if (state.status !== RECORDING_STATE.RECORDING || state.tabId !== tabId) {
      stopRecordingBlink();
      return;
    }

    state.recordingBlinkVisible = !state.recordingBlinkVisible;
    void (state.recordingBlinkVisible
      ? setRecordingIcon(tabId)
      : setRecordingDimIcon(tabId));
  }, RECORDING_BLINK_HALF_CYCLE_MS);
}

// 避免多个闪烁计时器叠加。
function stopRecordingBlink() {
  if (state.recordingBlinkIntervalId) {
    clearInterval(state.recordingBlinkIntervalId);
    state.recordingBlinkIntervalId = null;
  }

  state.recordingBlinkVisible = true;
}

// chrome.action.setIcon 需要的是 {16: ImageData, 32: ImageData} 这种结构。
function buildIconSet(options) {
  return Object.fromEntries(
    ICON_SIZES.map((size) => [size, drawIcon(size, options)]),
  );
}

// 动态绘制扩展图标。
// 这就是为什么倒计时可以“替换整个扩展图标”，而不是只显示一个小 badge。
function drawIcon(size, options) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("Unable to acquire icon drawing context");
  }

  const center = size / 2;
  const radius = size * ICON_CIRCLE_RADIUS;

  ctx.clearRect(0, 0, size, size);

  // 先画底层圆形背景。
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.fillStyle = options.backgroundColor;
  ctx.fill();

  // 空闲态和录制态需要额外画红色外圈。
  if (options.borderColor) {
    ctx.lineWidth = Math.max(1.5, size * 0.08);
    ctx.strokeStyle = options.borderColor;
    ctx.stroke();
  }

  // 倒计时和错误态使用文字 glyph。
  if (options.glyph === "text" && options.text) {
    ctx.fillStyle = options.textColor || "#ffffff";
    ctx.font = `700 ${Math.floor(size * 0.7)}px Arial`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(options.text, center, center + size * 0.02);
  }

  // 空闲态和录制态使用中间圆点 glyph。
  if (options.glyph === "dot") {
    ctx.beginPath();
    ctx.arc(
      center,
      center,
      size * (options.dotRadius || RECORDING_DOT_RADIUS),
      0,
      Math.PI * 2,
    );
    ctx.fillStyle = options.glyphColor || "#ffffff";
    ctx.fill();
  }

  return ctx.getImageData(0, 0, size, size);
}
