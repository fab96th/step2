import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";

/* ------------------------------------------------------------------ *
 *  pdf.js reader for 《复变函数》习题解答
 *  - continuous, lazy-rendered pages
 *  - page thumbnails, zoom, deep links, keyboard shortcuts
 * ------------------------------------------------------------------ */

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "../vendor/pdfjs/pdf.worker.min.mjs",
  import.meta.url
).href;

const PDF_URL = "Latex.pdf";
const ZOOM_STEPS = [0.5, 0.65, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.3, 2.75, 3.25];
const MIN_ZOOM = ZOOM_STEPS[0];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];
const MOBILE_QUERY = "(max-width: 860px)";

const $ = (selector) => document.querySelector(selector);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const els = {
  app: $("#app"),
  topbar: $("#topbar"),
  scroller: $("#scroller"),
  pages: $("#pages"),
  sidebar: $("#sidebar"),
  thumbs: $("#thumbs"),
  backdrop: $("#backdrop"),
  sidebarToggle: $("#sidebarToggle"),
  prevBtn: $("#prevBtn"),
  nextBtn: $("#nextBtn"),
  pageInput: $("#pageInput"),
  pageTotal: $("#pageTotal"),
  zoomIn: $("#zoomIn"),
  zoomOut: $("#zoomOut"),
  zoomValue: $("#zoomValue"),
  fullscreenBtn: $("#fullscreenBtn"),
  fsIcon: $("#fsIcon"),
  progressBar: $("#progressBar"),
  toTop: $("#toTop"),
  loadOverlay: $("#loadOverlay"),
  loader: $("#loader"),
  loadError: $("#loadError"),
  loadBar: $("#loadBar"),
  loadPct: $("#loadPct"),
  errMsg: $("#errMsg"),
  pageStatus: $("#pageStatus"),
  thumbCount: $("#thumbCount"),
};

const state = {
  pdf: null,
  numPages: 0,
  dims: { width: 612, height: 792 },
  zoom: 1,
  baseScale: 1,
  cssScale: 1,
  scrollerWidth: 0,
  current: 1,
  records: [],
  thumbs: [],
  renderQueue: [],
  activeRenders: 0,
  thumbQueue: [],
  activeThumbs: 0,
  visiblePages: new Set(),
  pendingThumbs: new Set(),
  thumbsEnabled: false,
  ready: false,
  loaderDismissed: false,
};

const isMobile = () => window.matchMedia(MOBILE_QUERY).matches;
const fmtMB = (bytes) => (bytes / 1048576).toFixed(1);

/* ------------------------------------------------------------------ *
 *  boot
 * ------------------------------------------------------------------ */

init();

async function init() {
  bindUi();

  try {
    const loadingTask = pdfjsLib.getDocument({ url: PDF_URL });
    loadingTask.onProgress = ({ loaded, total }) => updateLoadProgress(loaded, total);
    state.pdf = await loadingTask.promise;

    state.numPages = state.pdf.numPages;
    const firstPage = await state.pdf.getPage(1);
    const firstViewport = firstPage.getViewport({ scale: 1 });
    state.dims = { width: firstViewport.width, height: firstViewport.height };

    els.pageTotal.textContent = String(state.numPages);
    els.thumbCount.textContent = String(state.numPages);

    buildPages();
    buildThumbs();

    state.scrollerWidth = els.scroller.clientWidth;
    computeScale();
    applyPageWidth();
    updateZoomUi();

    state.ready = true;
    setupObservers();

    const startPage = initialPage();
    state.current = startPage;
    setCurrent(startPage, { silent: true });
    scrollToPage(startPage, false);
    updateProgress();
    renderVisible();

    setTimeout(() => {
      if (!state.loaderDismissed) dismissLoader();
      enableThumbs();
    }, 1200);

    setupResizeObserver();
  } catch (error) {
    showError(error);
  }
}

function initialPage() {
  const fromHash = location.hash.match(/page=(\d+)/);
  const fromQuery = new URLSearchParams(location.search).get("page");
  const value = Number(fromHash?.[1] ?? fromQuery ?? 1);
  return Number.isFinite(value) ? clamp(Math.round(value), 1, state.numPages) : 1;
}

/* ------------------------------------------------------------------ *
 *  pages
 * ------------------------------------------------------------------ */

function buildPages() {
  const fragment = document.createDocumentFragment();

  for (let index = 0; index < state.numPages; index += 1) {
    const el = document.createElement("div");
    el.className = "page";
    el.dataset.index = String(index);
    el.style.aspectRatio = `${state.dims.width} / ${state.dims.height}`;

    state.records.push({
      index,
      el,
      page: null,
      canvas: null,
      overlay: null,
      task: null,
      renderedScale: null,
      rendering: false,
      renderId: 0,
    });

    fragment.append(el);
  }

  els.pages.append(fragment);
}

function queueRender(index, { front = false } = {}) {
  const rec = state.records[index];
  if (!rec) return;
  if (rec.renderedScale === state.cssScale) return;
  if (state.renderQueue.includes(index)) return;

  if (front) state.renderQueue.unshift(index);
  else state.renderQueue.push(index);
  pumpRenders();
}

function pumpRenders() {
  while (state.activeRenders < 2 && state.renderQueue.length > 0) {
    const index = state.renderQueue.shift();
    const rec = state.records[index];
    if (!rec || rec.rendering || rec.renderedScale === state.cssScale) continue;

    state.activeRenders += 1;
    processRender(index).finally(() => {
      state.activeRenders -= 1;
      pumpRenders();
    });
  }
}

async function processRender(index) {
  const rec = state.records[index];
  if (!rec || rec.rendering) return;

  const scale = state.cssScale;
  if (rec.renderedScale === scale) return;

  rec.rendering = true;
  const renderId = (rec.renderId += 1);

  try {
    await renderPage(rec, renderId, scale);
  } finally {
    rec.rendering = false;
    if (
      rec.renderedScale !== state.cssScale &&
      (state.visiblePages.has(index) ||
        Math.abs(index - (state.current - 1)) <= 2)
    ) {
      queueRender(index, { front: true });
    }
  }
}

async function renderPage(rec, renderId, scale) {
  try {
    const page = rec.page || (await state.pdf.getPage(rec.index + 1));
    rec.page = page;

    if (renderId !== rec.renderId || Math.abs(scale - state.cssScale) > 0.0005) {
      return;
    }

    const viewport = page.getViewport({ scale });
    const dpr = renderDpr(viewport.width, viewport.height);
    const renderViewport = page.getViewport({ scale: scale * dpr });

    let canvas = rec.canvas;
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = "page-canvas";
      canvas.setAttribute("aria-hidden", "true");
    }

    canvas.width = Math.max(1, Math.round(renderViewport.width));
    canvas.height = Math.max(1, Math.round(renderViewport.height));

    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);

    const task = page.render({
      canvasContext: context,
      viewport: renderViewport,
      background: "#ffffff",
    });
    rec.task = task;
    await task.promise;
    rec.task = null;

    if (renderId !== rec.renderId) return;

    if (!rec.canvas) {
      rec.canvas = canvas;
      rec.el.append(canvas);
    }

    rec.el.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
    rec.el.classList.add("is-rendered");

    await buildOverlays(rec, page, viewport, renderId);
    rec.renderedScale = scale;

    if (rec.index === state.current - 1) dismissLoader();
  } catch (error) {
    rec.task = null;
    if (error?.name !== "RenderingCancelledException") {
      console.warn(`第 ${rec.index + 1} 页渲染失败`, error);
    }
  }
}

function renderDpr(cssWidth, cssHeight) {
  const area = Math.max(1, cssWidth * cssHeight);
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  const maxPixels = 6_000_000;
  if (area * dpr * dpr > maxPixels) {
    dpr = Math.max(1, Math.sqrt(maxPixels / area));
  }
  return dpr;
}

async function buildOverlays(rec, page, viewport, renderId) {
  removeOverlays(rec);
  if (renderId !== rec.renderId) return;

  const textEl = document.createElement("div");
  textEl.className = "textLayer";
  textEl.style.setProperty("--scale-factor", String(viewport.scale));
  rec.el.append(textEl);

  const textLayer = new pdfjsLib.TextLayer({
    textContentSource: page.streamTextContent(),
    container: textEl,
    viewport,
  });

  rec.overlay = { textLayer, textEl, linkEl: null };

  try {
    await textLayer.render();
  } catch (error) {
    if (error?.name !== "AbortException") {
      console.warn(`第 ${rec.index + 1} 页文本层失败`, error);
    }
  }

  if (renderId !== rec.renderId) return;
  await buildLinks(rec, page, viewport, renderId);
}

async function buildLinks(rec, page, viewport, renderId) {
  let annotations;
  try {
    annotations = await page.getAnnotations({ intent: "display" });
  } catch {
    return;
  }

  if (renderId !== rec.renderId) return;

  const links = annotations.filter(
    (annotation) => annotation.subtype === "Link" && annotation.rect
  );
  if (links.length === 0) return;

  const layer = document.createElement("div");
  layer.className = "linkLayer";

  for (const annotation of links) {
    let rect;
    try {
      rect = viewport.convertToViewportRectangle(annotation.rect);
    } catch {
      continue;
    }

    const left = Math.min(rect[0], rect[2]);
    const top = Math.min(rect[1], rect[3]);
    const width = Math.abs(rect[2] - rect[0]);
    const height = Math.abs(rect[3] - rect[1]);
    if (width < 1 || height < 1) continue;

    const link = document.createElement("a");
    link.style.cssText = `left:${left.toFixed(2)}px;top:${top.toFixed(
      2
    )}px;width:${width.toFixed(2)}px;height:${height.toFixed(2)}px;`;

    if (annotation.url) {
      link.href = annotation.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = annotation.url;
    } else if (annotation.dest) {
      link.href = "#";
      link.title = "跳转到文档内链接";
      link.addEventListener("click", async (event) => {
        event.preventDefault();
        const target = await destToPage(annotation.dest);
        if (target != null) goToPage(target + 1);
      });
    } else {
      continue;
    }

    layer.append(link);
  }

  if (layer.childElementCount === 0) return;

  rec.el.append(layer);
  if (rec.overlay) rec.overlay.linkEl = layer;
}

const destCache = new Map();

async function destToPage(dest) {
  try {
    if (typeof dest === "string" && destCache.has(dest)) {
      return destCache.get(dest);
    }

    const resolved =
      typeof dest === "string" ? await state.pdf.getDestination(dest) : dest;
    if (!resolved || resolved.length === 0) return null;

    const ref = resolved[0];
    const pageIndex =
      typeof ref === "number" ? ref : await state.pdf.getPageIndex(ref);

    if (typeof dest === "string") destCache.set(dest, pageIndex);
    return pageIndex;
  } catch {
    return null;
  }
}

function removeOverlays(rec) {
  if (!rec.overlay) return;
  try {
    rec.overlay.textLayer?.cancel();
  } catch {
    /* already finished */
  }
  rec.overlay.textEl?.remove();
  rec.overlay.linkEl?.remove();
  rec.overlay = null;
}

/* ------------------------------------------------------------------ *
 *  thumbnails
 * ------------------------------------------------------------------ */

function buildThumbs() {
  const fragment = document.createDocumentFragment();

  state.thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        queueThumb(Number(entry.target.dataset.index));
      }
    },
    { root: els.thumbs, rootMargin: "600px 0px", threshold: 0 }
  );

  for (let index = 0; index < state.numPages; index += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "thumb";
    button.dataset.index = String(index);
    button.setAttribute("aria-label", `跳转到第 ${index + 1} 页`);

    const frame = document.createElement("span");
    frame.className = "thumb-frame";

    const image = document.createElement("img");
    image.alt = "";
    image.decoding = "async";

    frame.append(image);

    const label = document.createElement("span");
    label.className = "thumb-num";
    label.textContent = String(index + 1);

    button.append(frame, label);
    button.addEventListener("click", () => {
      goToPage(index + 1);
      if (isMobile()) closeSidebar();
    });

    state.thumbs.push({
      index,
      el: button,
      img: image,
      rendered: false,
      rendering: false,
    });

    fragment.append(button);
    state.thumbObserver.observe(button);
  }

  els.thumbs.append(fragment);
}

function queueThumb(index) {
  if (!state.thumbsEnabled) {
    state.pendingThumbs.add(index);
    return;
  }

  const thumb = state.thumbs[index];
  if (!thumb || thumb.rendered || thumb.rendering) return;
  if (state.thumbQueue.includes(index)) return;

  state.thumbQueue.push(index);
  pumpThumbs();
}

function pumpThumbs() {
  while (state.activeThumbs < 2 && state.thumbQueue.length > 0) {
    const index = state.thumbQueue.shift();
    const thumb = state.thumbs[index];
    if (!thumb || thumb.rendered || thumb.rendering) continue;

    state.activeThumbs += 1;
    processThumb(index).finally(() => {
      state.activeThumbs -= 1;
      pumpThumbs();
    });
  }
}

async function processThumb(index) {
  const thumb = state.thumbs[index];
  if (!thumb || thumb.rendering || thumb.rendered) return;

  thumb.rendering = true;

  try {
    const page = await state.pdf.getPage(index + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = 200 / base.width;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);

    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvasContext: context,
      viewport,
      background: "#ffffff",
    }).promise;

    let url;
    try {
      url = canvas.toDataURL("image/webp", 0.72);
    } catch {
      url = canvas.toDataURL("image/jpeg", 0.72);
    }

    thumb.img.src = url;
    thumb.el.classList.add("is-rendered");
    thumb.rendered = true;

    canvas.width = 0;
    canvas.height = 0;
  } catch (error) {
    if (error?.name !== "RenderingCancelledException") {
      console.warn(`缩略图 ${index + 1} 生成失败`, error);
    }
  } finally {
    thumb.rendering = false;
  }
}

function enableThumbs() {
  if (state.thumbsEnabled) return;
  state.thumbsEnabled = true;
  for (const index of state.pendingThumbs) queueThumb(index);
  state.pendingThumbs.clear();
}

function updateActiveThumb(index) {
  if (state.activeThumb === index) return;

  state.thumbs[state.activeThumb]?.el.classList.remove("is-active");
  const thumb = state.thumbs[index];
  if (!thumb) return;

  thumb.el.classList.add("is-active");
  state.activeThumb = index;
  revealThumb(thumb);
}

function revealThumb(thumb) {
  const container = els.thumbs;
  const top = thumb.el.offsetTop;
  const bottom = top + thumb.el.offsetHeight;

  if (top < container.scrollTop) {
    container.scrollTop = Math.max(0, top - 10);
  } else if (bottom > container.scrollTop + container.clientHeight) {
    container.scrollTop = bottom - container.clientHeight + 10;
  }
}

/* ------------------------------------------------------------------ *
 *  layout & scaling
 * ------------------------------------------------------------------ */

function computeScale() {
  const width = els.scroller.clientWidth;
  const gutter = width < 720 ? 10 : 22;
  const available = Math.min(width - gutter * 2, 1000);
  state.baseScale = Math.max(0.1, available / state.dims.width);
  state.cssScale = state.baseScale * state.zoom;
}

function applyPageWidth() {
  els.pages.style.setProperty(
    "--page-w",
    `${(state.dims.width * state.cssScale).toFixed(2)}px`
  );
}

function setZoom(nextZoom) {
  const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
  if (Math.abs(zoom - state.zoom) < 0.0005) return;
  state.zoom = zoom;
  applyScale();
}

function zoomStep(direction) {
  let zoom = state.zoom;
  if (direction > 0) {
    zoom = ZOOM_STEPS.find((step) => step > state.zoom + 0.001) ?? MAX_ZOOM;
  } else {
    zoom =
      [...ZOOM_STEPS].reverse().find((step) => step < state.zoom - 0.001) ??
      MIN_ZOOM;
  }
  setZoom(zoom);
}

function applyScale() {
  const anchor = captureAnchor();
  const previousScale = state.cssScale;

  computeScale();

  if (Math.abs(state.cssScale - previousScale) < 0.0005) {
    updateZoomUi();
    return;
  }

  invalidateRenders();
  applyPageWidth();
  restoreAnchor(anchor);
  updateZoomUi();
  renderVisible();
  updateProgress();
}

function invalidateRenders() {
  for (const rec of state.records) {
    rec.renderId += 1;
    if (rec.task) {
      try {
        rec.task.cancel();
      } catch {
        /* ignore */
      }
      rec.task = null;
    }
    rec.renderedScale = null;
    removeOverlays(rec);
  }
  state.renderQueue.length = 0;
}

function captureAnchor() {
  const rec = state.records[state.current - 1];
  if (!rec) return null;

  const height = rec.el.offsetHeight || 1;
  const raw = (els.scroller.scrollTop - rec.el.offsetTop) / height;

  // If the viewport was resized so drastically that the stored scroll
  // offset no longer falls inside the current page, stay at its top
  // instead of drifting to the next page.
  let ratio = clamp(raw, 0, 1);
  if (raw > 1) ratio = 0;

  return { index: state.current - 1, ratio };
}

function restoreAnchor(anchor) {
  if (!anchor) return;
  const rec = state.records[anchor.index];
  if (!rec) return;
  els.scroller.scrollTop =
    rec.el.offsetTop + anchor.ratio * rec.el.offsetHeight - 10;
}

function updateZoomUi() {
  const percent = Math.round(state.zoom * 100);
  els.zoomValue.textContent = `${percent}%`;
  els.zoomOut.disabled = state.zoom <= MIN_ZOOM + 0.001;
  els.zoomIn.disabled = state.zoom >= MAX_ZOOM - 0.001;
}

function setupResizeObserver() {
  if (!("ResizeObserver" in window)) return;

  const observer = new ResizeObserver(() => {
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(() => {
      const width = els.scroller.clientWidth;
      if (Math.abs(width - state.scrollerWidth) < 1) return;
      state.scrollerWidth = width;
      applyScale();
    }, 130);
  });

  observer.observe(els.scroller);
}

/* ------------------------------------------------------------------ *
 *  navigation
 * ------------------------------------------------------------------ */

function setupObservers() {
  state.pageObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const index = Number(entry.target.dataset.index);
        if (entry.isIntersecting) {
          state.visiblePages.add(index);
          queueRender(index);
        } else {
          state.visiblePages.delete(index);
        }
      }
    },
    { root: els.scroller, rootMargin: "800px 0px", threshold: 0 }
  );

  for (const rec of state.records) state.pageObserver.observe(rec.el);

  els.scroller.addEventListener("scroll", onScroll, { passive: true });
}

function renderVisible() {
  const center = state.current - 1;
  const candidates = new Set([center, center - 1, center + 1]);

  for (const index of state.visiblePages) candidates.add(index);

  for (const index of [...candidates].sort(
    (a, b) => Math.abs(a - center) - Math.abs(b - center)
  )) {
    if (index >= 0 && index < state.numPages) queueRender(index);
  }
}

let scrollTicking = false;

function onScroll() {
  if (scrollTicking) return;
  scrollTicking = true;

  requestAnimationFrame(() => {
    scrollTicking = false;

    if (!state.programmaticScroll) updateCurrentFromScroll();

    updateProgress();
    updateTopbarShadow();
    updateToTop();
    schedulePrune();
  });
}

function updateCurrentFromScroll() {
  const y = els.scroller.scrollTop + 80;
  let low = 0;
  let high = state.records.length - 1;
  let answer = 0;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (state.records[mid].el.offsetTop <= y) {
      answer = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const page = answer + 1;
  if (page !== state.current) setCurrent(page);
}

function setCurrent(page, { silent = false } = {}) {
  const next = clamp(page, 1, state.numPages);
  state.current = next;

  if (document.activeElement !== els.pageInput) {
    els.pageInput.value = String(next);
  }

  els.pageStatus.textContent = `第 ${next} 页，共 ${state.numPages} 页`;
  updateActiveThumb(next - 1);

  if (!silent) syncHash();
}

function goToPage(page, { smooth = true } = {}) {
  const target = clamp(Math.round(page), 1, state.numPages);
  const distance = Math.abs(target - state.current);
  const animate = smooth && distance <= 6;

  setCurrent(target);
  scrollToPage(target, animate);
  els.pageInput.blur();
}

function scrollToPage(page, smooth) {
  const rec = state.records[page - 1];
  if (!rec) return;

  const top = page === 1 ? 0 : Math.max(0, rec.el.offsetTop - 10);

  if (smooth) {
    state.programmaticScroll = true;
    clearTimeout(state.programmaticTimer);
    state.programmaticTimer = setTimeout(() => {
      state.programmaticScroll = false;
      updateCurrentFromScroll();
    }, 620);
  }

  els.scroller.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
}

let hashTimer = null;

function syncHash() {
  if (!state.ready) return;
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    try {
      const base = `${location.pathname}${location.search}`;
      const next = state.current > 1 ? `${base}#page=${state.current}` : base;
      history.replaceState(null, "", next);
    } catch {
      /* file:// or sandboxed */
    }
  }, 240);
}

function updateProgress() {
  const max = els.scroller.scrollHeight - els.scroller.clientHeight;
  const ratio = max > 0 ? clamp(els.scroller.scrollTop / max, 0, 1) : 0;
  els.progressBar.style.transform = `scaleX(${ratio.toFixed(4)})`;
}

function updateTopbarShadow() {
  els.topbar.classList.toggle("is-scrolled", els.scroller.scrollTop > 6);
}

function updateToTop() {
  els.toTop.classList.toggle(
    "is-visible",
    state.current > 2 || els.scroller.scrollTop > 1400
  );
}

let pruneTimer = null;

function schedulePrune() {
  clearTimeout(pruneTimer);
  pruneTimer = setTimeout(pruneDistant, 700);
}

function pruneDistant() {
  const center = state.current - 1;
  // At high zoom a single page is already large; keep a tighter window.
  const keepRadius = state.cssScale > 2.4 ? 2 : 4;

  for (const rec of state.records) {
    if (!rec.canvas || rec.rendering) continue;
    if (state.visiblePages.has(rec.index)) continue;
    if (Math.abs(rec.index - center) <= keepRadius) continue;

    rec.canvas.width = 0;
    rec.canvas.height = 0;
    rec.canvas.remove();
    rec.canvas = null;
    rec.renderedScale = null;
    rec.el.classList.remove("is-rendered");
    removeOverlays(rec);
  }
}

/* ------------------------------------------------------------------ *
 *  loader / errors
 * ------------------------------------------------------------------ */

function updateLoadProgress(loaded, total) {
  if (!total) {
    els.loadBar.style.width = "45%";
    els.loadPct.textContent = `${fmtMB(loaded)} MB`;
    return;
  }

  const percent = clamp(Math.round((loaded / total) * 100), 0, 100);
  els.loadBar.style.width = `${percent}%`;
  els.loadPct.textContent = `${percent}%`;
}

function dismissLoader() {
  if (state.loaderDismissed) return;
  state.loaderDismissed = true;
  els.loadOverlay.classList.add("is-hidden");
  setTimeout(() => {
    els.loadOverlay.hidden = true;
  }, 450);
}

function showError(error) {
  console.error("PDF 加载失败", error);

  els.loader.hidden = true;
  els.loadError.hidden = false;

  let message = "获取 PDF 文件失败，请检查文件是否存在后重试。";
  if (location.protocol === "file:") {
    message = "浏览器不允许以 file:// 方式读取本地 PDF 文件。";
  } else if (error?.name === "InvalidPDFException") {
    message = "这个文件不是有效的 PDF，或已经损坏。";
  } else if (error?.name === "PasswordException") {
    message = "这个 PDF 受密码保护，无法直接打开。";
  } else if (!navigator.onLine) {
    message = "网络连接不可用时无法加载文档。";
  }

  els.errMsg.textContent = message;
  els.loadOverlay.hidden = false;
  els.loadOverlay.classList.remove("is-hidden");
}

/* ------------------------------------------------------------------ *
 *  sidebar / fullscreen
 * ------------------------------------------------------------------ */

function toggleSidebar() {
  if (isMobile()) {
    const open = els.app.classList.toggle("sidebar-open");
    els.sidebarToggle.setAttribute("aria-pressed", String(open));
  } else {
    const collapsed = els.app.classList.toggle("sidebar-collapsed");
    els.sidebarToggle.setAttribute("aria-pressed", String(!collapsed));
  }
}

function closeSidebar() {
  els.app.classList.remove("sidebar-open");
  if (isMobile()) els.sidebarToggle.setAttribute("aria-pressed", "false");
}

async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch {
    /* not available */
  }
}

const ICON_EXPAND = `
  <path d="M8 3H5a2 2 0 0 0-2 2v3" />
  <path d="M16 3h3a2 2 0 0 1 2 2v3" />
  <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
  <path d="M16 21h3a2 2 0 0 0 2-2v-3" />`;

const ICON_COMPRESS = `
  <path d="M8 3v3a2 2 0 0 1-2 2H3" />
  <path d="M16 3v3a2 2 0 0 0 2 2h3" />
  <path d="M8 21v-3a2 2 0 0 0-2-2H3" />
  <path d="M16 21v-3a2 2 0 0 1 2-2h3" />`;

function updateFullscreenUi() {
  const active = Boolean(document.fullscreenElement);
  els.fsIcon.innerHTML = active ? ICON_COMPRESS : ICON_EXPAND;
  els.fullscreenBtn.title = active ? "退出全屏（F）" : "全屏（F）";
  els.fullscreenBtn.setAttribute("aria-label", active ? "退出全屏" : "全屏");
}

/* ------------------------------------------------------------------ *
 *  events
 * ------------------------------------------------------------------ */

function bindUi() {
  els.prevBtn.addEventListener("click", () => goToPage(state.current - 1));
  els.nextBtn.addEventListener("click", () => goToPage(state.current + 1));

  els.pageInput.addEventListener("focus", () => els.pageInput.select());
  els.pageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitPageInput();
      els.pageInput.blur();
    } else if (event.key === "Escape") {
      els.pageInput.value = String(state.current);
      els.pageInput.blur();
    }
  });
  els.pageInput.addEventListener("blur", commitPageInput);

  els.zoomIn.addEventListener("click", () => zoomStep(1));
  els.zoomOut.addEventListener("click", () => zoomStep(-1));
  els.zoomValue.addEventListener("click", () => setZoom(1));

  els.sidebarToggle.addEventListener("click", toggleSidebar);
  els.backdrop.addEventListener("click", closeSidebar);

  els.fullscreenBtn.addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", updateFullscreenUi);

  els.toTop.addEventListener("click", () => {
    goToPage(1, { smooth: false });
  });

  els.scroller.addEventListener("pointerdown", () => {
    if (document.activeElement !== els.scroller) {
      els.scroller.focus({ preventScroll: true });
    }
  });

  els.scroller.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();

      const now = performance.now();
      if (now - (state.lastZoomWheel || 0) < 120) return;
      state.lastZoomWheel = now;

      zoomStep(event.deltaY < 0 ? 1 : -1);
    },
    { passive: false }
  );

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("hashchange", onHashChange);

  window
    .matchMedia(MOBILE_QUERY)
    .addEventListener("change", () => {
      els.app.classList.remove("sidebar-open");
      els.sidebarToggle.setAttribute(
        "aria-pressed",
        String(isMobile() ? false : !els.app.classList.contains("sidebar-collapsed"))
      );
    });

  if (isMobile()) els.sidebarToggle.setAttribute("aria-pressed", "false");

  history.scrollRestoration = "manual";
}

function commitPageInput() {
  const value = Number.parseInt(els.pageInput.value, 10);
  if (!Number.isFinite(value)) {
    els.pageInput.value = String(state.current);
    return;
  }
  if (value === state.current) return;
  goToPage(value, { smooth: false });
}

function onKeyDown(event) {
  const tag = event.target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    if (event.key === "Escape") event.target.blur();
    return;
  }

  if (event.metaKey || event.ctrlKey || event.altKey) return;

  switch (event.key) {
    case "ArrowRight":
    case "PageDown":
      event.preventDefault();
      goToPage(state.current + 1);
      break;
    case "ArrowLeft":
    case "PageUp":
      event.preventDefault();
      goToPage(state.current - 1);
      break;
    case "Home":
      event.preventDefault();
      goToPage(1);
      break;
    case "End":
      event.preventDefault();
      goToPage(state.numPages);
      break;
    case "+":
    case "=":
      event.preventDefault();
      zoomStep(1);
      break;
    case "-":
    case "_":
      event.preventDefault();
      zoomStep(-1);
      break;
    case "0":
      event.preventDefault();
      setZoom(1);
      break;
    case "f":
    case "F":
      event.preventDefault();
      toggleFullscreen();
      break;
    case "Escape":
      closeSidebar();
      break;
    default:
      break;
  }
}

function onHashChange() {
  const match = location.hash.match(/page=(\d+)/);
  if (!match) return;
  const page = clamp(Number(match[1]), 1, state.numPages);
  if (page !== state.current) goToPage(page, { smooth: false });
}
