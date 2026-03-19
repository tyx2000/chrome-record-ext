// offscreen 文档负责真正的媒体录制。
// 因为 MV3 的 service worker 不适合长期持有 MediaRecorder 和 MediaStream，
// 所以录制链路放在这个独立文档里执行。
//
// 这里主要负责：
// 1. 把 tabCapture 的 stream id 变成真实 MediaStream
// 2. 用 MediaRecorder 录制这个流
// 3. 决定录制结果是保存还是丢弃
// 4. 把录制完成 / 失败状态回传给 service worker
//
// 这里额外做了一件和边界情况相关的优化：
// 录制分片不再一直堆在内存数组里，而是边录边写入 IndexedDB。
// 这样长时间录制时，块数据主要落在浏览器存储层，能显著降低内存压力。

const CHUNK_DB_NAME = "one-click-recorder";
const CHUNK_STORE_NAME = "recording-chunks";

let mediaRecorder = null;
let capturedStream = null;
let activeTabId = null;
let cancelRequested = false;
let recordingSessionId = null;
let nextChunkIndex = 0;
let chunkWriteChain = Promise.resolve();
let chunkWriteError = null;
let chunkDbPromise = null;
const pendingArtifacts = new Map();
const chunkStorageReady = bootstrapChunkStorage();

// service worker 通过消息驱动录制生命周期。
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "offscreen:start-recording") {
    startRecording(message.streamId, message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("Failed to start recording", error);
        void chrome.runtime.sendMessage({
          type: "offscreen:recording-error",
          tabId: message.tabId,
          error: error instanceof Error ? error.message : String(error),
        });
        sendResponse({ ok: false });
      });

    return true;
  }

  if (message?.type === "offscreen:stop-recording") {
    stopRecording()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("Failed to stop recording", error);
        void chrome.runtime.sendMessage({
          type: "offscreen:recording-error",
          tabId: message.tabId,
          error: error instanceof Error ? error.message : String(error),
        });
        sendResponse({ ok: false });
      });

    return true;
  }

  if (message?.type === "offscreen:cancel-recording") {
    cancelRecording()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("Failed to cancel recording", error);
        void chrome.runtime.sendMessage({
          type: "offscreen:recording-error",
          tabId: message.tabId,
          error: error instanceof Error ? error.message : String(error),
        });
        sendResponse({ ok: false });
      });

    return true;
  }

  // service worker 重启后会通过这个接口探测 offscreen 录制器是否仍然活着。
  // 这样可以区分“只是内存状态丢了”和“录制其实早就结束了”。
  if (message?.type === "offscreen:get-status") {
    sendResponse({
      ok: true,
      active: Boolean(mediaRecorder && mediaRecorder.state !== "inactive"),
      recorderState: mediaRecorder?.state || "inactive",
      tabId: activeTabId,
    });
    return false;
  }

  // 下载真正结束后，service worker 会回到这里做最终清理。
  // 这样可以把“文件写盘完成 / 失败”和“IndexedDB 分片删除”绑定在同一个终态上。
  if (message?.type === "offscreen:finalize-download-artifact") {
    finalizeDownloadArtifact(
      message.sessionId,
      Boolean(message.succeeded),
      message.error,
    )
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("Failed to finalize download artifact", error);
        sendResponse({ ok: false });
      });

    return true;
  }

  return false;
});

// 开启一段新的录制会话。
// 作用：
// 1. 记录当前目标 tab
// 2. 获取 tab 对应的 MediaStream
// 3. 绑定 MediaRecorder 各类回调
// 4. 初始化分片存储会话
// 5. 开始持续产出数据块
async function startRecording(streamId, tabId) {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    throw new Error("A recording is already in progress");
  }

  await chunkStorageReady;

  activeTabId = tabId;
  cancelRequested = false;
  recordingSessionId = createRecordingSessionId(tabId);
  nextChunkIndex = 0;
  chunkWriteChain = Promise.resolve();
  chunkWriteError = null;

  try {
    // 某些页面可能无法采集音频，但仍可采集视频。
    // 所以这里优先尝试音视频一起抓，失败时再退回纯视频。
    capturedStream = await getTabStream(streamId);

    const videoTrack = capturedStream.getVideoTracks()[0];

    if (videoTrack) {
      // 如果底层 tab 流被 Chrome 或页面侧中断，主动停止 recorder，
      // 这样可以保证后续 cleanup 和状态同步还能正常执行。
      videoTrack.addEventListener(
        "ended",
        () => {
          if (mediaRecorder && mediaRecorder.state !== "inactive") {
            mediaRecorder.stop();
          }
        },
        { once: true },
      );
    }

    mediaRecorder = new MediaRecorder(capturedStream, getRecorderOptions());
    mediaRecorder.addEventListener("dataavailable", handleDataAvailable);
    mediaRecorder.addEventListener("stop", handleRecorderStop);
    mediaRecorder.addEventListener("error", handleRecorderError);

    // 每秒输出一个 chunk，长录制时写盘频率和内存占用更平衡。
    mediaRecorder.start(1000);
  } catch (error) {
    // 启动阶段如果失败，也要清理已拿到的媒体流和临时分片存储，
    // 否则会留下半初始化状态，影响下一次录制。
    await discardSessionChunksSafely(recordingSessionId);
    await cleanup();
    throw error;
  }
}

// 正常结束录制，表示“停止并保存”。
async function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    await chrome.runtime.sendMessage({
      type: "offscreen:recording-stopped",
      tabId: activeTabId,
    });
    await cleanup();
    return;
  }

  mediaRecorder.stop();
}

// 取消录制，表示“停止但不保存”。
// 这里要特别处理“启动中取消”的情况：
// 如果 recorder 还没真正进入 active，也要主动回发 recording-stopped，
// 否则 service worker 会一直停在 STOPPING。
async function cancelRecording() {
  cancelRequested = true;

  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    // 启动中取消等分支可能还没进入 stop 回调，这里显式删除分片，
    // 保证“取消录制”语义一定会清空本次会话的缓存数据。
    await discardSessionChunksSafely(recordingSessionId);
    await chrome.runtime.sendMessage({
      type: "offscreen:recording-stopped",
      tabId: activeTabId,
    });
    await cleanup();
    return;
  }

  mediaRecorder.stop();
}

// MediaRecorder 会分块吐出数据。
// 这里不再把分片一直堆在内存数组里，而是串行写入 IndexedDB。
// 这样长录制时不会因为 recordedChunks 持续增长而占用大量 JS 堆内存。
function handleDataAvailable(event) {
  if (!event.data || event.data.size <= 0 || !recordingSessionId) {
    return;
  }

  const chunk = event.data;
  const sessionId = recordingSessionId;
  const chunkIndex = nextChunkIndex;
  nextChunkIndex += 1;

  chunkWriteChain = chunkWriteChain
    .then(async () => {
      if (chunkWriteError) {
        return;
      }

      await saveChunk(sessionId, chunkIndex, chunk);
    })
    .catch((error) => {
      chunkWriteError = error;
    });
}

// MediaRecorder 完全停止后的回调。
// 作用：
// 1. 等待所有分片写入完成
// 2. 如果是取消录制，则直接丢弃输出
// 3. 如果是正常结束，则从 IndexedDB 取回分片并拼接 Blob
// 4. 生成临时 object URL
// 5. 把保存请求交给 service worker
// 6. 通知 service worker 本次录制已结束
async function handleRecorderStop() {
  const sessionId = recordingSessionId;
  let artifactRegistered = false;

  try {
    await chunkWriteChain;

    if (chunkWriteError) {
      throw chunkWriteError;
    }

    if (cancelRequested) {
      // 取消录制时明确删除本次会话的全部分片。
      // 虽然 cleanup 里也有兜底删除，但这里显式执行能保证“取消即清空”。
      await discardSessionChunksSafely(sessionId);
      return;
    }

    const mimeType = mediaRecorder?.mimeType || "video/webm";
    const chunkBlobs = await getChunksForSession(sessionId);
    const blob = new Blob(chunkBlobs, { type: mimeType });
    const objectUrl = URL.createObjectURL(blob);

    // blob URL 由 offscreen 生成，也只能在这里安全 revoke。
    // 所以先把它和 sessionId 绑定起来，等后台确认下载成功或失败后再统一清理。
    registerPendingArtifact(sessionId, objectUrl);
    artifactRegistered = true;

    // 实际下载保存由 service worker 执行，因为那边负责 chrome.downloads。
    const saveResult = await chrome.runtime.sendMessage({
      type: "offscreen:save-recording",
      tabId: activeTabId,
      url: objectUrl,
      filename: buildFileName(),
      sessionId,
    });

    if (!saveResult?.ok) {
      throw new Error(saveResult?.error || "Failed to save recording");
    }
  } catch (error) {
    if (artifactRegistered) {
      await discardPendingArtifactSafely(sessionId);
      artifactRegistered = false;
    }

    await chrome.runtime.sendMessage({
      type: "offscreen:recording-error",
      tabId: activeTabId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    try {
      // 无论是保存还是取消，都会通知 service worker 录制链路已结束，
      // 让它统一恢复图标、标题、菜单和页面覆盖层状态。
      await chrome.runtime.sendMessage({
        type: "offscreen:recording-stopped",
        tabId: activeTabId,
      });
    } finally {
      if (!artifactRegistered) {
        await discardSessionChunksSafely(sessionId);
      }
      await cleanup();
    }
  }
}

// MediaRecorder 自身抛出的错误会走这里，而不是上层的 try/catch。
async function handleRecorderError(event) {
  const error = event?.error;
  const sessionId = recordingSessionId;

  await chrome.runtime.sendMessage({
    type: "offscreen:recording-error",
    tabId: activeTabId,
    error: error?.message || "MediaRecorder failed",
  });

  // recorder 自身失败时，也要立即回收当前会话的分片数据。
  await discardSessionChunksSafely(sessionId);
  await cleanup();
}

// 彻底清理本次录制留下的状态和资源，保证下次录制从干净环境开始。
async function cleanup() {
  const sessionId = recordingSessionId;

  if (mediaRecorder) {
    mediaRecorder.removeEventListener("dataavailable", handleDataAvailable);
    mediaRecorder.removeEventListener("stop", handleRecorderStop);
    mediaRecorder.removeEventListener("error", handleRecorderError);
  }

  if (capturedStream) {
    capturedStream.getTracks().forEach((track) => track.stop());
  }

  mediaRecorder = null;
  capturedStream = null;
  activeTabId = null;
  cancelRequested = false;
  recordingSessionId = null;
  nextChunkIndex = 0;
  chunkWriteChain = Promise.resolve();
  chunkWriteError = null;

  if (sessionId && !pendingArtifacts.has(sessionId)) {
    // 这里保留为最终兜底，防止前面的显式删除因为异常中断而漏掉。
    // 但如果这次录制已经进入“等待下载终态”的阶段，就不能在 cleanup 里提前删掉。
    await deleteChunksForSession(sessionId);
  }
}

// 优先尝试更高质量的编码格式，不支持时再逐级降级。
function getRecorderOptions() {
  const mimeTypes = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];

  const mimeType = mimeTypes.find((item) => MediaRecorder.isTypeSupported(item));

  return mimeType ? { mimeType } : {};
}

// 将 tabCapture 返回的 stream id 转成真实可录制的 MediaStream。
// 音频采集是尽力而为，失败后会自动退回到纯视频。
async function getTabStream(streamId) {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
          maxFrameRate: 30,
        },
      },
    });
  } catch (error) {
    console.warn("Falling back to video-only capture", error);

    return navigator.mediaDevices.getUserMedia({
      video: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
          maxFrameRate: 30,
        },
      },
    });
  }
}

// 懒加载打开 IndexedDB，用来保存录制分片。
function getChunkDb() {
  if (chunkDbPromise) {
    return chunkDbPromise;
  }

  chunkDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(CHUNK_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(CHUNK_STORE_NAME)) {
        const store = db.createObjectStore(CHUNK_STORE_NAME, {
          keyPath: ["sessionId", "index"],
        });
        store.createIndex("sessionId", "sessionId", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Failed to open chunk database"));
  });

  return chunkDbPromise;
}

// offscreen 文档每次全新创建时，先做一次陈旧分片清扫。
// 这主要解决浏览器异常退出、扩展重载或脚本崩溃后遗留的旧 chunk 数据。
// 当前实现一次只允许存在一段录制，因此启动时清空旧分片是安全的。
async function bootstrapChunkStorage() {
  await getChunkDb();
  await deleteAllChunks();
}

// 将单个录制分片写入 IndexedDB。
function saveChunk(sessionId, index, chunk) {
  return withChunkStore("readwrite", (store) => {
    return requestToPromise(
      store.put({
        sessionId,
        index,
        chunk,
      }),
    );
  });
}

// 停止时按顺序取回本次会话的所有分片，用于最终拼接 Blob。
async function getChunksForSession(sessionId) {
  if (!sessionId) {
    return [];
  }

  return withChunkStore("readonly", (store) => {
    return new Promise((resolve, reject) => {
      const request = store.index("sessionId").getAll(IDBKeyRange.only(sessionId));

      request.onsuccess = () => {
        const chunks = request.result
          .sort((a, b) => a.index - b.index)
          .map((item) => item.chunk);
        resolve(chunks);
      };

      request.onerror = () => {
        reject(request.error || new Error("Failed to read recording chunks"));
      };
    });
  });
}

// 会话结束后删除分片，避免 IndexedDB 无限累积。
async function deleteChunksForSession(sessionId) {
  if (!sessionId) {
    return;
  }

  await withChunkStore("readwrite", (store) => {
    return new Promise((resolve, reject) => {
      const request = store.index("sessionId").openKeyCursor(IDBKeyRange.only(sessionId));

      request.onsuccess = () => {
        const cursor = request.result;

        if (!cursor) {
          resolve();
          return;
        }

        const deleteRequest = store.delete(cursor.primaryKey);
        deleteRequest.onsuccess = () => cursor.continue();
        deleteRequest.onerror = () =>
          reject(deleteRequest.error || new Error("Failed to delete recording chunk"));
      };

      request.onerror = () => {
        reject(request.error || new Error("Failed to iterate recording chunks"));
      };
    });
  });
}

async function deleteAllChunks() {
  await withChunkStore("readwrite", (store) => {
    return requestToPromise(store.clear());
  });
}

async function discardSessionChunksSafely(sessionId) {
  if (!sessionId) {
    return;
  }

  try {
    await deleteChunksForSession(sessionId);
  } catch (error) {
    console.warn("Failed to discard session chunks", sessionId, error);
  }
}

function registerPendingArtifact(sessionId, objectUrl) {
  if (!sessionId || !objectUrl) {
    return;
  }

  pendingArtifacts.set(sessionId, { objectUrl });
}

async function discardPendingArtifactSafely(sessionId) {
  const artifact = pendingArtifacts.get(sessionId);

  pendingArtifacts.delete(sessionId);
  await discardSessionChunksSafely(sessionId);

  if (artifact?.objectUrl) {
    URL.revokeObjectURL(artifact.objectUrl);
  }
}

// 下载最终成功或失败时，都应该回收这次录制留下的两类资源：
// 1. IndexedDB 里的 chunk 分片
// 2. offscreen 内持有的 blob object URL
// 这样既满足“下载终态后清理”，也避免长时间滞留无用对象。
async function finalizeDownloadArtifact(sessionId, succeeded, errorMessage) {
  if (!succeeded && errorMessage) {
    console.warn("Download finished with error", errorMessage);
  }

  await discardPendingArtifactSafely(sessionId);
}

async function withChunkStore(mode, callback) {
  const db = await getChunkDb();
  const transaction = db.transaction(CHUNK_STORE_NAME, mode);
  const store = transaction.objectStore(CHUNK_STORE_NAME);

  return callback(store, transaction);
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

function createRecordingSessionId(tabId) {
  const random = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return `${tabId}-${Date.now()}-${random}`;
}

// 构造一个可排序的文件名，并直接跟随浏览器默认下载目录。
// Build a sortable file name and let the browser place it in the default download directory.
function buildFileName() {
  const now = new Date();
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ];
  const time = [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ];

  return `screen-recording-${parts.join("-")}-${time.join("-")}.webm`;
}
