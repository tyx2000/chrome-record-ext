// content script 只负责页面本地的交互体验，不负责真正录制媒体。
// 这里主要做三件事：
// 1. 把点击动作可视化，让录下来的视频能看到用户点击位置
// 2. 监听 Esc，让用户可以在页面里直接取消录制
// 3. 响应 service worker 发来的生命周期消息

(() => {
  // 避免重复注入时重复创建覆盖层和事件监听。
  if (window.__oneClickRecorderOverlay) {
    return;
  }

  const OVERLAY_ID = "__one_click_recorder_overlay__";
  const STYLE_ID = "__one_click_recorder_style__";

  const state = {
    active: false,
    cleanupFns: [],
    // Esc 在倒计时阶段和录制阶段都要生效，所以单独管理。
    hotkeyCleanup: null,
    overlayEl: null
  };

  // 接收后台发来的状态切换消息。
  chrome.runtime.onMessage.addListener((message) => {
    if (!message?.type) {
      return;
    }

    if (message.type === "recorder:prepare") {
      mount();
      enableCancelHotkey();
      return;
    }

    if (message.type === "recorder:start-visuals") {
      startVisuals();
      return;
    }

    if (message.type === "recorder:stop-visuals") {
      stopVisuals();
    }
  });

  window.__oneClickRecorderOverlay = true;

  // 创建一个全局复用的页面覆盖层，用来承载点击动画。
  function mount() {
    ensureStyles();

    if (state.overlayEl) {
      return;
    }

    const overlayEl = document.createElement("div");
    overlayEl.id = OVERLAY_ID;
    overlayEl.setAttribute("aria-hidden", "true");

    document.documentElement.appendChild(overlayEl);
    state.overlayEl = overlayEl;
  }

  // 在真正开始录制时开启点击可视化。
  function startVisuals() {
    mount();

    if (state.active || !state.overlayEl) {
      return;
    }

    state.active = true;
    state.overlayEl.dataset.active = "true";

    // pointerdown 可以统一捕获鼠标、触控笔和触摸点击。
    const onPointerDown = (event) => {
      spawnClick(event.clientX, event.clientY);
    };

    document.addEventListener("pointerdown", onPointerDown, true);

    state.cleanupFns.push(() => {
      document.removeEventListener("pointerdown", onPointerDown, true);
    });
  }

  // 停止页面侧点击可视化，并移除残留点击动画。
  function stopVisuals() {
    state.active = false;
    state.cleanupFns.splice(0).forEach((fn) => fn());
    disableCancelHotkey();

    if (state.overlayEl) {
      state.overlayEl.dataset.active = "false";
      state.overlayEl.querySelectorAll(".ocr-click").forEach((node) => node.remove());
    }
  }

  // 在点击位置生成一个扩散圆环，让视频里能清楚看到用户点了哪里。
  function spawnClick(x, y) {
    if (!state.overlayEl) {
      return;
    }

    const clickRing = document.createElement("div");
    clickRing.className = "ocr-click";
    clickRing.style.left = `${x}px`;
    clickRing.style.top = `${y}px`;
    state.overlayEl.appendChild(clickRing);

    window.setTimeout(() => {
      clickRing.remove();
    }, 700);
  }

  // 只注入一次样式，让脚本本身保持自包含，不需要额外 css 文件。
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${OVERLAY_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        pointer-events: none;
        opacity: 0;
        transition: opacity 120ms ease;
      }

      #${OVERLAY_ID}[data-active="true"] {
        opacity: 1;
      }

      #${OVERLAY_ID} .ocr-click {
        position: fixed;
        left: -9999px;
        top: -9999px;
        width: 18px;
        height: 18px;
        margin-left: -9px;
        margin-top: -9px;
        border: 2px solid rgba(15, 23, 42, 0.45);
        border-radius: 999px;
        animation: ocr-click-pulse 420ms ease-out forwards;
      }

      @keyframes ocr-click-pulse {
        0% {
          opacity: 0.45;
          transform: scale(0.7);
        }

        100% {
          opacity: 0;
          transform: scale(2.2);
        }
      }
    `;

    document.documentElement.appendChild(style);
  }

  // 从倒计时开始就启用 Esc，而不是等录制开始后才启用。
  // 这样用户一旦误触开始，就能立刻取消。
  function enableCancelHotkey() {
    if (state.hotkeyCleanup) {
      return;
    }

    // 页面本身不直接管理录制状态，它只负责把取消请求转给后台。
    const onKeyDown = (event) => {
      if (event.key !== "Escape") {
        return;
      }

      // 如果用户正在输入框、文本域或可编辑区域里操作，
      // Esc 很可能是页面本身的输入交互按键，不应该直接拿来取消录制。
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.closest('[contenteditable="true"]'))
      ) {
        return;
      }

      void chrome.runtime.sendMessage({
        type: "recorder:cancel-request"
      });
    };

    document.addEventListener("keydown", onKeyDown, true);
    state.hotkeyCleanup = () => {
      document.removeEventListener("keydown", onKeyDown, true);
      state.hotkeyCleanup = null;
    };
  }

  // 如果热键监听已经被清理，这里会安全地什么都不做。
  function disableCancelHotkey() {
    state.hotkeyCleanup?.();
  }
})();
