import { currentLocale, initI18n, t } from "./i18n.js";

const byteEncoder = new TextEncoder();
const TURN_PAGE_LIMIT = 6;
const TURN_ITEMS_VIEW = "full";
const THEME_STORAGE_KEY = "codex-mobile-theme";
const LAST_THREAD_STORAGE_KEY = "codex-mobile-last-thread-id";
const TOKEN_STORAGE_KEY = "codex-mobile-access-token";
const THREAD_URL_PARAM = "thread";
const IMAGE_UPLOAD_TARGET_BYTES = 1400 * 1024;
const IMAGE_UPLOAD_MAX_EDGE = 1800;
const IMAGE_UPLOAD_MAX_PIXELS = 2400000;
const IMAGE_UPLOAD_JPEG_QUALITIES = [0.84, 0.74, 0.64];

const state = {
  ws: null,
  token: null,
  nextRequestId: 1,
  pending: new Map(),
  threads: [],
  expandedProjects: new Set(),
  pendingImages: [],
  currentThread: null,
  lastMessageAt: null,
  loadingThreadId: null,
  threadLoadSeq: 0,
  threadLoadStats: null,
  lastLoadStats: null,
  turnCursor: null,
  hasOlderTurns: false,
  loadingOlderTurns: false,
  resumingThreadId: null,
  loadedTurnIds: new Set(),
  activeTurns: new Map(),
  replyProgressThreadIds: new Set(),
  turnDiagnostics: new Map(),
  messages: [],
  models: [],
  config: null,
  connected: false,
  account: null,
  urlThreadId: ""
};

let threadTitleScrollFrame = null;
let threadTitleScrollTimer = null;
let threadTitleBeforeEdit = "";
let threadTitleSaving = false;
let backGuardSerial = 0;
let backGuardBaseUrl = "";
let backGuardHandling = false;
let backGuardArmedAt = 0;
let backSentinels = [];
let backSentinelReopening = false;
const BACK_GUARD_HASH_PREFIX = "codex-mobile-stay-";
const BACK_SENTINEL_COUNT = 4;

const els = {
  connection: document.querySelector("#connection"),
  connectionBanner: document.querySelector("#connectionBanner"),
  threadList: document.querySelector("#threadList"),
  searchThreads: document.querySelector("#searchThreads"),
  newThread: document.querySelector("#newThread"),
  refreshThreads: document.querySelector("#refreshThreads"),
  openSidebar: document.querySelector("#openSidebar"),
  closeSidebar: document.querySelector("#closeSidebar"),
  sidebar: document.querySelector("#sidebar"),
  messages: document.querySelector("#messages"),
  composer: document.querySelector("#composer"),
  promptInput: document.querySelector("#promptInput"),
  sendButton: document.querySelector("#sendButton"),
  chatPane: document.querySelector(".chat-pane"),
  setupBand: document.querySelector("#setupBand"),
  settingsToggle: null,
  imageInput: null,
  imageTray: null,
  cwdInput: document.querySelector("#cwdInput"),
  projectSelect: document.querySelector("#projectSelect"),
  modelSelect: document.querySelector("#modelSelect"),
  reasoningSelect: document.querySelector("#reasoningSelect"),
  approvalSelect: document.querySelector("#approvalSelect"),
  sandboxSelect: document.querySelector("#sandboxSelect"),
  threadTitle: document.querySelector("#threadTitle"),
  threadMeta: document.querySelector("#threadMeta"),
  resumeStatus: document.querySelector("#resumeStatus"),
  fullscreenToggle: document.querySelector("#fullscreenToggle"),
  imageViewer: document.querySelector("#imageViewer"),
  imageViewerImg: document.querySelector("#imageViewerImg"),
  imageViewerBackdrop: document.querySelector("#imageViewerBackdrop"),
  imageViewerClose: document.querySelector("#imageViewerClose"),
  themeSelect: document.querySelector("#themeSelect"),
  trafficSummary: document.querySelector("#trafficSummary"),
  authPanel: document.querySelector("#authPanel"),
  authText: document.querySelector("#authText"),
  deviceLogin: document.querySelector("#deviceLogin"),
  approvalPanel: document.querySelector("#approvalPanel")
};

boot();

async function boot() {
  initI18n();
  window.addEventListener("languagechange", () => window.location.reload());
  const url = new URL(window.location.href);
  const urlToken = tokenFromUrl(url);
  if (urlToken) rememberAccessToken(urlToken);
  state.token = urlToken || storedAccessToken();
  state.urlThreadId = url.searchParams.get(THREAD_URL_PARAM) || "";

  const infoUrl = state.token ? `/api/info?token=${encodeURIComponent(state.token)}` : "/api/info";
  const info = await fetch(infoUrl).then((res) => res.json()).catch(() => null);
  if (info?.defaultCwd) {
    els.cwdInput.value = info.defaultCwd;
  }

  setupTheme();
  bindUi();

  if (!state.token) {
    setConnection("connection.missingToken");
    renderEmpty(t("connection.tokenRequiredTitle"), t("connection.tokenRequiredDescription"));
    return;
  }

  connect();
}

function tokenFromHash(hash) {
  const value = String(hash || "");
  const match = /[#&]token=([^&]+)/.exec(value);
  return match ? decodeURIComponent(match[1]) : "";
}

function tokenFromUrl(url) {
  return url.searchParams.get("token") || tokenFromHash(url.hash);
}

function storedAccessToken() {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function rememberAccessToken(token) {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Some private browsing modes can disable localStorage.
  }
}

function connect() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(state.token)}`);
  state.ws = ws;
  let opened = false;
  const startedAt = performance.now();
  console.info("[codex-mobile:ws]", {
    event: "connecting",
    url: `${protocol}//${window.location.host}/ws?token=[redacted]`,
    page: window.location.href
  });
  setConnection("connection.connecting");

  ws.addEventListener("open", () => {
    opened = true;
    state.connected = true;
    console.info("[codex-mobile:ws]", {
      event: "open",
      elapsedMs: Math.round(performance.now() - startedAt)
    });
    setConnection("connection.connected");
    initialLoad();
  });

  ws.addEventListener("message", (event) => {
    const raw = typeof event.data === "string" ? event.data : "";
    try {
      handleMessage(JSON.parse(event.data), raw ? byteLengthText(raw) : 0);
    } catch (error) {
      addSystemMessage(error.message || t("connection.parseError"));
    }
  });
  ws.addEventListener("close", () => {
    state.connected = false;
    console.warn("[codex-mobile:ws]", {
      event: "close",
      opened,
      pendingRequests: state.pending.size,
      elapsedMs: Math.round(performance.now() - startedAt),
      online: navigator.onLine
    });
    rejectPendingRequests(new Error(t("connection.disconnected")));
    if (!opened) {
      state.token = null;
      setConnection("connection.invalidToken");
      renderEmpty(t("connection.invalidToken"), t("connection.invalidTokenDescription"));
      return;
    }
    setConnection("connection.reconnecting");
    setTimeout(connect, 3000);
  });
  ws.addEventListener("error", () => {
    console.warn("[codex-mobile:ws]", {
      event: "error",
      opened,
      readyState: ws.readyState,
      online: navigator.onLine
    });
    setConnection("connection.error");
  });
}

async function initialLoad() {
  const results = await Promise.allSettled([loadModels(), loadConfig(), loadAccount(), loadThreads()]);
  const threadsLoaded = results[3]?.status === "fulfilled";
  for (const result of results) {
    if (result.status === "rejected") addSystemMessage(result.reason?.message || t("error.initialize"));
  }
  applyConfigDefaults();
  if (threadsLoaded) {
    try {
      if (!(await restoreUrlThread())) {
        await restoreLastThread();
      }
    } catch (error) {
      addSystemMessage(error.message || t("error.restoreThread"));
    }
  }
}

function bindUi() {
  setupImageComposer();
  setupMobileViewport();
  setupBackButtonGuard();
  setupUnloadGuard();
  updateFullscreenToggle();
  els.newThread.addEventListener("click", createThread);
  els.refreshThreads.addEventListener("click", refreshAll);
  els.resumeStatus?.addEventListener("click", async () => {
    try {
      await resumeCurrentThread();
    } catch {
      // resumeCurrentThread already reports the visible error.
    }
  });
  els.searchThreads.addEventListener("input", renderThreads);
  els.openSidebar.addEventListener("click", () => els.sidebar.classList.add("open"));
  els.closeSidebar.addEventListener("click", () => els.sidebar.classList.remove("open"));
  els.deviceLogin.addEventListener("click", startDeviceLogin);
  els.themeSelect.addEventListener("change", () => setThemePreference(els.themeSelect.value));
  els.fullscreenToggle?.addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", updateFullscreenToggle);
  document.addEventListener("webkitfullscreenchange", updateFullscreenToggle);
  els.projectSelect.addEventListener("change", () => {
    if (state.currentThread?.draft) {
      state.currentThread.cwd = els.projectSelect.value;
      updateThreadHeader();
      renderEmpty(
        t("thread.new"),
        state.currentThread.cwd
          ? t("empty.newThreadProject", { project: projectFromCwd(state.currentThread.cwd).name })
          : t("empty.noProject")
      );
    }
  });
  els.modelSelect.addEventListener("change", () => {
    updateReasoningOptions("", { useModelDefault: true });
  });
  els.messages.addEventListener("scroll", () => {
    if (els.messages.scrollTop < 80) {
      loadOlderTurns();
    }
  });

  els.threadTitle.addEventListener("focus", () => {
    threadTitleBeforeEdit = els.threadTitle.value;
    stopThreadTitleMarquee(true);
  });
  els.threadTitle.addEventListener("keydown", async (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      await commitThreadTitle();
      els.threadTitle.blur();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelThreadTitleEdit();
      els.threadTitle.blur();
    }
  });
  els.threadTitle.addEventListener("blur", async () => {
    await commitThreadTitle();
    scrollThreadTitleToEnd();
  });
  window.addEventListener("resize", scrollThreadTitleToEnd);

  els.composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = els.promptInput.value.trim();
    if (!text && !state.pendingImages.length) return;
    try {
      await sendTurn(text);
    } catch (error) {
      addSystemMessage(error.message || t("error.send"));
    }
  });

  els.promptInput.addEventListener("input", () => {
    resizePromptInput();
  });
  els.promptInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submitComposer();
  });
  els.promptInput.addEventListener("paste", async (event) => {
    const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    await addImages(files);
  });
  els.composer.addEventListener("dragover", (event) => {
    event.preventDefault();
    els.composer.classList.add("dragging");
  });
  els.composer.addEventListener("dragleave", () => {
    els.composer.classList.remove("dragging");
  });
  els.composer.addEventListener("drop", async (event) => {
    event.preventDefault();
    els.composer.classList.remove("dragging");
    await addImages([...(event.dataTransfer?.files || [])]);
  });
  els.imageViewerBackdrop?.addEventListener("click", closeImageViewer);
  els.imageViewerClose?.addEventListener("click", closeImageViewer);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeImageViewer();
  });
}

async function toggleFullscreen() {
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
  try {
    if (fullscreenElement) {
      await exitFullscreen();
    } else {
      const target = document.documentElement;
      if (target.requestFullscreen) {
        try {
          await target.requestFullscreen({ navigationUI: "hide" });
        } catch (error) {
          if (error instanceof TypeError) await target.requestFullscreen();
          else throw error;
        }
      } else if (target.webkitRequestFullscreen) {
        await target.webkitRequestFullscreen();
      }
    }
  } catch (error) {
    addSystemMessage(error.message || t("fullscreen.error"));
  } finally {
    updateFullscreenToggle();
  }
}

function updateFullscreenToggle() {
  if (!els.fullscreenToggle) return;
  const canFullscreen = Boolean(
    document.fullscreenEnabled
    || document.webkitFullscreenEnabled
    || document.documentElement.requestFullscreen
    || document.documentElement.webkitRequestFullscreen
  );
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
  document.documentElement.classList.toggle("fullscreen-active", Boolean(fullscreenElement));
  els.fullscreenToggle.disabled = !canFullscreen;
  els.fullscreenToggle.classList.toggle("active", Boolean(fullscreenElement));
  els.fullscreenToggle.title = t(fullscreenElement ? "fullscreen.exit" : "fullscreen.enter");
  els.fullscreenToggle.setAttribute("aria-label", t(fullscreenElement ? "fullscreen.exit" : "fullscreen.enter"));
}

function setupMobileViewport() {
  let largestVisualHeight = window.visualViewport?.height || window.innerHeight;
  let largestInnerHeight = window.innerHeight;
  let lastViewportLog = "";
  let pendingBottomDistance = null;

  const captureBottomDistance = () => {
    if (!els.messages || pendingBottomDistance !== null) return;
    pendingBottomDistance = Math.max(
      0,
      els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight
    );
  };

  const restoreBottomDistance = () => {
    if (!els.messages || pendingBottomDistance === null) return;
    const distance = pendingBottomDistance;
    pendingBottomDistance = null;
    const maxScrollTop = Math.max(0, els.messages.scrollHeight - els.messages.clientHeight);
    els.messages.scrollTop = Math.max(0, maxScrollTop - distance);
  };

  const syncViewport = () => {
    const viewport = window.visualViewport;
    const visualHeight = viewport?.height || window.innerHeight;
    const visualOffsetTop = viewport?.offsetTop || 0;
    const visualBottom = visualOffsetTop + visualHeight;
    const promptFocused = document.activeElement === els.promptInput;
    if (!promptFocused) {
      largestVisualHeight = Math.max(largestVisualHeight, visualHeight);
      largestInnerHeight = Math.max(largestInnerHeight, window.innerHeight);
    }
    const layoutViewportResized = promptFocused && largestInnerHeight - window.innerHeight > 80;
    const viewportBottom = layoutViewportResized ? window.innerHeight : visualBottom;
    const inferredKeyboardInset = Math.max(0, window.innerHeight - viewportBottom);

    updateMobileChromeMetrics();
    document.documentElement.style.setProperty("--visual-viewport-height", `${viewportBottom}px`);
    document.documentElement.style.setProperty("--visual-viewport-offset-top", `${visualOffsetTop}px`);
    document.documentElement.style.setProperty("--keyboard-inset", `${inferredKeyboardInset}px`);

    const composerBottom = els.composer?.getBoundingClientRect().bottom || viewportBottom;
    const fixedBottomAtZero = composerBottom + inferredKeyboardInset;
    const keyboardInset = Math.max(0, Math.round(fixedBottomAtZero - viewportBottom));
    const keyboardOpen = promptFocused
      && (layoutViewportResized || largestVisualHeight - visualHeight > 80 || inferredKeyboardInset > 80);
    document.documentElement.style.setProperty("--keyboard-inset", `${keyboardInset}px`);
    document.documentElement.classList.toggle("keyboard-open", keyboardOpen);

    const viewportLog = [
      Math.round(window.innerHeight),
      Math.round(visualHeight),
      Math.round(visualOffsetTop),
      keyboardInset,
      keyboardOpen
    ].join(":");
    if (viewportLog !== lastViewportLog) {
      lastViewportLog = viewportLog;
      console.debug("[codex-mobile:viewport]", {
        innerHeight: Math.round(window.innerHeight),
        visualHeight: Math.round(visualHeight),
        visualOffsetTop: Math.round(visualOffsetTop),
        visualBottom: Math.round(visualBottom),
        viewportBottom: Math.round(viewportBottom),
        layoutViewportResized,
        inferredKeyboardInset: Math.round(inferredKeyboardInset),
        keyboardInset,
        keyboardOpen
      });
    }
  };

  let frame = 0;
  const scheduleSync = () => {
    captureBottomDistance();
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      syncViewport();
      restoreBottomDistance();
    });
  };

  syncViewport();
  const resizeObserver = window.ResizeObserver
    ? new ResizeObserver(scheduleSync)
    : null;
  resizeObserver?.observe(els.composer);
  resizeObserver?.observe(els.chatPane.querySelector(".topbar"));
  window.addEventListener("resize", scheduleSync);
  window.addEventListener("orientationchange", scheduleSync);
  window.visualViewport?.addEventListener("resize", scheduleSync);
  window.visualViewport?.addEventListener("scroll", scheduleSync);
  els.promptInput.addEventListener("focus", () => {
    document.documentElement.classList.add("input-focused");
    scheduleSync();
    window.setTimeout(scheduleSync, 120);
    window.setTimeout(scheduleSync, 360);
  });
  els.promptInput.addEventListener("blur", () => {
    window.setTimeout(() => {
      document.documentElement.classList.remove("input-focused");
      scheduleSync();
    }, 120);
    window.setTimeout(scheduleSync, 360);
  });
}

function updateMobileChromeMetrics() {
  const topbarHeight = Math.ceil(els.chatPane?.querySelector(".topbar")?.getBoundingClientRect().height || 78);
  const composerHeight = Math.ceil(els.composer?.getBoundingClientRect().height || 70);
  const target = els.chatPane || document.documentElement;
  target.style.setProperty("--mobile-topbar-height", `${topbarHeight}px`);
  target.style.setProperty("--mobile-composer-height", `${composerHeight}px`);
}

function setupTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY) || "system";
  els.themeSelect.value = ["system", "light", "dark"].includes(saved) ? saved : "system";
  applyThemePreference(els.themeSelect.value);
}

function setThemePreference(value) {
  const next = ["system", "light", "dark"].includes(value) ? value : "system";
  localStorage.setItem(THEME_STORAGE_KEY, next);
  applyThemePreference(next);
}

function applyThemePreference(value) {
  if (value === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.dataset.theme = value;
  }
}

function setupBackButtonGuard() {
  if (!window.history?.pushState || window.__codexMobileBackGuard) return;
  window.__codexMobileBackGuard = true;
  setupBackSentinel();
  backGuardBaseUrl = cleanBackGuardUrl(window.location.href);
  window.history.replaceState({ ...(window.history.state || {}), codexMobilePage: true }, "", backGuardBaseUrl);
  armBackButtonGuard();
  window.addEventListener("popstate", handleBackNavigation);
  window.addEventListener("hashchange", handleBackNavigation);
  window.addEventListener("pointerdown", armBackButtonGuardFromUserGesture, { capture: true, passive: true });
  window.addEventListener("touchstart", armBackButtonGuardFromUserGesture, { capture: true, passive: true });
  window.addEventListener("keydown", armBackButtonGuardFromUserGesture, { capture: true });
}

function setupUnloadGuard() {
  window.addEventListener("beforeunload", (event) => {
    if (!shouldGuardUnload()) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

function shouldGuardUnload() {
  if (!state.token || !isLikelyMobileViewport()) return false;
  return Boolean(state.currentThread?.id || els.promptInput?.value || state.pendingImages.length);
}

function isLikelyMobileViewport() {
  return window.matchMedia?.("(max-width: 900px)").matches || navigator.maxTouchPoints > 1;
}

function setupBackSentinel() {
  if (!HTMLElement.prototype.showPopover || backSentinels.length) return;
  backSentinels = Array.from({ length: BACK_SENTINEL_COUNT }, () => {
    const sentinel = document.createElement("div");
    sentinel.className = "back-sentinel";
    sentinel.popover = "manual";
    sentinel.setAttribute("aria-hidden", "true");
    sentinel.addEventListener("beforetoggle", (event) => {
      if (event.newState !== "closed" || backSentinelReopening) return;
      if (event.cancelable) event.preventDefault();
      handleBackButton();
      window.setTimeout(openBackSentinels, 0);
    });
    sentinel.addEventListener("toggle", (event) => {
      if (event.newState !== "closed" || backSentinelReopening) return;
      handleBackButton();
      window.setTimeout(openBackSentinels, 0);
    });
    document.body.append(sentinel);
    return sentinel;
  });
  openBackSentinels();
}

function openBackSentinels() {
  if (!backSentinels.length) return;
  try {
    backSentinelReopening = true;
    for (const sentinel of backSentinels) {
      if (!sentinel.matches(":popover-open")) sentinel.showPopover();
    }
  } catch {
    // Older browsers may expose partial Popover API support.
  } finally {
    backSentinelReopening = false;
  }
}

function handleBackNavigation() {
  if (backGuardHandling) return;
  backGuardHandling = true;
  handleBackButton();
  window.setTimeout(() => {
    armBackButtonGuard();
    backGuardHandling = false;
  }, 0);
}

function armBackButtonGuardFromUserGesture() {
  const now = Date.now();
  if (now - backGuardArmedAt < 1200) return;
  armBackButtonGuard();
}

function armBackButtonGuard() {
  if (!backGuardBaseUrl) backGuardBaseUrl = cleanBackGuardUrl(window.location.href);
  backGuardArmedAt = Date.now();
  pushBackGuardState();
  pushBackGuardState();
}

function cleanBackGuardUrl(url) {
  const next = new URL(url);
  if (next.hash.startsWith(`#${BACK_GUARD_HASH_PREFIX}`)) {
    next.hash = "";
  }
  return next.toString();
}

function pushBackGuardState() {
  const url = new URL(backGuardBaseUrl || window.location.href);
  backGuardSerial += 1;
  url.hash = `${BACK_GUARD_HASH_PREFIX}${backGuardSerial}`;
  window.history.pushState({ codexMobileGuard: true, serial: backGuardSerial }, "", url.toString());
}

function handleBackButton() {
  if (closeImageViewer()) return;
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    exitFullscreen();
    return;
  }
  if (els.sidebar?.classList.contains("open")) {
    els.sidebar.classList.remove("open");
    return;
  }
  if (els.setupBand?.classList.contains("open")) {
    setSetupBandOpen(false);
    return;
  }
  if (document.activeElement === els.promptInput) {
    els.promptInput.blur();
  }
}

async function exitFullscreen() {
  try {
    if (document.exitFullscreen) await document.exitFullscreen();
    else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
  } catch (error) {
    addSystemMessage(error.message || t("fullscreen.exitError"));
  } finally {
    updateFullscreenToggle();
  }
}

function setSetupBandOpen(open) {
  els.setupBand?.classList.toggle("open", open);
  els.settingsToggle?.classList.toggle("active", open);
  els.settingsToggle?.setAttribute("aria-expanded", String(open));
  els.settingsToggle?.setAttribute("aria-label", t(open ? "settings.collapse" : "settings.expand"));
}

async function refreshAll() {
  const currentThread = state.currentThread;
  const currentId = currentThread?.id;
  state.lastLoadStats = null;
  state.threadLoadStats = null;
  updateTrafficSummary();
  if (currentId) {
    const loadSeq = ++state.threadLoadSeq;
    state.loadingThreadId = currentId;
    state.currentThread = currentThread;
    state.messages = [];
    resetTurnPaging();
    els.sendButton.disabled = true;
    updateThreadHeader();
    renderThreadLoading(currentThread, createThreadLoadStats(currentId, currentThread, loadSeq));
    renderThreads();
  }
  await Promise.all([loadConfig(), loadThreads()]);
  applyConfigDefaults();
  if (currentId) {
    const thread = state.threads.find((entry) => entry.id === currentId) || currentId;
    await openThread(thread);
  }
}

function setupImageComposer() {
  const settingsButton = document.createElement("button");
  settingsButton.className = "settings-toggle mobile-only";
  settingsButton.type = "button";
  settingsButton.innerHTML = settingsIcon();
  settingsButton.title = t("settings.panel");
  settingsButton.setAttribute("aria-label", t("settings.expand"));
  settingsButton.setAttribute("aria-expanded", "false");

  const attachButton = document.createElement("label");
  attachButton.className = "attach-button";
  attachButton.textContent = "+";
  attachButton.title = t("image.add");

  const imageInput = document.createElement("input");
  imageInput.id = "imageInput";
  imageInput.type = "file";
  imageInput.accept = "image/*";
  imageInput.multiple = true;
  imageInput.hidden = true;
  attachButton.htmlFor = imageInput.id;

  const tray = document.createElement("div");
  tray.className = "image-tray hidden";

  els.composer.prepend(imageInput);
  els.composer.prepend(attachButton);
  els.composer.prepend(settingsButton);
  els.composer.insertBefore(tray, els.promptInput);
  els.settingsToggle = settingsButton;
  els.imageInput = imageInput;
  els.imageTray = tray;

  settingsButton.addEventListener("click", () => {
    setSetupBandOpen(!els.setupBand.classList.contains("open"));
  });

  imageInput.addEventListener("change", async () => {
    const files = [...imageInput.files];
    await addImages(files);
    imageInput.value = "";
  });
}

async function addImages(files) {
  const imageFiles = files.filter(isImageFile);
  if (!imageFiles.length && files.length) {
    addSystemMessage(t("image.noneFound"));
  }
  for (const file of imageFiles) {
    const previewUrl = URL.createObjectURL(file);
    const item = {
      id: createClientId(),
      name: file.name,
      previewUrl,
      status: "preparing",
      originalSize: file.size,
      uploadSize: file.size,
      path: null
    };
    state.pendingImages.push(item);
    renderImageTray();

    try {
      const upload = await prepareImageForUpload(file);
      item.uploadSize = upload.size;
      item.compressed = upload.compressed;
      item.detail = imageUploadDetail(file, upload);
      item.status = "uploading";
      renderImageTray();

      const result = await uploadImage(upload, (progress) => {
        item.progress = progress;
        renderImageTray();
      });
      item.path = result.path;
      item.status = "ready";
    } catch (error) {
      item.status = "failed";
      item.error = error.message;
    }
    renderImageTray();
  }
}

function uploadImage(upload, onProgress = null) {
  const blob = upload.blob || upload;
  const uploadName = upload.name || blob.name || "image";
  const contentType = upload.type || imageMimeForFile(blob) || "application/octet-stream";
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/upload-image?token=${encodeURIComponent(state.token)}`);
    xhr.setRequestHeader("content-type", contentType);
    xhr.setRequestHeader("x-file-name", encodeURIComponent(uploadName));
    xhr.timeout = 90000;
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || !onProgress) return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener("load", () => {
      const result = parseJson(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(result);
      } else {
        reject(new Error(result?.error || `Image upload failed (${xhr.status})`));
      }
    });
    xhr.addEventListener("error", () => reject(new Error(t("image.networkError"))));
    xhr.addEventListener("timeout", () => reject(new Error(t("image.timeout"))));
    xhr.send(blob);
  });
}

async function prepareImageForUpload(file) {
  const original = originalImageUpload(file);
  if (!canCompressImage(file)) return original;

  try {
    const image = await withTimeout(loadImageElement(file), 10000, "Image decode timed out");
    const scale = Math.min(
      1,
      IMAGE_UPLOAD_MAX_EDGE / Math.max(image.naturalWidth || 1, image.naturalHeight || 1),
      Math.sqrt(IMAGE_UPLOAD_MAX_PIXELS / Math.max(1, (image.naturalWidth || 1) * (image.naturalHeight || 1)))
    );

    if (scale >= 1 && file.size <= IMAGE_UPLOAD_TARGET_BYTES) {
      return original;
    }

    const width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
    const height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));
    const blob = await withTimeout(drawImageToJpegBlob(image, width, height), 12000, "Image compression timed out");
    if (!blob || (blob.size >= file.size && scale >= 1)) return original;

    return {
      blob,
      name: fileNameWithExtension(file.name, "jpg"),
      type: blob.type || "image/jpeg",
      size: blob.size,
      originalSize: file.size,
      compressed: blob.size < file.size || scale < 1
    };
  } catch {
    return original;
  }
}

function originalImageUpload(file) {
  return {
    blob: file,
    name: file.name || "image",
    type: imageMimeForFile(file) || file.type || "application/octet-stream",
    size: file.size || 0,
    originalSize: file.size || 0,
    compressed: false
  };
}

function canCompressImage(file) {
  const mime = imageMimeForFile(file);
  return mime.startsWith("image/") && mime !== "image/gif" && mime !== "image/svg+xml";
}

function loadImageElement(file) {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(t("image.decodeFailed")));
    };
    img.src = url;
  });
}

function withTimeout(promise, ms, message) {
  let timer = 0;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
}

async function drawImageToJpegBlob(image, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return null;

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  let best = null;
  for (const quality of IMAGE_UPLOAD_JPEG_QUALITIES) {
    const blob = await canvasToBlob(canvas, "image/jpeg", quality);
    if (!blob) continue;
    best = blob;
    if (blob.size <= IMAGE_UPLOAD_TARGET_BYTES) break;
  }
  return best;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    if (!canvas.toBlob) {
      resolve(null);
      return;
    }
    canvas.toBlob(resolve, type, quality);
  });
}

function fileNameWithExtension(name, extension) {
  const fallback = "image";
  const base = String(name || fallback).replace(/\.[^./\\]+$/, "") || fallback;
  return `${base}.${extension}`;
}

function imageUploadDetail(original, upload) {
  if (!upload.compressed) return `${original.name || t("image.defaultName")} · ${formatBytes(upload.size)}`;
  return `${original.name || t("image.defaultName")} · ${formatBytes(original.size)} -> ${formatBytes(upload.size)}`;
}

function parseJson(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

function createClientId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  const random = window.crypto?.getRandomValues
    ? Array.from(window.crypto.getRandomValues(new Uint32Array(2)), (value) => value.toString(36)).join("")
    : Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${random}`;
}

function isImageFile(file) {
  return Boolean(imageMimeForFile(file));
}

function imageMimeForFile(file) {
  const type = String(file?.type || "").toLowerCase();
  if (type.startsWith("image/")) return type;
  const name = String(file?.name || "").toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  return "";
}

function renderImageTray() {
  if (!els.imageTray) return;
  els.imageTray.innerHTML = "";
  const hasImages = Boolean(state.pendingImages.length);
  els.imageTray.classList.toggle("hidden", !hasImages);
  els.composer?.classList.toggle("has-image-tray", hasImages);

  for (const image of state.pendingImages) {
    const item = document.createElement("div");
    item.className = `image-chip ${image.status}`;
    const label = imageTrayLabel(image);
    if (image.detail) item.title = image.detail;
    item.innerHTML = `
      <img src="${image.previewUrl}" alt="">
      <span>${escapeHtml(label)}</span>
      <button type="button" aria-label="${escapeHtml(t("image.remove"))}">×</button>
    `;
    item.querySelector("button").addEventListener("click", () => {
      URL.revokeObjectURL(image.previewUrl);
      state.pendingImages = state.pendingImages.filter((entry) => entry.id !== image.id);
      renderImageTray();
    });
    els.imageTray.append(item);
  }
  updateMobileChromeMetrics();
}

function imageTrayLabel(image) {
  if (image.status === "preparing") return t("image.preparing");
  if (image.status === "uploading") return t("image.uploading", { progress: image.progress ? ` ${image.progress}%` : "" });
  if (image.status === "failed") return image.error || t("image.failed");
  if (image.compressed) return `${formatBytes(image.originalSize)} -> ${formatBytes(image.uploadSize)}`;
  return image.name;
}

function revokeImagePreviews(images) {
  for (const image of images || []) {
    if (image.previewUrl) URL.revokeObjectURL(image.previewUrl);
  }
}

async function loadModels() {
  const result = await rpc("model/list", { limit: 50, includeHidden: false });
  state.models = result?.data || [];
  els.modelSelect.innerHTML = "";
  for (const model of state.models) {
    const option = document.createElement("option");
    option.value = model.model || model.id;
    option.textContent = model.displayName || model.model || model.id;
    if (model.isDefault) option.selected = true;
    els.modelSelect.append(option);
  }
  if (!state.models.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = t("model.default");
    els.modelSelect.append(option);
  }
  updateReasoningOptions("", { useModelDefault: true });
}

async function loadConfig() {
  const result = await rpc("config/read", {});
  state.config = result?.config || null;
}

function applyConfigDefaults() {
  const config = state.config || {};
  const effort = configReasoningEffort(config);
  if (config.model) {
    setModelValue(config.model, effort);
  } else {
    updateReasoningOptions(effort, { useModelDefault: true });
  }
}

async function loadAccount() {
  const result = await rpc("account/read", { refreshToken: false });
  state.account = result;
  if (result?.requiresOpenaiAuth && !result?.account) {
    els.authPanel.classList.remove("hidden");
    els.authText.textContent = t("auth.notLoggedIn");
  } else {
    els.authPanel.classList.add("hidden");
  }
}

async function startDeviceLogin() {
  const result = await rpc("account/login/start", { type: "chatgptDeviceCode" });
  if (result?.verificationUrl && result?.userCode) {
    els.authPanel.classList.remove("hidden");
    const url = escapeHtml(result.verificationUrl);
    const code = escapeHtml(result.userCode);
    els.authText.innerHTML = t("auth.instructions", {
      url: `<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`,
      code: `<strong>${code}</strong>`
    });
  }
}

async function loadThreads() {
  const result = await rpc("thread/list", {
    limit: 100,
    archived: false,
    sortKey: "recency_at",
    sortDirection: "desc"
  });
  state.threads = mergeCurrentThreadIntoList(result?.data || []);
  renderProjectOptions();
  renderThreads();
}

function mergeCurrentThreadIntoList(threads) {
  const current = state.currentThread;
  if (!current?.id) return threads;
  const index = threads.findIndex((thread) => thread.id === current.id);
  if (index < 0) return [current, ...threads];
  const merged = [...threads];
  merged[index] = { ...current, ...merged[index] };
  return merged;
}

function renderProjectOptions() {
  const previous = els.projectSelect.value;
  const groups = groupThreadsByProject(state.threads)
    .filter(isProjectGroup)
    .sort((a, b) => a.name.localeCompare(b.name, currentLocale()));

  els.projectSelect.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = t("project.none");
  els.projectSelect.append(none);

  for (const group of groups) {
    const option = document.createElement("option");
    option.value = group.cwd;
    option.textContent = group.name;
    els.projectSelect.append(option);
  }

  if (previous && [...els.projectSelect.options].some((option) => option.value === previous)) {
    els.projectSelect.value = previous;
  } else if (state.currentThread?.cwd) {
    setProjectSelection(state.currentThread.cwd);
  }
}

function setProjectSelection(cwd) {
  const value = cwd || "";
  if (value && !isProjectGroup(projectFromCwd(value))) {
    els.projectSelect.value = "";
    return;
  }
  if (value && ![...els.projectSelect.options].some((option) => option.value === value)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = projectFromCwd(value).name;
    els.projectSelect.append(option);
  }
  els.projectSelect.value = value;
}

function renderThreads() {
  const term = els.searchThreads.value.trim().toLowerCase();
  els.threadList.innerHTML = "";
  const filtered = state.threads.filter((thread) => threadMatchesSearch(thread, term));

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "thread-item";
    empty.innerHTML = `<span class="thread-name">${escapeHtml(t("thread.noThreads"))}</span><span class="thread-time">${escapeHtml(t("thread.new"))}</span>`;
    els.threadList.append(empty);
    return;
  }

  const { projects, directThreads } = splitThreadGroups(groupThreadsByProject(filtered));

  if (projects.length) {
    els.threadList.append(renderSectionTitle(t("thread.projects")));
    for (const group of projects) {
      els.threadList.append(renderProjectGroup(group));
    }
  }

  if (directThreads.length) {
    els.threadList.append(renderSectionTitle(t("thread.conversations")));
    const section = document.createElement("section");
    section.className = "direct-thread-group";
    for (const thread of directThreads) {
      section.append(renderThreadButton(thread));
    }
    els.threadList.append(section);
  }
}

function threadMatchesSearch(thread, term) {
  if (!term) return true;
  const project = projectFromCwd(thread.cwd);
  const text = `${thread.name || ""} ${thread.preview || ""} ${thread.cwd || ""} ${project.name}`.toLowerCase();
  return text.includes(term);
}

function renderSectionTitle(title) {
  const node = document.createElement("div");
  node.className = "sidebar-section-title";
  node.textContent = title;
  return node;
}

function renderProjectGroup(group) {
  const section = document.createElement("section");
  const isExpanded = state.expandedProjects.has(group.key);
  const visibleThreads = isExpanded ? group.threads : group.threads.slice(0, 6);
  section.className = "project-group";
  section.innerHTML = `
    <button class="project-heading" type="button" title="${escapeHtml(group.cwd)}">
      ${folderIcon()}
      <span class="project-name">${escapeHtml(group.name)}</span>
      <span class="project-badge">${group.threads.length}</span>
    </button>
  `;

  for (const thread of visibleThreads) {
    section.append(renderThreadButton(thread));
  }

  if (group.threads.length > visibleThreads.length) {
    const expand = document.createElement("button");
    expand.className = "expand-project";
    expand.type = "button";
    expand.textContent = t("thread.showMore");
    expand.addEventListener("click", () => {
      state.expandedProjects.add(group.key);
      renderThreads();
    });
    section.append(expand);
  } else if (group.threads.length > 6 && isExpanded) {
    const collapse = document.createElement("button");
    collapse.className = "expand-project";
    collapse.type = "button";
    collapse.textContent = t("thread.collapse");
    collapse.addEventListener("click", () => {
      state.expandedProjects.delete(group.key);
      renderThreads();
    });
    section.append(collapse);
  }

  return section;
}

function renderThreadButton(thread) {
  const link = document.createElement("a");
  const isActive = state.currentThread?.id === thread.id;
  const isLoading = state.loadingThreadId === thread.id;
  link.className = `thread-item ${isActive ? "active" : ""} ${isLoading ? "loading" : ""}`;
  link.href = threadUrl(thread.id);
  link.title = t("thread.openNewTab");
  if (isActive) link.setAttribute("aria-current", "page");
  link.innerHTML = `
    <span class="thread-name">${escapeHtml(thread.name || thread.preview || t("thread.untitled"))}</span>
    <span class="thread-time">${formatRelativeTime(thread.updatedAt || thread.createdAt)}</span>
  `;
  link.addEventListener("click", (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openThread(thread);
  });
  return link;
}

function threadUrl(threadId) {
  const url = new URL(cleanBackGuardUrl(window.location.href));
  url.hash = "";
  url.searchParams.set(THREAD_URL_PARAM, threadId);
  if (state.token) url.searchParams.set("token", state.token);
  return url.toString();
}

function splitThreadGroups(groups) {
  const projects = [];
  const directThreads = [];
  for (const group of groups) {
    if (isProjectGroup(group)) projects.push(group);
    else directThreads.push(...group.threads);
  }
  directThreads.sort((a, b) => threadTimestamp(b) - threadTimestamp(a));
  return { projects, directThreads };
}

function groupThreadsByProject(threads) {
  const groups = new Map();
  for (const thread of threads) {
    const project = projectFromCwd(thread.cwd);
    if (!groups.has(project.key)) {
      groups.set(project.key, { ...project, threads: [] });
    }
    groups.get(project.key).threads.push(thread);
  }

  for (const group of groups.values()) {
    group.threads.sort((a, b) => threadTimestamp(b) - threadTimestamp(a));
  }

  return Array.from(groups.values()).sort((a, b) => {
    const aCurrent = samePath(a.cwd, els.cwdInput.value.trim()) ? 1 : 0;
    const bCurrent = samePath(b.cwd, els.cwdInput.value.trim()) ? 1 : 0;
    if (aCurrent !== bCurrent) return bCurrent - aCurrent;
    const aUpdated = Math.max(...a.threads.map(threadTimestamp));
    const bUpdated = Math.max(...b.threads.map(threadTimestamp));
    return bUpdated - aUpdated;
  });
}

function threadTimestamp(thread) {
  return thread?.recencyAt || thread?.updatedAt || thread?.createdAt || 0;
}

function latestTurnTimestamp(turns) {
  return Math.max(0, ...(turns || []).map(turnTimestamp));
}

function turnTimestamp(turn) {
  return normalizeUnixSeconds(turn?.completedAt || turn?.updatedAt || turn?.startedAt || turn?.createdAt || turn?.timestamp);
}

function itemTimestamp(item) {
  return normalizeUnixSeconds(item?.completedAt || item?.updatedAt || item?.createdAt || item?.timestamp);
}

function currentUnixSeconds() {
  return Math.floor(Date.now() / 1000);
}

function normalizeUnixSeconds(value) {
  if (!value) return 0;
  if (typeof value === "number") return value > 100000000000 ? Math.floor(value / 1000) : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}

function createThread() {
  const cwd = els.projectSelect.value;
  updateThreadUrl("");
  state.currentThread = {
    draft: true,
    name: t("thread.new"),
    preview: t("thread.new"),
    cwd,
    status: "draft"
  };
  state.messages = [];
  state.lastMessageAt = null;
  state.lastLoadStats = null;
  state.threadLoadStats = null;
  resetTurnPaging();
  updateThreadHeader();
  updateProjectSelectState();
  updateTrafficSummary();
  renderEmpty(
    t("thread.new"),
    cwd ? t("empty.newThreadProject", { project: projectFromCwd(cwd).name }) : t("empty.noProject")
  );
  renderThreads();
  els.sidebar.classList.remove("open");
  els.promptInput.focus();
}

async function createThreadOnServer() {
  const params = threadSettings();
  const result = await rpc("thread/start", params);
  state.currentThread = result.thread;
  rememberLastThread(state.currentThread?.id);
  updateThreadUrl(state.currentThread?.id || "");
  state.lastMessageAt = threadTimestamp(state.currentThread) || null;
  setProjectSelection(state.currentThread?.cwd || "");
  applyThreadPermissionSettings(state.currentThread);
  state.lastLoadStats = null;
  resetTurnPaging();
  updateThreadHeader();
  updateProjectSelectState();
  updateTrafficSummary();
  await loadThreads();
  els.sidebar.classList.remove("open");
  return state.currentThread;
}

async function ensureThread() {
  if (!state.currentThread?.id) {
    await createThreadOnServer();
  }
}

async function openThread(threadOrId) {
  const threadId = typeof threadOrId === "string" ? threadOrId : threadOrId?.id;
  if (!threadId) return;
  rememberLastThread(threadId);
  updateThreadUrl(threadId);

  const loadSeq = ++state.threadLoadSeq;
  const previewThread = typeof threadOrId === "string"
    ? state.threads.find((thread) => thread.id === threadId)
    : threadOrId;

  state.loadingThreadId = threadId;
  state.threadLoadStats = createThreadLoadStats(threadId, previewThread, loadSeq);
  state.lastLoadStats = null;
  state.currentThread = previewThread || { id: threadId };
  state.lastMessageAt = threadTimestamp(state.currentThread) || null;
  setProjectSelection(state.currentThread.cwd || "");
  updateProjectSelectState();
  state.messages = [];
  resetTurnPaging();
  els.sendButton.disabled = true;
  updateThreadHeader();
  updateTrafficSummary();
  renderThreadLoading(state.currentThread, state.threadLoadStats);
  renderThreads();
  els.sidebar.classList.remove("open");

  try {
    updateThreadLoadPhase(state.threadLoadStats, t("load.readSettings"));
    const readResult = await rpc(
      "thread/read",
      { threadId },
      { traffic: state.threadLoadStats, label: t("load.readSettings") }
    );
    if (loadSeq !== state.threadLoadSeq) return;
    if (readResult?.thread) {
      state.currentThread = { ...state.currentThread, ...readResult.thread };
      setProjectSelection(state.currentThread.cwd || "");
      applyThreadPermissionSettings(state.currentThread);
      updateThreadHeader();
      updateProjectSelectState();
    }

    updateThreadLoadPhase(state.threadLoadStats, t("load.readLatest"));
    const page = await rpc(
      "thread/turns/list",
      {
        threadId,
        limit: TURN_PAGE_LIMIT,
        sortDirection: "desc",
        itemsView: TURN_ITEMS_VIEW
      },
      { traffic: state.threadLoadStats, label: t("load.readLatest") }
    );
    if (loadSeq !== state.threadLoadSeq) return;

    updateThreadLoadPhase(state.threadLoadStats, t("load.organize"));
    const flattenStartedAt = performance.now();
    const turns = page.data || [];
    rememberLoadedTurns(turns);
    state.turnCursor = page.nextCursor || null;
    state.hasOlderTurns = Boolean(page.nextCursor);
    state.messages = flattenTurns(newestFirstToDisplayOrder(turns));
    state.lastMessageAt = latestTurnTimestamp(turns) || threadTimestamp(state.currentThread) || null;
    state.threadLoadStats.messageCount = state.messages.length;
    state.threadLoadStats.itemCount = countTurnItems(turns);
    state.threadLoadStats.renderMs = performance.now() - flattenStartedAt;
    state.threadLoadStats.finishedAt = performance.now();
    state.threadLoadStats.phase = t("load.done");
    state.lastLoadStats = state.threadLoadStats;
    renderMessages();
  } catch (error) {
    if (loadSeq === state.threadLoadSeq) {
      renderEmpty(t("load.failedTitle"), error.message || t("load.retry"));
    }
  } finally {
    if (loadSeq === state.threadLoadSeq) {
      state.loadingThreadId = null;
      state.threadLoadStats = null;
      els.sendButton.disabled = false;
      updateTrafficSummary();
      renderThreads();
    }
  }
}

async function restoreLastThread() {
  if (state.currentThread?.id || state.currentThread?.draft) return;
  const threadId = localStorage.getItem(LAST_THREAD_STORAGE_KEY);
  if (!threadId) return;
  const thread = state.threads.find((entry) => entry.id === threadId);
  if (!thread) {
    localStorage.removeItem(LAST_THREAD_STORAGE_KEY);
    return;
  }
  await openThread(thread);
}

async function restoreUrlThread() {
  if (state.currentThread?.id || state.currentThread?.draft || !state.urlThreadId) return false;
  const thread = state.threads.find((entry) => entry.id === state.urlThreadId);
  await openThread(thread || state.urlThreadId);
  return true;
}

function rememberLastThread(threadId) {
  if (!threadId) return;
  localStorage.setItem(LAST_THREAD_STORAGE_KEY, threadId);
}

function updateThreadUrl(threadId) {
  if (!window.history?.replaceState) return;
  const url = new URL(cleanBackGuardUrl(window.location.href));
  url.searchParams.delete("token");
  if (threadId) {
    url.searchParams.set(THREAD_URL_PARAM, threadId);
    state.urlThreadId = threadId;
  } else {
    url.searchParams.delete(THREAD_URL_PARAM);
    state.urlThreadId = "";
  }
  const nextUrl = url.toString();
  backGuardBaseUrl = nextUrl;
  window.history.replaceState({ ...(window.history.state || {}), codexMobilePage: true }, "", nextUrl);
  if (window.__codexMobileBackGuard) window.setTimeout(armBackButtonGuard, 0);
}


async function resumeCurrentThread(options = {}) {
  const showError = options.showError !== false;
  const thread = state.currentThread;
  if (!thread?.id || !needsResume(thread) || state.resumingThreadId) return false;

  const threadId = thread.id;
  state.resumingThreadId = threadId;
  updateResumeStatus(thread);
  els.threadMeta.textContent = `${shortPath(thread.cwd)} · ${t("status.resuming")}`;

  try {
    const result = await rpc("thread/resume", { threadId, ...threadSettings() });
    if (state.currentThread?.id === threadId) {
      state.currentThread = result.thread || state.currentThread;
      applyThreadPermissionSettings(state.currentThread);
      updateThreadHeader();
    }
    renderThreads();
    return true;
  } catch (error) {
    if (showError) addSystemMessage(error.message || t("error.resume"));
    throw error;
  } finally {
    if (state.resumingThreadId === threadId) {
      state.resumingThreadId = null;
    }
    updateResumeStatus(state.currentThread);
  }
}

async function sendTurn(text) {
  const wasDraft = !state.currentThread?.id;
  const sendStartedAt = performance.now();
  await ensureThread();
  const threadId = state.currentThread.id;
  const turnDebugId = `${threadId}:${Date.now()}`;
  state.turnDiagnostics.set(threadId, {
    id: turnDebugId,
    threadId,
    startedAt: sendStartedAt,
    textChars: String(text || "").length,
    imageCount: state.pendingImages.length,
    firstDeltaAt: 0,
    turnStartedAt: 0,
    turnStartRpcDoneAt: 0
  });
  logTurnDebug("send-begin", threadId);
  const images = state.pendingImages.filter((image) => image.status === "ready" && image.path);
  if (state.pendingImages.some((image) => image.status === "preparing" || image.status === "uploading")) {
    addSystemMessage(t("image.pending"));
    logTurnDebug("blocked-images-uploading", threadId);
    return;
  }
  if (state.pendingImages.some((image) => image.status === "failed")) {
    addSystemMessage(t("image.uploadFailed"));
    logTurnDebug("blocked-images-failed", threadId);
    return;
  }

  els.promptInput.value = "";
  resizePromptInput();
  els.sendButton.disabled = true;
  state.pendingImages = [];
  renderImageTray();
  revokeImagePreviews(images);
  state.lastMessageAt = currentUnixSeconds();
  startReplyProgress(threadId);
  const automationHeartbeat = parseAutomationHeartbeat(text);
  addMessage({
    role: "user",
    kind: automationHeartbeat ? "automationHeartbeat" : undefined,
    text,
    automationHeartbeat,
    images: images.map((image) => ({ kind: "source", source: image.path })),
    pendingLocal: true
  });
  addPendingReplyMessage(threadId, true);
  try {
    if (needsResume(state.currentThread)) {
      await resumeCurrentThread({ showError: false });
    }

    await rpc("turn/start", {
      threadId,
      ...turnRuntimeSettings(),
      input: [
        ...(text ? [{ type: "text", text, text_elements: [] }] : []),
        ...images.map((image) => ({ type: "localImage", path: image.path }))
      ]
    });
    const diagnostics = state.turnDiagnostics.get(threadId);
    if (diagnostics) diagnostics.turnStartRpcDoneAt = performance.now();
    logTurnDebug("turn-start-rpc-done", threadId);
    if (wasDraft) {
      await loadThreads();
      renderThreads();
    }
  } finally {
    els.sendButton.disabled = false;
  }
}

async function loadOlderTurns() {
  if (!state.currentThread?.id || !state.turnCursor || state.loadingOlderTurns) return;

  state.loadingOlderTurns = true;
  const threadId = state.currentThread.id;
  renderMessages(false);

  const previousHeight = els.messages.scrollHeight;
  const previousTop = els.messages.scrollTop;
  const cursor = state.turnCursor;
  let rendered = false;

  try {
    const page = await rpc(
      "thread/turns/list",
      {
        threadId,
        cursor,
        limit: TURN_PAGE_LIMIT,
        sortDirection: "desc",
        itemsView: TURN_ITEMS_VIEW
      },
      { traffic: state.lastLoadStats, label: t("load.older") }
    );

    if (cursor !== state.turnCursor || threadId !== state.currentThread?.id) return;

    const turns = filterUnloadedTurns(page.data || []);
    rememberLoadedTurns(turns);
    state.turnCursor = page.nextCursor || null;
    state.hasOlderTurns = Boolean(page.nextCursor);
    state.messages = [...flattenTurns(newestFirstToDisplayOrder(turns)), ...state.messages];
    if (state.lastLoadStats) {
      state.lastLoadStats.messageCount = state.messages.length;
      state.lastLoadStats.itemCount += countTurnItems(turns);
      state.lastLoadStats.finishedAt = performance.now();
    }

    state.loadingOlderTurns = false;
    renderMessages(false);
    updateTrafficSummary();
    rendered = true;
    els.messages.scrollTop = els.messages.scrollHeight - previousHeight + previousTop;
  } catch (error) {
    state.loadingOlderTurns = false;
    renderMessages(false);
    updateTrafficSummary();
    rendered = true;
    addSystemMessage(error.message || t("load.olderError"));
  } finally {
    if (threadId === state.currentThread?.id) {
      state.loadingOlderTurns = false;
      if (!rendered) renderMessages(false);
    }
  }
}

function threadSettings() {
  const params = {
    approvalPolicy: els.approvalSelect.value,
    sandbox: els.sandboxSelect.value
  };
  const cwd = state.currentThread?.cwd || els.projectSelect.value || defaultDirectConversationCwd();
  params.cwd = cwd;
  if (els.modelSelect.value) params.model = els.modelSelect.value;
  params.effort = els.reasoningSelect.value || "";
  return params;
}

function turnRuntimeSettings() {
  const params = {};
  if (els.modelSelect.value) params.model = els.modelSelect.value;
  params.effort = els.reasoningSelect.value || "";
  return params;
}

function applyThreadPermissionSettings(thread) {
  const settings = thread?.permissionSettings;
  if (!settings) return;
  setSelectValueIfPresent(els.approvalSelect, settings.approvalPolicy);
  setSelectValueIfPresent(els.sandboxSelect, settings.sandbox);
  const effort = settings.reasoningEffort || settings.effort || "";
  if (settings.model) {
    setModelValue(settings.model, effort);
  } else {
    updateReasoningOptions(effort, { useModelDefault: true });
  }
}

function setSelectValueIfPresent(select, value) {
  if (!select || !value) return;
  if ([...select.options].some((option) => option.value === value)) {
    select.value = value;
  }
}

function setModelValue(value, preferredEffort = "") {
  if (!els.modelSelect || !value) return;
  if (![...els.modelSelect.options].some((option) => option.value === value)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    els.modelSelect.append(option);
  }
  els.modelSelect.value = value;
  updateReasoningOptions(preferredEffort, { useModelDefault: true });
}

function updateReasoningOptions(preferredValue = "", { useModelDefault = false } = {}) {
  if (!els.reasoningSelect) return;
  const model = state.models.find((entry) => (entry.model || entry.id) === els.modelSelect.value);
  const supported = model?.supportedReasoningEfforts?.length
    ? model.supportedReasoningEfforts
    : ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort }));
  const previousValue = useModelDefault ? "" : els.reasoningSelect.value;
  const requestedValue = preferredValue || previousValue;

  els.reasoningSelect.innerHTML = "";
  for (const entry of supported) {
    const value = entry.reasoningEffort || entry.effort || entry.id;
    if (!value) continue;
    const option = document.createElement("option");
    option.value = value;
    option.textContent = reasoningEffortLabel(value);
    if (entry.description) option.title = entry.description;
    els.reasoningSelect.append(option);
  }

  const available = [...els.reasoningSelect.options].map((option) => option.value);
  const modelDefault = model?.defaultReasoningEffort || "medium";
  els.reasoningSelect.value = available.includes(requestedValue)
    ? requestedValue
    : available.includes(modelDefault)
      ? modelDefault
      : available[0] || "";
}

function reasoningEffortLabel(value) {
  const key = `reasoning.${value}`;
  const label = t(key);
  return label === key ? value : label;
}

function configReasoningEffort(config) {
  return config?.model_reasoning_effort
    || config?.modelReasoningEffort
    || config?.reasoningEffort
    || config?.effort
    || "";
}

function flattenThread(thread) {
  return flattenTurns(thread?.turns || []);
}

function flattenTurns(turns) {
  const messages = [];
  for (const turn of turns || []) {
    for (const item of turn.items || []) {
      const message = messageFromItem(item);
      if (message) messages.push(message);
    }
  }
  return messages;
}

function countThreadItems(thread) {
  return countTurnItems(thread?.turns || []);
}

function countTurnItems(turns) {
  return (turns || []).reduce((total, turn) => total + (turn.items?.length || 0), 0);
}

function newestFirstToDisplayOrder(turns) {
  return [...(turns || [])].reverse();
}

function resetTurnPaging() {
  state.turnCursor = null;
  state.hasOlderTurns = false;
  state.loadingOlderTurns = false;
  state.loadedTurnIds = new Set();
}

function rememberLoadedTurns(turns) {
  for (const turn of turns || []) {
    if (turn?.id) state.loadedTurnIds.add(turn.id);
  }
}

function filterUnloadedTurns(turns) {
  return (turns || []).filter((turn) => !turn?.id || !state.loadedTurnIds.has(turn.id));
}

function needsResume(thread) {
  return formatStatus(thread?.status) === "notLoaded";
}

function messageFromItem(item) {
  if (item.type === "userMessage") {
    const content = item.content || [];
    const text = cleanUserText(content.map(inputToText).filter(Boolean).join("\n"));
    const automationHeartbeat = parseAutomationHeartbeat(text);
    return {
      role: "user",
      id: item.id,
      kind: automationHeartbeat ? "automationHeartbeat" : undefined,
      text,
      automationHeartbeat,
      images: content
        .filter((entry) => entry.type === "localImage" || entry.type === "image")
        .map(normalizeImageReference)
        .filter(Boolean)
    };
  }
  if (item.type === "agentMessage") {
    return { role: "assistant", id: item.id, text: item.text || "" };
  }
  if (item.type === "imageGeneration") {
    const image = normalizeImageReference(item);
    const state = imageGenerationState(item, image);
    return {
      role: "assistant",
      id: item.id,
      text: "",
      images: image ? [image] : [],
      imageGeneration: state
    };
  }
  if (item.type === "plan") {
    return { role: "system", id: item.id, text: item.text || "" };
  }
  if (item.type === "commandExecution") {
    const output = item.aggregatedOutput ? `\n\n${item.aggregatedOutput}` : "";
    return { role: "tool", id: item.id, text: `$ ${item.command}${output}` };
  }
  if (item.type === "fileChange") {
    const changes = item.changes || [];
    const paths = changes.map((change) => change.path).filter(Boolean);
    const detail = paths.length ? `\n${paths.join("\n")}` : "";
    return {
      role: "tool",
      id: item.id,
      text: t("tool.fileChange", { status: formatStatusLabel(item.status || "completed"), detail })
    };
  }
  if (item.type === "mcpToolCall") {
    const name = [item.server, item.tool].filter(Boolean).join("/");
    const output = toolResultText(item.result);
    return {
      role: "tool",
      id: item.id,
      text: t("tool.call", {
        name: name || "tool",
        status: formatStatusLabel(item.status || "completed"),
        output: output ? `\n\n${output}` : ""
      })
    };
  }
  if (item.type === "contextCompaction") {
    return { role: "tool", kind: "contextCompaction", id: item.id, text: t("tool.compacted") };
  }
  if (item.type === "reasoning") {
    const reasoningParts = cleanReasoningParts(item);
    const text = reasoningParts.join("\n\n");
    return text ? { role: "system", kind: "reasoning", id: item.id, text, reasoningParts } : null;
  }
  return null;
}

function cleanReasoningParts(item) {
  return [...(item?.summary || []), ...(item?.content || [])]
    .map((entry) => typeof entry === "string" ? entry : entry?.text || entry?.content || "")
    .map((text) => text
      .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim())
    .filter(Boolean);
}

function normalizeImageReference(entry) {
  if (entry.inlineImageId) {
    return {
      kind: "inline",
      id: entry.inlineImageId,
      bytes: entry.omittedBytes || 0,
      mimeType: entry.mimeType || "image/*"
    };
  }
  const source = entry.path || entry.savedPath || entry.url;
  return source ? { kind: "source", source } : null;
}

function imageGenerationState(item, image) {
  const rawStatus = String(item?.status || item?.state || "").toLowerCase();
  const rawError = item?.error?.message || item?.error || item?.failureReason || "";
  const failed = Boolean(
    rawError
    || rawStatus.includes("fail")
    || rawStatus.includes("error")
    || rawStatus.includes("cancel")
  );
  const complete = Boolean(
    image
    || rawStatus.includes("complete")
    || rawStatus.includes("done")
    || rawStatus === "succeeded"
  );
  return {
    pending: !complete && !failed,
    failed,
    status: rawStatus || (image ? "completed" : "running"),
    detail: String(rawError || "").trim()
  };
}

function toolResultText(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) => entry?.type === "text" ? entry.text : "")
    .filter(Boolean)
    .join("\n")
    .slice(0, 1200);
}

function cleanUserText(text) {
  let next = String(text || "").trim();
  next = next.replace(/# Files mentioned by the user:[\s\S]*?(?=\n## My request for Codex:|$)/g, "").trim();
  next = next.replace(/# Browser comments:[\s\S]*?(?=\n# In app browser:|\n## My request for Codex:|$)/g, "").trim();
  next = next.replace(/# In app browser:\s*(?:\n- .*)*\s*/g, "").trim();
  next = next.replace(/^## My request for Codex:\s*/m, "").trim();
  next = next
    .split(/\r?\n/)
    .filter((line) => {
      const value = line.trim();
      return value !== "In app browser:"
        && !value.startsWith("- The user has the in-app browser open.")
        && !value.startsWith("- Current URL:")
        && !value.startsWith("The user has the in-app browser open.")
        && !value.startsWith("Current URL:")
        && value !== "My request for Codex:";
    })
    .join("\n")
    .trim();
  return next;
}

function parseAutomationHeartbeat(text) {
  const source = String(text || "").trim();
  if (!/^<heartbeat[>\s]/i.test(source)) return null;

  const documentNode = new DOMParser().parseFromString(source, "application/xml");
  if (documentNode.querySelector("parsererror")) return null;
  const root = documentNode.documentElement;
  if (root?.localName?.toLowerCase() !== "heartbeat") return null;

  const automationId = root.querySelector("automation_id")?.textContent?.trim() || "";
  const currentTimeIso = root.querySelector("current_time_iso")?.textContent?.trim() || "";
  const instructions = root.querySelector("instructions")?.textContent?.trim() || "";
  if (!automationId && !currentTimeIso && !instructions) return null;
  return { automationId, currentTimeIso, instructions };
}

function inputToText(item) {
  if (item.type === "text") return item.text;
  if (item.type === "image" || item.type === "localImage") return "";
  if (item.type === "skill") return `$${item.name}`;
  if (item.type === "mention") return `$${item.name}`;
  return "";
}

function handleMessage(message, rawBytes = 0) {
  if (message.type === "hello") {
    if (!els.cwdInput.value) els.cwdInput.value = message.defaultCwd || "";
    renderApprovals(message.pendingServerRequests || []);
    return;
  }
  if (message.type === "rpc-result") {
    settleRequest(message.requestId, null, message.result, rawBytes || encodedJsonBytes(message));
    return;
  }
  if (message.type === "rpc-error") {
    settleRequest(
      message.requestId,
      new Error(message.error || t("error.request")),
      null,
      rawBytes || encodedJsonBytes(message)
    );
    return;
  }
  if (message.type === "codex-notification") {
    handleNotification(message.notification);
    return;
  }
  if (message.type === "server-request") {
    renderApprovals([message.request]);
    return;
  }
  if (message.type === "bridge-error") {
    addSystemMessage(message.error);
  }
}

function handleNotification(notification) {
  const { method, params } = notification || {};
  if (!method) return;

  if (method === "error") {
    if (params.threadId !== state.currentThread?.id) return;
    const shouldStickToBottom = isMessagesNearBottom();
    const message = retryErrorText(params.error);
    const willRetry = Boolean(params.willRetry);
    replaceOrAppendMessage({
      role: "tool",
      kind: willRetry ? "retrying" : "retryFailed",
      id: retryStatusId(params.turnId),
      text: t(willRetry ? "retry.retrying" : "retry.failed", { message })
    });
    if (willRetry) ensureReplyProgressIndicator(params.threadId, shouldStickToBottom);
    renderMessages(shouldStickToBottom);
    return;
  }

  if (method === "thread/started") {
    loadThreads();
    return;
  }

  if (method === "item/agentMessage/delta") {
    if (params.threadId !== state.currentThread?.id) return;
    markRetryRecovered(params.turnId);
    const diagnostics = state.turnDiagnostics.get(params.threadId);
    if (diagnostics && !diagnostics.firstDeltaAt) {
      diagnostics.firstDeltaAt = performance.now();
      logTurnDebug("first-delta", params.threadId, { itemId: params.itemId });
    }
    const shouldStickToBottom = isMessagesNearBottom();
    let message = state.messages.find((entry) => entry.id === params.itemId);
    if (!message) {
      message = takePendingReplyMessage(params.threadId, params.itemId)
        || { role: "assistant", id: params.itemId, text: "" };
      state.messages.push(message);
    }
    message.text += params.delta || "";
    message.pendingReply = false;
    message.streamingReply = true;
    state.lastMessageAt = currentUnixSeconds();
    renderMessages(shouldStickToBottom);
    return;
  }

  if (method === "item/started") {
    if (params.threadId !== state.currentThread?.id) return;
    markRetryRecovered(params.turnId);
    const shouldStickToBottom = isMessagesNearBottom();
    const item = params.item;
    if (item?.type === "commandExecution") {
      ensureReplyProgressIndicator(params.threadId, shouldStickToBottom);
      addMessage({ role: "tool", id: item.id, text: `$ ${item.command}` }, shouldStickToBottom);
    } else if (item?.type === "fileChange") {
      ensureReplyProgressIndicator(params.threadId, shouldStickToBottom);
      addMessage({ role: "tool", id: item.id, text: t("tool.preparingFileChange") }, shouldStickToBottom);
    } else if (item?.type === "contextCompaction") {
      ensureReplyProgressIndicator(params.threadId, shouldStickToBottom);
      addMessage({
        role: "tool",
        kind: "contextCompaction",
        id: item.id,
        text: t("tool.compacting")
      }, shouldStickToBottom);
    } else if (item?.type === "imageGeneration") {
      removePendingReplyMessages(params.threadId);
      const message = messageFromItem(item);
      if (message) {
        replaceOrAppendMessage(message);
        state.lastMessageAt = currentUnixSeconds();
        renderMessages(shouldStickToBottom);
      }
    }
    return;
  }

  if (method === "item/completed") {
    if (params.threadId !== state.currentThread?.id) return;
    const shouldStickToBottom = isMessagesNearBottom();
    const message = messageFromItem(params.item);
    if (!message) return;
    if (message.role === "user") {
      clearMatchingPendingUserMessage(message.text, message.images || []);
    } else if (message.role === "assistant") {
      removePendingReplyMessages(params.threadId);
      clearStreamingReply(message.id);
    } else {
      ensureReplyProgressIndicator(params.threadId, shouldStickToBottom);
    }
    replaceOrAppendMessage(message);
    state.lastMessageAt = itemTimestamp(params.item) || currentUnixSeconds();
    renderMessages(shouldStickToBottom);
    return;
  }

  if (method === "turn/started") {
    if (params.threadId === state.currentThread?.id) {
      const diagnostics = state.turnDiagnostics.get(params.threadId);
      if (diagnostics && !diagnostics.turnStartedAt) {
        diagnostics.turnStartedAt = performance.now();
        logTurnDebug("turn-started", params.threadId);
      }
      startReplyProgress(params.threadId);
      els.threadMeta.textContent = t("turn.working");
      addPendingReplyMessage(params.threadId, isMessagesNearBottom());
    }
    return;
  }

  if (method === "turn/completed") {
    if (params.threadId === state.currentThread?.id) {
      if (formatStatus(params.turn?.status) === "completed") markRetryRecovered(params.turnId);
      logTurnDebug("turn-completed", params.threadId, {
        status: params.turn?.status || "done",
        turnTimestamp: turnTimestamp(params.turn)
      });
      stopReplyProgress(params.threadId);
      removePendingReplyMessages(params.threadId);
      clearStreamingReplies();
      els.threadMeta.textContent = t("turn.completed", {
        status: formatStatusLabel(params.turn?.status || "done")
      });
      state.lastMessageAt = turnTimestamp(params.turn) || state.lastMessageAt || currentUnixSeconds();
      renderMessages(isMessagesNearBottom());
      loadThreads();
    }
    return;
  }

  if (method === "account/updated" || method === "account/login/completed") {
    loadAccount();
    return;
  }

  if (method === "serverRequest/resolved") {
    removeApproval(params?.requestId);
  }
}

function retryStatusId(turnId) {
  return `retry-status:${turnId || "current"}`;
}

function retryErrorText(error) {
  const value = String(error?.message || error?.additionalDetails || t("retry.unknown"))
    .replace(/\s+/g, " ")
    .trim();
  return value.length > 160 ? `${value.slice(0, 157)}...` : value;
}

function markRetryRecovered(turnId) {
  const message = state.messages.find((entry) => entry.id === retryStatusId(turnId));
  if (!message || message.kind !== "retrying") return false;
  message.kind = "retryRecovered";
  message.text = t("retry.recovered");
  return true;
}

function renderApprovals(requests) {
  const current = [...els.approvalPanel.querySelectorAll("[data-request-id]")]
    .map((node) => node.dataset.requestId);

  for (const request of requests) {
    if (!request?.id || current.includes(String(request.id))) continue;
    const card = document.createElement("div");
    card.className = "approval-card";
    card.dataset.requestId = request.id;
    if (request.method === "item/tool/requestUserInput") {
      card.append(renderQuestionRequest(request));
    } else {
      card.innerHTML = `
        <div>
          <strong>${approvalTitle(request.method)}</strong>
          <p>${escapeHtml(approvalText(request))}</p>
        </div>
        <div class="approval-actions">
          <button class="approval-button accept" data-decision="accept">${escapeHtml(t("common.allow"))}</button>
          <button class="approval-button decline" data-decision="decline">${escapeHtml(t("common.decline"))}</button>
        </div>
      `;
      card.querySelectorAll("button").forEach((button) => {
        button.addEventListener("click", async () => {
          const decision = button.dataset.decision;
          await respondApproval(request, decision);
          removeApproval(request.id);
        });
      });
    }
    els.approvalPanel.append(card);
  }

  els.approvalPanel.classList.toggle("hidden", !els.approvalPanel.children.length);
}

async function respondApproval(request, decision) {
  const result = request.method.includes("requestApproval") ? { decision } : { decision };
  await sendServerResponse(request.id, result);
}

function renderQuestionRequest(request) {
  const wrap = document.createElement("div");
  wrap.className = "question-request";
  const questions = request.params?.questions || [];
  wrap.innerHTML = `
    <div>
      <strong>${approvalTitle(request.method)}</strong>
      <p>${questions.map((question) => escapeHtml(question.question)).join("<br>")}</p>
    </div>
  `;

  const form = document.createElement("form");
  form.className = "question-form";
  for (const question of questions) {
    const label = document.createElement("label");
    label.className = "question-field";
    label.innerHTML = `<span>${escapeHtml(question.header || question.id)}</span>`;
    if (question.options?.length) {
      const select = document.createElement("select");
      select.className = "field";
      select.name = question.id;
      for (const option of question.options) {
        const item = document.createElement("option");
        item.value = option.label;
        item.textContent = option.label;
        select.append(item);
      }
      label.append(select);
    } else {
      const input = document.createElement("input");
      input.className = "field";
      input.name = question.id;
      input.type = question.isSecret ? "password" : "text";
      label.append(input);
    }
    form.append(label);
  }

  const actions = document.createElement("div");
  actions.className = "approval-actions";
  actions.innerHTML = `
    <button class="approval-button accept" type="submit">${escapeHtml(t("common.submit"))}</button>
    <button class="approval-button decline" type="button">${escapeHtml(t("common.skip"))}</button>
  `;
  form.append(actions);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const answers = {};
    for (const question of questions) {
      const value = String(data.get(question.id) || "").trim();
      answers[question.id] = { answers: value ? [value] : [] };
    }
    await sendServerResponse(request.id, { answers });
    removeApproval(request.id);
  });

  actions.querySelector("button[type='button']").addEventListener("click", async () => {
    await sendServerResponse(request.id, { answers: {} });
    removeApproval(request.id);
  });

  wrap.append(form);
  return wrap;
}

function removeApproval(id) {
  const node = els.approvalPanel.querySelector(`[data-request-id="${CSS.escape(String(id))}"]`);
  node?.remove();
  els.approvalPanel.classList.toggle("hidden", !els.approvalPanel.children.length);
}

function approvalTitle(method) {
  if (method === "item/commandExecution/requestApproval") return t("approval.command");
  if (method === "item/fileChange/requestApproval") return t("approval.fileChange");
  if (method === "item/tool/requestUserInput") return t("approval.input");
  return t("approval.default");
}

function approvalText(request) {
  const params = request.params || {};
  if (params.command) return `${params.cwd || ""}\n${params.command}`;
  if (params.reason) return params.reason;
  if (params.grantRoot) return t("approval.grantRoot", { path: params.grantRoot });
  return request.method;
}

function rpc(method, params, options = {}) {
  return new Promise((resolve, reject) => {
    const requestId = state.nextRequestId++;
    const payload = { type: "rpc", requestId, method, params };
    const data = JSON.stringify(payload);
    const startedAt = performance.now();
    state.pending.set(requestId, {
      resolve,
      reject,
      method,
      label: options.label || method,
      traffic: options.traffic || null,
      startedAt,
      bytesOut: byteLengthText(data)
    });
    logRpcDebug("send", { requestId, method, bytesOut: byteLengthText(data), params });
    state.ws.send(data);
  });
}

function sendServerResponse(id, result) {
  return new Promise((resolve, reject) => {
    const requestId = state.nextRequestId++;
    state.pending.set(requestId, { resolve, reject });
    state.ws.send(JSON.stringify({ type: "server-response", requestId, id, result }));
  });
}

function createThreadLoadStats(threadId, thread, seq) {
  return {
    threadId,
    seq,
    phase: t("load.openThread"),
    startedAt: performance.now(),
    finishedAt: null,
    totalIn: 0,
    totalOut: 0,
    steps: [],
    messageCount: 0,
    itemCount: 0,
    renderMs: 0,
    title: thread?.name || thread?.preview || t("load.currentThread")
  };
}

function updateThreadLoadPhase(stats, phase) {
  if (!stats) return;
  stats.phase = phase;
  if (stats.seq === state.threadLoadSeq) {
    renderThreadLoading(state.currentThread, stats);
  }
}

function recordTrafficStep(pending, bytesIn, error) {
  const stats = pending.traffic;
  if (!stats) return;

  const elapsedMs = performance.now() - pending.startedAt;
  stats.totalOut += pending.bytesOut;
  stats.totalIn += bytesIn;
  stats.steps.push({
    label: pending.label,
    out: pending.bytesOut,
    in: bytesIn,
    ms: elapsedMs,
    failed: Boolean(error)
  });
  updateTrafficSummary(stats);

  if (stats.seq === state.threadLoadSeq && state.loadingThreadId === stats.threadId) {
    renderThreadLoading(state.currentThread, stats);
  }
}

function logRpcDebug(event, detail) {
  const elapsedMs = Number(detail.elapsedMs || 0);
  const slow = event !== "send" && elapsedMs > slowRpcThresholdMs(detail.method);
  const logger = slow || event === "error" ? console.warn : console.debug;
  logger.call(console, "[codex-mobile:rpc]", {
    event,
    requestId: detail.requestId,
    method: detail.method,
    elapsedMs: event === "send" ? undefined : Math.round(elapsedMs),
    bytesOut: detail.bytesOut,
    bytesIn: detail.bytesIn,
    slow,
    error: detail.error || undefined,
    params: event === "send" ? summarizeRpcPayload(detail.params) : undefined,
    result: event === "send" ? undefined : summarizeRpcPayload(detail.result)
  });
}

function slowRpcThresholdMs(method) {
  if (method === "turn/start" || method === "thread/read" || method === "thread/turns/list") return 5000;
  return 2000;
}

function summarizeRpcPayload(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return { type: "array", length: value.length };
  const summary = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/token/i.test(key)) {
      summary[key] = "[redacted]";
    } else if (key === "input" && Array.isArray(raw)) {
      summary[key] = raw.map((item) => summarizeInputItem(item));
    } else if (key === "data" && Array.isArray(raw)) {
      summary[key] = { type: "array", length: raw.length };
    } else if (key === "thread" && raw && typeof raw === "object") {
      summary[key] = summarizeThread(raw);
    } else if (typeof raw === "string") {
      summary[key] = raw.length > 160 ? `${raw.slice(0, 160)}...(${raw.length})` : raw;
    } else if (Array.isArray(raw)) {
      summary[key] = { type: "array", length: raw.length };
    } else if (raw && typeof raw === "object") {
      summary[key] = Object.fromEntries(Object.entries(raw).slice(0, 8));
    } else {
      summary[key] = raw;
    }
  }
  return summary;
}

function summarizeInputItem(item) {
  if (!item || typeof item !== "object") return item;
  if (item.type === "text") {
    const text = String(item.text || "");
    return { type: "text", chars: text.length, preview: text.slice(0, 80) };
  }
  if (item.type === "localImage") return { type: "localImage", path: shortPath(item.path) };
  return { type: item.type || "unknown" };
}

function summarizeThread(thread) {
  return {
    id: thread.id,
    cwd: thread.cwd,
    name: thread.name,
    status: formatStatus(thread.status)
  };
}

function logTurnDebug(event, threadId, extra = {}) {
  const diagnostics = state.turnDiagnostics.get(threadId);
  if (!diagnostics) {
    console.debug("[codex-mobile:turn]", { event, threadId, ...extra });
    return;
  }

  const now = performance.now();
  const elapsedMs = Math.round(now - diagnostics.startedAt);
  const firstDeltaMs = diagnostics.firstDeltaAt
    ? Math.round(diagnostics.firstDeltaAt - diagnostics.startedAt)
    : null;
  const turnStartedMs = diagnostics.turnStartedAt
    ? Math.round(diagnostics.turnStartedAt - diagnostics.startedAt)
    : null;
  const turnStartRpcDoneMs = diagnostics.turnStartRpcDoneAt
    ? Math.round(diagnostics.turnStartRpcDoneAt - diagnostics.startedAt)
    : null;

  const payload = {
    event,
    id: diagnostics.id,
    threadId,
    elapsedMs,
    turnStartedMs,
    turnStartRpcDoneMs,
    firstDeltaMs,
    textChars: diagnostics.textChars,
    imageCount: diagnostics.imageCount,
    ...extra
  };
  const logger = elapsedMs > 10000 && event !== "send-begin" ? console.warn : console.info;
  logger.call(console, "[codex-mobile:turn]", payload);

  if (event === "turn-completed") {
    state.turnDiagnostics.delete(threadId);
  }
}

function settleRequest(requestId, error, result, bytesIn = 0) {
  const pending = state.pending.get(requestId);
  if (!pending) return;
  state.pending.delete(requestId);
  recordTrafficStep(pending, bytesIn, error);
  logRpcDebug(error ? "error" : "result", {
    requestId,
    method: pending.method,
    elapsedMs: performance.now() - pending.startedAt,
    bytesOut: pending.bytesOut,
    bytesIn,
    error: error?.message || "",
    result
  });
  if (error) pending.reject(error);
  else pending.resolve(result);
}

function rejectPendingRequests(error) {
  for (const [requestId, pending] of state.pending.entries()) {
    state.pending.delete(requestId);
    recordTrafficStep(pending, 0, error);
    pending.reject(error);
  }
}

function addMessage(message, scroll = true) {
  state.messages.push(message);
  renderMessages(scroll);
}

function replaceOrAppendMessage(message) {
  const index = state.messages.findIndex((entry) => entry.id && entry.id === message.id);
  if (index >= 0) state.messages[index] = message;
  else state.messages.push(message);
}

function addPendingReplyMessage(threadId, scroll = true) {
  if (!threadId) return;
  startReplyProgress(threadId);
  if (state.messages.some((message) => message.pendingReply && message.threadId === threadId)) return;
  addMessage({
    role: "assistant",
    id: `pending-reply-${threadId}-${Date.now()}`,
    threadId,
    text: "",
    pendingReply: true
  }, scroll);
}

function ensureReplyProgressIndicator(threadId, scroll = true) {
  if (!threadId) return;
  startReplyProgress(threadId);
  const hasStreamingReply = state.messages.some((message) =>
    message.role === "assistant" && message.streamingReply
  );
  if (hasStreamingReply) return;
  addPendingReplyMessage(threadId, scroll);
}

function startReplyProgress(threadId) {
  if (threadId) state.replyProgressThreadIds.add(threadId);
}

function stopReplyProgress(threadId) {
  if (threadId) state.replyProgressThreadIds.delete(threadId);
}

function takePendingReplyMessage(threadId, id) {
  const index = state.messages.findIndex((message) =>
    message.pendingReply && (!threadId || message.threadId === threadId)
  );
  if (index < 0) return null;
  const [message] = state.messages.splice(index, 1);
  return {
    ...message,
    id,
    text: "",
    pendingReply: false
  };
}

function removePendingReplyMessages(threadId) {
  state.messages = state.messages.filter((message) =>
    !message.pendingReply || (threadId && message.threadId !== threadId)
  );
}

function clearStreamingReply(id) {
  if (!id) return;
  const message = state.messages.find((entry) => entry.id === id);
  if (message) message.streamingReply = false;
}

function clearStreamingReplies() {
  for (const message of state.messages) {
    message.streamingReply = false;
  }
}

function clearMatchingPendingUserMessage(text, images = []) {
  const normalizedText = normalizeMessageText(text);
  const normalizedImages = normalizeMessageImages(images);
  const index = state.messages.findIndex((message) =>
    message.pendingLocal
    && message.role === "user"
    && normalizeMessageText(message.text) === normalizedText
    && normalizeMessageImages(message.images || []) === normalizedImages
  );
  if (index >= 0) {
    state.messages.splice(index, 1);
  }
}

function normalizeMessageText(text) {
  return String(text || "").trim();
}

function normalizeMessageImages(images) {
  return (images || [])
    .map((image) => typeof image === "string" ? image : image?.source || image?.id || "")
    .filter(Boolean)
    .join("\n");
}

function addSystemMessage(text) {
  addMessage({ role: "system", text });
}

function isMessagesNearBottom(threshold = 96) {
  if (!els.messages) return true;
  const remaining = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight;
  return remaining <= threshold;
}

function scrollMessagesToBottom() {
  if (!els.messages) return;
  els.messages.scrollTop = els.messages.scrollHeight;
  requestAnimationFrame(() => {
    els.messages.scrollTop = els.messages.scrollHeight;
  });
}

function renderMessages(scroll = true) {
  if (!state.messages.length) {
    updateTrafficSummary();
    renderEmpty(t("empty.newTitle"), t("empty.newDescription"));
    return;
  }

  els.messages.innerHTML = "";
  const historyLoader = renderHistoryLoader();
  if (historyLoader) {
    els.messages.append(historyLoader);
  }
  const stream = document.createElement("div");
  stream.className = "message-stream";
  for (const entry of groupMessagesForDisplay(state.messages)) {
    if (entry.type === "toolGroup") {
      stream.append(renderToolGroup(entry.messages));
    } else {
      stream.append(renderMessage(entry.message));
    }
  }
  const progressFooter = renderReplyProgressFooter();
  if (progressFooter) stream.append(progressFooter);
  els.messages.append(stream);
  const lastMessageTime = renderLastMessageTime();
  if (lastMessageTime) {
    els.messages.append(lastMessageTime);
  }
  if (scroll) {
    scrollMessagesToBottom();
  }
  updateTrafficSummary();
}

function renderLastMessageTime() {
  if (!state.lastMessageAt) return null;
  const node = document.createElement("div");
  node.className = "last-message-time";
  node.textContent = t("lastMessage", { time: formatDateTime(state.lastMessageAt) });
  return node;
}

function renderReplyProgressFooter() {
  if (!state.currentThread?.id || !state.replyProgressThreadIds.has(state.currentThread.id)) return null;
  const item = document.createElement("article");
  item.className = "message assistant reply-progress-footer";
  item.innerHTML = `
    <div class="message-label">${labelFor("assistant")}</div>
    <div class="bubble markdown"><span class="reply-dots" aria-label="${escapeHtml(t("turn.replying"))}"></span></div>
  `;
  return item;
}

function groupMessagesForDisplay(messages) {
  const groups = [];
  let toolGroup = [];

  const flushTools = () => {
    if (!toolGroup.length) return;
    groups.push({ type: "toolGroup", messages: toolGroup });
    toolGroup = [];
  };

  for (const message of messages) {
    if (message.pendingReply) continue;
    if (message.role === "tool") {
      if (["retrying", "retryRecovered", "retryFailed", "contextCompaction"].includes(message.kind)) {
        flushTools();
        groups.push({ type: "toolGroup", messages: [message] });
        continue;
      }
      toolGroup.push(message);
    } else {
      flushTools();
      groups.push({ type: "message", message });
    }
  }
  flushTools();
  return groups;
}

function renderMessage(message) {
  if (message.kind === "reasoning") return renderReasoningMessage(message);
  if (message.kind === "automationHeartbeat") return renderAutomationHeartbeat(message);
  const item = document.createElement("article");
  const hasImages = Boolean(message.images?.length);
  const generationClass = message.imageGeneration?.pending ? " image-generation-pending" : "";
  const pendingClass = message.pendingReply ? " pending-reply" : "";
  const streamingClass = message.streamingReply ? " streaming-reply" : "";
  item.className = `message ${message.role}${hasImages ? " has-images" : ""}${generationClass}${pendingClass}${streamingClass}`;
  const bubbleClass = message.role === "tool" ? "bubble plain" : "bubble markdown";
  const hasText = Boolean(String(message.text || "").trim());
  const body = message.role === "tool"
    ? escapeHtml(message.text || "")
    : renderMarkdown(message.text || "");
  const generation = renderImageGenerationStatus(message.imageGeneration);
  const images = renderMessageImages(message.images || []);
  const bubble = hasText ? `<div class="${bubbleClass}">${body}</div>` : "";
  item.innerHTML = `
    <div class="message-label">${labelFor(message.role)}</div>
    ${generation}
    ${images}
    ${bubble}
  `;
  bindImagePlaceholders(item);
  bindMarkdownImages(item);
  return item;
}

function renderAutomationHeartbeat(message) {
  const heartbeat = message.automationHeartbeat || parseAutomationHeartbeat(message.text);
  if (!heartbeat) return renderMessage({ ...message, kind: undefined });

  const item = document.createElement("article");
  item.className = "message system automation-heartbeat-message";
  const time = formatAutomationTime(heartbeat.currentTimeIso);
  const fullTime = formatAutomationDateTime(heartbeat.currentTimeIso);
  const instructions = heartbeat.instructions
    ? `<pre>${escapeHtml(heartbeat.instructions)}</pre>`
    : `<p>${escapeHtml(t("automation.noInstructions"))}</p>`;
  item.innerHTML = `
    <details>
      <summary>
        <span class="automation-heartbeat-pulse" aria-hidden="true"></span>
        <span class="automation-heartbeat-heading">
          <strong>${escapeHtml(t("automation.heartbeat"))}</strong>
          ${heartbeat.automationId ? `<small>${escapeHtml(heartbeat.automationId)}</small>` : ""}
        </span>
        ${time ? `<time datetime="${escapeHtml(heartbeat.currentTimeIso)}" title="${escapeHtml(fullTime)}">${escapeHtml(time)}</time>` : ""}
        <span class="automation-heartbeat-chevron" aria-hidden="true">›</span>
      </summary>
      <div class="automation-heartbeat-body">${instructions}</div>
    </details>
  `;
  return item;
}

function renderReasoningMessage(message) {
  const item = document.createElement("article");
  item.className = "message system reasoning-message";
  const parts = message.reasoningParts?.length ? message.reasoningParts : [message.text || ""].filter(Boolean);
  const countText = t("reasoning.count", { count: parts.length });
  const title = reasoningPreview(parts.at(-1)) || t("reasoning.process");
  item.innerHTML = `
    <details>
      <summary title="${escapeHtml(title)}">
        <span class="reasoning-chevron" aria-hidden="true">›</span>
        <span class="reasoning-summary-title">${escapeHtml(title)}</span>
        <span class="reasoning-summary-count">${escapeHtml(countText)}</span>
      </summary>
      <div class="bubble markdown reasoning-body">${renderMarkdown(message.text || "")}</div>
    </details>
  `;
  bindImagePlaceholders(item);
  bindMarkdownImages(item);
  return item;
}

function reasoningPreview(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^#{1,6}\s+/, "")
    .replace(/\*\*|__|`/g, "")
    .trim() || "";
}

function renderImageGenerationStatus(state) {
  if (!state || (!state.pending && !state.failed)) return "";
  if (state.failed) {
    const detail = state.detail ? `<small>${escapeHtml(state.detail)}</small>` : "";
    return `
      <div class="image-generation-status failed" role="status">
        <span class="image-generation-mark" aria-hidden="true">!</span>
        <div>
          <strong>${escapeHtml(t("image.generationFailed"))}</strong>
          ${detail}
        </div>
      </div>
    `;
  }
  return `
    <div class="image-generation-status" role="status" aria-live="polite">
      <span class="mini-spinner" aria-hidden="true"></span>
      <div>
        <strong>${escapeHtml(t("image.generating"))}</strong>
        <small>${escapeHtml(t("image.generationDescription"))}</small>
      </div>
    </div>
  `;
}

function renderToolGroup(messages) {
  const item = document.createElement("article");
  item.className = "message tool compact-tool-group";
  const title = toolGroupTitle(messages);
  const details = messages.map((message, index) => {
    const text = String(message.text || "").trim();
    return `<pre>${escapeHtml(`${index + 1}. ${text}`)}</pre>`;
  }).join("");
  item.innerHTML = `
    <details>
      <summary>
        <span class="tool-summary-icon">▣</span>
        <span>${escapeHtml(title)}</span>
      </summary>
      <div class="tool-group-details">${details}</div>
    </details>
  `;
  return item;
}

function toolGroupTitle(messages) {
  const count = messages.length;
  const texts = messages.map((message) => String(message.text || "").trim());
  if (count === 1 && messages[0].kind === "retrying") return t("retry.retryingTitle");
  if (count === 1 && messages[0].kind === "retryRecovered") return t("retry.recovered");
  if (count === 1 && messages[0].kind === "retryFailed") return t("retry.failedTitle");
  if (count === 1 && [t("tool.compacting"), t("tool.compacted")].includes(texts[0])) return texts[0];
  if (texts.every((text) => text.startsWith("$ "))) return t("tool.commands", { count });
  if (texts.every((text) => text.includes("文件改动") || text.toLowerCase().includes("file"))) {
    return t("tool.fileChanges", { count });
  }
  return t("tool.records", { count });
}

function renderHistoryLoader() {
  if (!state.currentThread || (!state.hasOlderTurns && !state.loadingOlderTurns)) return null;

  const wrap = document.createElement("div");
  wrap.className = "history-loader";
  if (state.loadingOlderTurns) {
    wrap.innerHTML = `<span class="mini-spinner" aria-hidden="true"></span><span>${escapeHtml(t("load.loadingOlder"))}</span>`;
    return wrap;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = t("load.older");
  button.addEventListener("click", loadOlderTurns);
  wrap.append(button);
  return wrap;
}

function renderEmpty(title, text) {
  els.messages.innerHTML = `
    <div class="empty-state">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(text)}</p>
    </div>
  `;
}

function renderThreadLoading(thread, stats = null) {
  updateTrafficSummary(stats);
  const title = thread?.name || thread?.preview || t("load.currentThread");
  const lines = stats ? renderTrafficLines(stats) : [];
  els.messages.innerHTML = `
    <div class="loading-state" aria-live="polite">
      <div class="loading-spinner" aria-hidden="true"></div>
      <div>
        <h1>${escapeHtml(stats?.phase ? t("load.phase", { phase: stats.phase }) : t("load.opening"))}</h1>
        <p>${escapeHtml(title)}</p>
        ${lines.length ? `<div class="loading-traffic">${lines.join("")}</div>` : ""}
      </div>
    </div>
  `;
}

function updateTrafficSummary(activeStats = null) {
  if (!els.trafficSummary) return;
  const stats = activeStats || state.threadLoadStats || state.lastLoadStats;
  if (!stats || stats.threadId !== state.currentThread?.id) {
    els.trafficSummary.classList.add("hidden");
    els.trafficSummary.innerHTML = "";
    return;
  }

  const elapsed = (stats.finishedAt || performance.now()) - stats.startedAt;
  els.trafficSummary.classList.remove("hidden");
  els.trafficSummary.innerHTML = `
    <strong>${escapeHtml(t("traffic.title"))}</strong>
    <span>↓ ${formatBytes(stats.totalIn)}</span>
    <span>↑ ${formatBytes(stats.totalOut)}</span>
    <span>${formatDuration(elapsed)}</span>
    ${stats.messageCount ? `<span>${escapeHtml(t("traffic.count", { count: stats.messageCount }))}</span>` : ""}
  `;
}

function renderTrafficLines(stats) {
  const elapsed = (stats.finishedAt || performance.now()) - stats.startedAt;
  const lines = [
    `<span>${escapeHtml(t("traffic.total", {
      down: formatBytes(stats.totalIn),
      up: formatBytes(stats.totalOut),
      duration: formatDuration(elapsed)
    }))}</span>`
  ];

  for (const step of stats.steps) {
    const status = t(step.failed ? "common.failed" : "common.completed");
    lines.push(
      `<span>${escapeHtml(t("traffic.step", {
        label: step.label,
        status,
        down: formatBytes(step.in),
        up: formatBytes(step.out),
        duration: formatDuration(step.ms)
      }))}</span>`
    );
  }

  if (stats.messageCount) {
    lines.push(`<span>${escapeHtml(t("traffic.messages", {
      messages: stats.messageCount,
      items: stats.itemCount
    }))}</span>`);
  }

  return lines;
}

function renderMessageImages(images) {
  if (!images.length) return "";
  return `
    <div class="message-images">
      ${images.map((image, index) => {
        const src = image.kind === "inline"
          ? `/api/inline-image?token=${encodeURIComponent(state.token)}&id=${encodeURIComponent(image.id)}`
          : safeUrl(image.source, "image");
        if (!src) return "";
        const label = image.kind === "inline" && image.bytes
          ? `${t("image.defaultName")} · ${formatBytes(image.bytes)}`
          : t("image.defaultName");
        return `
          <button class="image-placeholder" type="button" data-image-src="${escapeHtml(src)}" data-image-index="${index}">
            <span>${escapeHtml(label)}</span>
            <small>${escapeHtml(t("image.clickLoad"))}</small>
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function bindImagePlaceholders(root) {
  for (const placeholder of root.querySelectorAll(".image-placeholder")) {
    const loadImage = () => {
      const src = placeholder.dataset.imageSrc;
      if (!src || placeholder.classList.contains("loading")) return;
      const shouldStickToBottom = isMessagesNearBottom();
      placeholder.classList.add("loading");
      const loadingText = placeholder.querySelector("small");
      if (loadingText) loadingText.textContent = t("image.loading");
      const viewerButton = document.createElement("button");
      viewerButton.className = "loaded-message-image-button";
      viewerButton.type = "button";
      viewerButton.title = t("image.fullscreen");
      const img = document.createElement("img");
      img.loading = "eager";
      img.fetchPriority = "high";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.alt = "";
      img.className = "loaded-message-image";
      const startedAt = performance.now();
      let attempt = 1;
      logImageDebug("start", { src, attempt });
      const imageLoadTimer = window.setTimeout(() => {
        if (!placeholder.isConnected) return;
        logImageDebug("timeout", {
          src: img.currentSrc || img.src || src,
          attempt,
          elapsedMs: Math.round(performance.now() - startedAt),
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight
        });
        placeholder.replaceWith(renderImageLoadError(src));
        if (shouldStickToBottom) scrollMessagesToBottom();
      }, 90000);
      let retried = false;
      img.addEventListener("load", () => {
        window.clearTimeout(imageLoadTimer);
        logImageDebug("loaded", {
          src: img.currentSrc || img.src || src,
          attempt,
          elapsedMs: Math.round(performance.now() - startedAt),
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          complete: img.complete
        });
        placeholder.replaceWith(viewerButton);
        if (shouldStickToBottom) scrollMessagesToBottom();
      });
      img.addEventListener("error", () => {
        logImageDebug("error", {
          src: img.currentSrc || img.src || src,
          attempt,
          elapsedMs: Math.round(performance.now() - startedAt),
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight
        });
        if (!retried) {
          retried = true;
          attempt += 1;
          const retrySrc = cacheBustedImageUrl(src);
          logImageDebug("retry", { src: retrySrc, attempt });
          img.src = retrySrc;
          return;
        }
        window.clearTimeout(imageLoadTimer);
        placeholder.replaceWith(renderImageLoadError(src));
        if (shouldStickToBottom) scrollMessagesToBottom();
      });
      viewerButton.append(img);
      viewerButton.addEventListener("click", () => openImageViewer(img.currentSrc || img.src || src));
      img.src = src;
    };
    placeholder.addEventListener("click", loadImage);
    placeholder.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      loadImage();
    });
  }
}

function cacheBustedImageUrl(src) {
  try {
    const url = new URL(src, window.location.href);
    url.searchParams.set("_retry", Date.now().toString(36));
    return url.toString();
  } catch {
    const separator = src.includes("?") ? "&" : "?";
    return `${src}${separator}_retry=${Date.now().toString(36)}`;
  }
}

function logImageDebug(event, detail = {}) {
  const payload = {
    event,
    id: imageIdFromUrl(detail.src),
    src: redactImageUrl(detail.src),
    attempt: detail.attempt,
    elapsedMs: detail.elapsedMs,
    complete: detail.complete,
    naturalWidth: detail.naturalWidth,
    naturalHeight: detail.naturalHeight,
    online: navigator.onLine,
    page: window.location.href
  };
  if (event === "error" || event === "timeout") {
    console.warn("[CodexMobile image]", payload);
  } else {
    console.info("[CodexMobile image]", payload);
  }
}

function imageIdFromUrl(src) {
  try {
    return new URL(src, window.location.href).searchParams.get("id") || "";
  } catch {
    return "";
  }
}

function redactImageUrl(src) {
  try {
    const url = new URL(src, window.location.href);
    if (url.searchParams.has("token")) url.searchParams.set("token", "[redacted]");
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return String(src || "").replace(/token=([^&]+)/, "token=[redacted]");
  }
}

function bindMarkdownImages(root) {
  for (const img of root.querySelectorAll(".bubble.markdown img")) {
    const shouldStickToBottom = isMessagesNearBottom();
    img.classList.add("loaded-message-image");
    img.title = t("image.fullscreen");
    img.addEventListener("click", () => openImageViewer(img.currentSrc || img.src));
    img.addEventListener("load", () => {
      if (shouldStickToBottom) scrollMessagesToBottom();
    }, { once: true });
  }
}

function renderImageLoadError(src) {
  const error = document.createElement("div");
  error.className = "image-load-error";
  error.innerHTML = `
    <strong>${escapeHtml(t("image.loadFailed"))}</strong>
    <small>${escapeHtml(src)}</small>
  `;
  return error;
}

function openImageViewer(src) {
  if (!els.imageViewer || !els.imageViewerImg || !src) return;
  els.imageViewerImg.src = src;
  els.imageViewer.classList.remove("hidden");
  document.body.classList.add("viewer-open");
}

function closeImageViewer() {
  if (!els.imageViewer || els.imageViewer.classList.contains("hidden")) return false;
  els.imageViewer.classList.add("hidden");
  document.body.classList.remove("viewer-open");
  if (els.imageViewerImg) els.imageViewerImg.src = "";
  return true;
}

function updateThreadHeader() {
  const thread = state.currentThread;
  els.threadTitle.value = thread?.name || thread?.preview || t("thread.untitled");
  els.threadTitle.disabled = !thread;
  els.threadTitle.title = t(thread?.id || thread?.draft ? "thread.editTitle" : "thread.notSelected");
  const metaPath = thread?.cwd ? shortPath(thread.cwd) : t("empty.noProject");
  els.threadMeta.textContent = thread ? `${metaPath} · ${formatStatusLabel(thread.status)}` : t("common.ready");
  updateResumeStatus(thread);
  scrollThreadTitleToEnd();
}

async function commitThreadTitle() {
  if (threadTitleSaving || !state.currentThread || !els.threadTitle) return;
  const previous = threadTitleBeforeEdit || state.currentThread.name || state.currentThread.preview || "";
  const name = els.threadTitle.value.trim();

  if (!name) {
    els.threadTitle.value = previous || state.currentThread.name || state.currentThread.preview || t("thread.untitled");
    return;
  }
  if (name === previous || name === state.currentThread.name) return;

  if (state.currentThread.draft || !state.currentThread.id) {
    state.currentThread.name = name;
    state.currentThread.preview = name;
    updateThreadHeader();
    renderThreads();
    return;
  }

  threadTitleSaving = true;
  const threadId = state.currentThread.id;
  const oldName = state.currentThread.name;
  const oldPreview = state.currentThread.preview;
  state.currentThread.name = name;
  state.currentThread.preview = name;
  updateThreadHeader();
  renderThreads();

  try {
    await rpc("thread/name/set", { threadId, name });
    await loadThreads();
    const updated = state.threads.find((thread) => thread.id === threadId);
    if (updated && state.currentThread?.id === threadId) {
      state.currentThread = { ...state.currentThread, ...updated };
      const term = els.searchThreads.value.trim().toLowerCase();
      if (term && !threadMatchesSearch(state.currentThread, term)) {
        els.searchThreads.value = "";
        renderThreads();
      }
      threadTitleBeforeEdit = state.currentThread.name || name;
      updateThreadHeader();
    }
  } catch (error) {
    if (state.currentThread?.id === threadId) {
      state.currentThread.name = oldName;
      state.currentThread.preview = oldPreview;
      threadTitleBeforeEdit = oldName || oldPreview || "";
      updateThreadHeader();
    }
    addSystemMessage(error.message || t("thread.titleError"));
  } finally {
    threadTitleSaving = false;
  }
}

function cancelThreadTitleEdit() {
  if (!els.threadTitle) return;
  els.threadTitle.value = threadTitleBeforeEdit || state.currentThread?.name || state.currentThread?.preview || t("thread.untitled");
}

function scrollThreadTitleToEnd() {
  stopThreadTitleMarquee(false);
  if (!els.threadTitle || document.activeElement === els.threadTitle) return;
  requestAnimationFrame(() => {
    const maxScroll = els.threadTitle.scrollWidth - els.threadTitle.clientWidth;
    if (maxScroll <= 1) {
      els.threadTitle.scrollLeft = 0;
      return;
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      els.threadTitle.scrollLeft = maxScroll;
      return;
    }
    runThreadTitleMarquee(maxScroll);
  });
}

function runThreadTitleMarquee(maxScroll) {
  if (!els.threadTitle || document.activeElement === els.threadTitle) return;
  const startDelay = 450;
  const endDelay = 650;
  const duration = Math.max(1400, (maxScroll / 125) * 1000);

  const cycle = () => {
    if (!els.threadTitle || document.activeElement === els.threadTitle) return;
    els.threadTitle.scrollLeft = 0;
    threadTitleScrollTimer = window.setTimeout(() => {
      const startedAt = performance.now();
      const step = (now) => {
        if (!els.threadTitle || document.activeElement === els.threadTitle) {
          stopThreadTitleMarquee(true);
          return;
        }
        const progress = Math.min(1, (now - startedAt) / duration);
        els.threadTitle.scrollLeft = maxScroll * easeInOut(progress);
        if (progress < 1) {
          threadTitleScrollFrame = requestAnimationFrame(step);
          return;
        }
        threadTitleScrollTimer = window.setTimeout(cycle, endDelay);
      };
      threadTitleScrollFrame = requestAnimationFrame(step);
    }, startDelay);
  };

  cycle();
}

function stopThreadTitleMarquee(resetScroll) {
  if (threadTitleScrollFrame) {
    cancelAnimationFrame(threadTitleScrollFrame);
    threadTitleScrollFrame = null;
  }
  if (threadTitleScrollTimer) {
    clearTimeout(threadTitleScrollTimer);
    threadTitleScrollTimer = null;
  }
  if (resetScroll && els.threadTitle) {
    els.threadTitle.scrollLeft = 0;
  }
}

function easeInOut(value) {
  return value < 0.5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2;
}

function updateProjectSelectState() {
  els.projectSelect.disabled = Boolean(state.currentThread?.id) && !state.currentThread?.draft;
}

function updateResumeStatus(thread) {
  if (!els.resumeStatus) return;
  const status = formatStatus(thread?.status);
  const hasThread = Boolean(thread?.id);
  const resuming = hasThread && state.resumingThreadId === thread.id;
  const resumed = hasThread && status !== "notLoaded" && status !== "draft";
  els.resumeStatus.classList.toggle("hidden", !hasThread || status === "draft");
  els.resumeStatus.classList.toggle("resumed", resumed);
  els.resumeStatus.classList.toggle("unresumed", !resumed);
  els.chatPane?.classList.toggle("resuming-thread", resuming);
  els.chatPane?.classList.toggle("connected-thread", resumed && !resuming);
  els.resumeStatus.textContent = t(resuming ? "thread.connecting" : resumed ? "thread.connected" : "thread.connect");
  els.resumeStatus.disabled = !hasThread || resumed || resuming;
  els.resumeStatus.title = t(resumed ? "thread.connectedTitle" : "thread.connectTitle");
}

function setConnection(key) {
  const text = t(key);
  els.connection.textContent = text;
  if (!els.connectionBanner) return;

  const value = String(text || "");
  const shouldShow = value && key !== "connection.connected";
  els.connectionBanner.textContent = value;
  els.connectionBanner.classList.toggle("hidden", !shouldShow);
  els.connectionBanner.classList.toggle(
    "danger",
    ["connection.invalidToken", "connection.error", "connection.missingToken"].includes(key)
  );
  els.connectionBanner.classList.toggle(
    "connecting",
    ["connection.connecting", "connection.reconnecting"].includes(key)
  );
}

function labelFor(role) {
  if (role === "user") return t("role.user");
  if (role === "assistant") return "Codex";
  if (role === "tool") return t("role.tool");
  return t("role.status");
}

function formatDate(seconds) {
  if (!seconds) return "";
  return new Intl.DateTimeFormat(currentLocale(), {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(seconds * 1000));
}

function formatDateTime(seconds) {
  if (!seconds) return "";
  return new Intl.DateTimeFormat(currentLocale(), {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(seconds * 1000));
}

function formatAutomationTime(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(currentLocale(), {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatAutomationDateTime(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(currentLocale(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function shortPath(value) {
  if (!value) return "";
  const text = String(value);
  const parts = text.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : text;
}

function projectFromCwd(value) {
  const cwd = String(value || t("project.unspecified"));
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  const fallback = cwd.replace(/[\\/]+$/, "");
  return {
    key: normalizePath(cwd),
    cwd,
    name: parts.at(-1) || fallback || t("project.unspecified")
  };
}

function defaultDirectConversationCwd() {
  const defaultCwd = els.cwdInput.value || "";
  const match = defaultCwd.match(/^(.*[\\/]Documents)(?:[\\/].*)?$/i);
  const documentsDir = match?.[1] || defaultCwd;
  const today = new Date().toISOString().slice(0, 10);
  const slash = documentsDir.includes("\\") ? "\\" : "/";
  return [documentsDir, "Codex", today, "mobile-chat"].join(slash);
}

function isProjectGroup(group) {
  const cwd = normalizePath(group.cwd);
  const name = group.name.toLowerCase();
  if (!cwd) return false;
  if (/\/documents\/codex\/\d{4}-\d{2}-\d{2}\//.test(cwd)) return false;
  if (/\/codex\/\d{4}-\d{2}-\d{2}\//.test(cwd)) return false;
  if (name.startsWith("new-chat")) return false;
  return true;
}

function samePath(a, b) {
  return normalizePath(a) === normalizePath(b);
}

function normalizePath(value) {
  return String(value || "")
    .replace(/[\\/]+$/, "")
    .replaceAll("\\", "/")
    .toLowerCase();
}

function formatStatus(status) {
  if (!status) return "ready";
  if (typeof status === "string") return status;
  if (typeof status === "object" && status.type) return status.type;
  return "ready";
}

function formatStatusLabel(status) {
  const value = formatStatus(status);
  const key = `status.${value}`;
  const label = t(key);
  return label === key ? value : label;
}

function formatRelativeTime(seconds) {
  if (!seconds) return "";
  const diffSeconds = Math.max(1, Math.floor(Date.now() / 1000 - seconds));
  const minute = 60;
  const hour = minute * 60;
  const day = hour * 24;
  const week = day * 7;
  if (diffSeconds < hour) return t("relative.minutes", { count: Math.max(1, Math.floor(diffSeconds / minute)) });
  if (diffSeconds < day) return t("relative.hours", { count: Math.floor(diffSeconds / hour) });
  if (diffSeconds < week) return t("relative.days", { count: Math.floor(diffSeconds / day) });
  return t("relative.weeks", { count: Math.floor(diffSeconds / week) });
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}

function formatDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} s`;
}

function byteLengthText(text) {
  return byteEncoder.encode(String(text || "")).length;
}

function encodedJsonBytes(value) {
  return byteLengthText(JSON.stringify(value));
}

function folderIcon() {
  return `
    <svg class="folder-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h4.1l2 2H18.5A2.5 2.5 0 0 1 21 9.5v6A3.5 3.5 0 0 1 17.5 19h-11A3.5 3.5 0 0 1 3 15.5v-8Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
    </svg>
  `;
}

function settingsIcon() {
  return `
    <svg class="settings-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 8.2a3.8 3.8 0 1 1 0 7.6 3.8 3.8 0 0 1 0-7.6Z" fill="none" stroke="currentColor" stroke-width="1.8"/>
      <path d="M19.2 13.1c.05-.36.08-.72.08-1.1s-.03-.74-.08-1.1l2-1.52-1.9-3.28-2.35.96a8.1 8.1 0 0 0-1.9-1.1L14.7 3.4h-3.8l-.36 2.56a8.1 8.1 0 0 0-1.9 1.1L6.3 6.1 4.4 9.38l2 1.52c-.05.36-.08.72-.08 1.1s.03.74.08 1.1l-2 1.52 1.9 3.28 2.35-.96c.58.46 1.22.83 1.9 1.1l.36 2.56h3.8l.36-2.56a8.1 8.1 0 0 0 1.9-1.1l2.35.96 1.9-3.28-2-1.52Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
    </svg>
  `;
}

function resizePromptInput() {
  const minHeight = 40;
  els.promptInput.style.height = `${minHeight}px`;
  const nextHeight = Math.min(160, Math.max(minHeight, els.promptInput.scrollHeight));
  els.promptInput.style.height = `${nextHeight}px`;
  els.promptInput.style.overflowY = els.promptInput.scrollHeight > 160 ? "auto" : "hidden";
  updateMobileChromeMetrics();
}

function submitComposer() {
  if (els.sendButton.disabled) return;
  if (els.composer.requestSubmit) {
    els.composer.requestSubmit();
    return;
  }
  els.composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const markdownRenderer = createMarkdownRenderer();

function createMarkdownRenderer() {
  if (!window.markdownit || !window.DOMPurify) return null;

  const renderer = window.markdownit({
    breaks: true,
    html: false,
    linkify: true,
    typographer: false
  });

  const defaultLinkOpen =
    renderer.renderer.rules.link_open ||
    ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
  const defaultImage =
    renderer.renderer.rules.image ||
    ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));

  renderer.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const hrefIndex = token.attrIndex("href");
    if (hrefIndex >= 0) {
      const href = safeUrl(token.attrs[hrefIndex][1], "link");
      if (href) {
        token.attrs[hrefIndex][1] = href;
        token.attrSet("target", "_blank");
        token.attrSet("rel", "noreferrer");
      } else {
        token.attrs.splice(hrefIndex, 1);
      }
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  renderer.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const srcIndex = token.attrIndex("src");
    if (srcIndex >= 0) {
      const src = safeUrl(token.attrs[srcIndex][1], "image");
      if (src) {
        const alt = token.content ? ` aria-label="${escapeHtml(token.content)}"` : "";
        return `<button class="image-placeholder markdown-image-placeholder" type="button" data-image-src="${escapeHtml(src)}"${alt}><span>${escapeHtml(t("image.defaultName"))}</span><small>${escapeHtml(t("image.clickLoad"))}</small></button>`;
      }
      token.attrs.splice(srcIndex, 1);
    }
    return defaultImage(tokens, idx, options, env, self);
  };

  return renderer;
}

function renderMarkdown(value) {
  if (!markdownRenderer || !window.DOMPurify) return escapeHtml(value);

  const dirty = markdownRenderer.render(String(value || ""));
  return window.DOMPurify.sanitize(dirty, {
    ADD_ATTR: ["target", "data-image-src"],
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed"],
    ALLOW_DATA_ATTR: true
  });
}

function safeUrl(rawUrl, kind) {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  if (/^https?:/i.test(value)) return normalizeHttpUrl(value);
  if (/^mailto:/i.test(value)) return kind === "link" ? value : "";
  if (kind === "image" && /^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(value)) return value;
  const localPath = localPathFromMarkdownUrl(value, kind);
  if (localPath) {
    return `/api/local-file?token=${encodeURIComponent(state.token)}&path=${encodeURIComponent(localPath)}`;
  }
  if (kind === "image" && /^\/(?![A-Za-z]:)/.test(value)) return value;
  if (kind === "link" && /^(#|\/(?![A-Za-z]:))/.test(value)) return value;
  return "";
}

function normalizeHttpUrl(value) {
  try {
    const url = new URL(value, window.location.href);
    if (isLocalBrowserHost(url.hostname)) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
    return url.toString();
  } catch {
    return value;
  }
}

function isLocalBrowserHost(hostname) {
  const value = String(hostname || "").toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "0.0.0.0" || value === "[::1]" || value === "::1";
}

function localPathFromMarkdownUrl(value, kind = "image") {
  const decoded = decodeMarkdownUrlPath(value);
  const withoutFileScheme = decoded.replace(/^file:\/\//i, "");
  if (/^\/[A-Za-z]:\//.test(withoutFileScheme)) return withoutFileScheme.slice(1);
  if (/^[A-Za-z]:[\\/]/.test(withoutFileScheme)) return withoutFileScheme;
  if (kind === "image" && state.currentThread?.cwd && isRelativeLocalImagePath(withoutFileScheme)) {
    return joinLocalPath(state.currentThread.cwd, withoutFileScheme);
  }
  return "";
}

function decodeMarkdownUrlPath(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function isRelativeLocalImagePath(value) {
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) return false;
  return /\.(png|jpe?g|webp|gif|svg)(?:[?#].*)?$/i.test(value);
}

function joinLocalPath(base, relativePath) {
  const slash = base.includes("\\") ? "\\" : "/";
  const cleanBase = base.replace(/[\\/]+$/, "");
  const cleanRelative = relativePath.replace(/[?#].*$/, "").replace(/^[\\/]+/, "").replaceAll("/", slash).replaceAll("\\", slash);
  return `${cleanBase}${slash}${cleanRelative}`;
}
