// ==UserScript==
// @name         Giphy Downloader
// @namespace    giphy-batch-export
// @version      1.0.0
// @description  Download GIFs from Giphy — single or batch with format selection
// @match        https://giphy.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      giphy.com
// @connect      *.giphy.com
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // Config
  // ============================================================

  const FORMAT_INFO = {
    source:       { label: 'Source GIF (原始)',   ext: 'gif', prop: 'url', cdn: 'source.gif' },
    original:     { label: 'Original GIF',       ext: 'gif', prop: 'url', cdn: 'giphy.gif' },
    original_mp4: { label: 'Original MP4',       ext: 'mp4', prop: 'mp4', cdn: 'giphy.mp4' },
  };

  const ALL_FORMATS = Object.keys(FORMAT_INFO);
  const DEFAULT_FORMATS = ALL_FORMATS;

  const SIZE_FALLBACK_BYTES = 2_000_000;
  const FETCH_DELAY_MS = 500;
  const ZIP_SPLIT_SIZE_MB = 500;
  const ZIP_SPLIT_SIZE_BYTES = ZIP_SPLIT_SIZE_MB * 1024 * 1024;
  const FILENAME_MAX_BYTES = 200;

  // ============================================================
  // Shared State
  // ============================================================

  const gifCache = new Map();
  let channelIdPromise = null;
  let channelIdResolve = null;
  let interceptedChannelId = null;
  let currentUrl = location.href;
  let batchButtonInterval = null;

  // ============================================================
  // Utilities
  // ============================================================

  function sanitizeTitle(title) {
    if (!title) return '';
    let clean = title.replace(/\s+(GIF|Sticker)\s+by\s+.+$/i, '');
    clean = clean.replace(/[<>:"/\\|?*]/g, '_');
    clean = clean.replace(/_+/g, '_').replace(/^_|_$/g, '').trim();
    if (new TextEncoder().encode(clean).length > FILENAME_MAX_BYTES) {
      while (new TextEncoder().encode(clean).length > FILENAME_MAX_BYTES) {
        clean = clean.slice(0, -1);
      }
      clean = clean.trim();
    }
    return clean;
  }

  function makeFilename(title, id, formatKey) {
    const info = FORMAT_INFO[formatKey];
    const ext = info ? info.ext : 'gif';
    const sanitized = sanitizeTitle(title);
    if (!sanitized) return `${id}.${ext}`;
    return `${sanitized}_${id}.${ext}`;
  }

  function getFormatUrl(images, formatKey) {
    const data = images[formatKey];
    if (!data) return null;
    const info = FORMAT_INFO[formatKey];
    if (!info) return null;
    return data[info.prop] || null;
  }

  function getCdnDomain(gifEl) {
    const img = gifEl?.querySelector('img');
    if (img?.src) {
      const match = img.src.match(/(media\d*\.giphy\.com)/);
      if (match) return match[1];
    }
    return 'media0.giphy.com';
  }

  function buildCdnUrl(gifId, formatKey, cdnDomain) {
    const info = FORMAT_INFO[formatKey];
    if (!info || !info.cdn) return null;
    const domain = cdnDomain || 'media0.giphy.com';
    return `https://${domain}/media/${gifId}/${info.cdn}`;
  }

  function getFormatSize(images, formatKey) {
    const data = images[formatKey];
    if (!data) return SIZE_FALLBACK_BYTES;
    const info = FORMAT_INFO[formatKey];
    const raw = info.prop === 'mp4' ? data.mp4_size : data.size;
    const parsed = parseInt(raw, 10);
    return parsed > 0 ? parsed : SIZE_FALLBACK_BYTES;
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function saveBlob(blob, filename) {
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  }

  function todayString() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }

  // ============================================================
  // Phase 1 — document-start interceptions (no DOM access)
  // ============================================================

  channelIdPromise = new Promise(resolve => {
    channelIdResolve = resolve;
  });

  const originalFetch = unsafeWindow.fetch;
  unsafeWindow.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const match = url.match(/\/api\/v4\/channels\/(\d+)(?:\/|$|\?)/);
    if (match && !interceptedChannelId) {
      interceptedChannelId = match[1];
      channelIdResolve(interceptedChannelId);
    }
    return originalFetch.apply(this, args);
  };

  const originalXhrOpen = unsafeWindow.XMLHttpRequest.prototype.open;
  unsafeWindow.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const match = typeof url === 'string' && url.match(/\/api\/v4\/channels\/(\d+)(?:\/|$|\?)/);
    if (match && !interceptedChannelId) {
      interceptedChannelId = match[1];
      channelIdResolve(interceptedChannelId);
    }
    return originalXhrOpen.call(this, method, url, ...rest);
  };

  const originalPushState = unsafeWindow.history.pushState;
  const originalReplaceState = unsafeWindow.history.replaceState;

  unsafeWindow.history.pushState = function (...args) {
    originalPushState.apply(this, args);
    onUrlChange();
  };

  unsafeWindow.history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    onUrlChange();
  };

  unsafeWindow.addEventListener('popstate', () => onUrlChange());

  function getBasePath(url) {
    try {
      const path = new URL(url).pathname;
      const match = path.match(/^\/([^/]+)/);
      return match ? match[1].toLowerCase() : '/';
    } catch { return '/'; }
  }

  function onUrlChange() {
    const newUrl = location.href;
    if (newUrl === currentUrl) return;

    const oldBase = getBasePath(currentUrl);
    const newBase = getBasePath(newUrl);
    currentUrl = newUrl;

    if (oldBase !== newBase) {
      gifCache.clear();
      interceptedChannelId = null;
      channelIdPromise = new Promise(resolve => {
        channelIdResolve = resolve;
      });
      if (typeof onNavigate === 'function') onNavigate();
    }
  }

  // ============================================================
  // Streaming ZIP (no JSZip — works in userscript sandbox)
  // ============================================================

  class Crc32 {
    constructor() { this.crc = -1; this.table = Crc32._makeTable(); }
    static _table = null;
    static _makeTable() {
      if (Crc32._table) return Crc32._table;
      const t = [];
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = c & 1 ? c >>> 1 ^ 0xEDB88320 : c >>> 1;
        t[i] = c;
      }
      Crc32._table = t;
      return t;
    }
    append(data) {
      let crc = this.crc | 0;
      const table = this.table;
      for (let i = 0, len = data.length; i < len; i++) crc = crc >>> 8 ^ table[(crc ^ data[i]) & 0xFF];
      this.crc = crc;
    }
    get() { return ~this.crc; }
  }

  function streamZipBlob(files) {
    // files: Array<{ name: string, data: Uint8Array }>
    // Returns a Promise<Blob> built via ReadableStream — no generateAsync needed.
    const encoder = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 6 | now.getMinutes()) << 5 | (now.getSeconds() / 2) | 0;
    const dosDate = (now.getFullYear() - 1980 << 4 | now.getMonth() + 1) << 5 | now.getDate();

    let fileIndex = 0;
    const centralEntries = [];
    let offset = 0;

    const readable = new ReadableStream({
      pull(controller) {
        if (fileIndex < files.length) {
          const file = files[fileIndex++];
          const nameBuf = encoder.encode(file.name);
          const data = file.data;

          // CRC32
          const crc = new Crc32();
          crc.append(data);
          const crcVal = crc.get();

          // Local file header (30 + name)
          const localHeader = new Uint8Array(30 + nameBuf.length);
          const lv = new DataView(localHeader.buffer);
          lv.setUint32(0, 0x04034B50, true);  // signature
          lv.setUint16(4, 20, true);           // version needed
          lv.setUint16(6, 0x0800, true);       // flags (UTF-8)
          lv.setUint16(8, 0, true);            // compression: STORE
          lv.setUint16(10, dosTime, true);
          lv.setUint16(12, dosDate, true);
          lv.setUint32(14, crcVal, true);
          lv.setUint32(18, data.length, true); // compressed size
          lv.setUint32(22, data.length, true); // uncompressed size
          lv.setUint16(26, nameBuf.length, true);
          lv.setUint16(28, 0, true);           // extra field length
          localHeader.set(nameBuf, 30);

          // Save for central directory
          centralEntries.push({ nameBuf, crcVal, size: data.length, offset });

          controller.enqueue(localHeader);
          controller.enqueue(data);
          offset += localHeader.length + data.length;
        } else {
          // Central directory
          let cdSize = 0;
          for (const entry of centralEntries) {
            const cdHeader = new Uint8Array(46 + entry.nameBuf.length);
            const cv = new DataView(cdHeader.buffer);
            cv.setUint32(0, 0x02014B50, true);   // central dir signature
            cv.setUint16(4, 20, true);            // version made by
            cv.setUint16(6, 20, true);            // version needed
            cv.setUint16(8, 0x0800, true);        // flags (UTF-8)
            cv.setUint16(10, 0, true);            // compression: STORE
            cv.setUint16(12, dosTime, true);
            cv.setUint16(14, dosDate, true);
            cv.setUint32(16, entry.crcVal, true);
            cv.setUint32(20, entry.size, true);   // compressed
            cv.setUint32(24, entry.size, true);   // uncompressed
            cv.setUint16(28, entry.nameBuf.length, true);
            cv.setUint16(30, 0, true);            // extra length
            cv.setUint16(32, 0, true);            // comment length
            cv.setUint16(34, 0, true);            // disk number
            cv.setUint16(36, 0, true);            // internal attrs
            cv.setUint32(38, 0, true);            // external attrs
            cv.setUint32(42, entry.offset, true); // local header offset
            cdHeader.set(entry.nameBuf, 46);
            controller.enqueue(cdHeader);
            cdSize += cdHeader.length;
          }

          // End of central directory
          const eocd = new Uint8Array(22);
          const ev = new DataView(eocd.buffer);
          ev.setUint32(0, 0x06054B50, true);
          ev.setUint16(4, 0, true);
          ev.setUint16(6, 0, true);
          ev.setUint16(8, centralEntries.length, true);
          ev.setUint16(10, centralEntries.length, true);
          ev.setUint32(12, cdSize, true);
          ev.setUint32(16, offset, true);
          ev.setUint16(20, 0, true);
          controller.enqueue(eocd);
          controller.close();
        }
      },
    });

    return new Response(readable).blob();
  }

  // ============================================================
  // API Module
  // ============================================================

  const GM_FETCH_TIMEOUT_MS = 60_000;

  function gmFetch(url, opts = {}) {
    let requestHandle;
    const timeoutMs = opts.timeout || GM_FETCH_TIMEOUT_MS;
    const promise = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { requestHandle.abort(); } catch (_) {}
          reject({ status: 0, error: new Error(`Request timed out after ${timeoutMs / 1000}s`) });
        }
      }, timeoutMs);

      requestHandle = GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: opts.responseType || 'json',
        onload(resp) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (resp.status === 429) {
            reject({ status: 429, response: resp });
          } else if (resp.status >= 200 && resp.status < 300) {
            resolve(resp);
          } else {
            reject({ status: resp.status, response: resp });
          }
        },
        onerror(err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject({ status: 0, error: err });
        },
        ontimeout() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject({ status: 0, error: new Error('GM_xmlhttpRequest native timeout') });
        },
      });
    });
    return { promise, abort: () => requestHandle.abort() };
  }

  function parseChannelIdFromDOM() {
    const html = document.documentElement.innerHTML;
    const escaped = html.match(/\\"channel\\":\s*\{\s*\\"id\\":\s*(\d+)/);
    if (escaped) return escaped[1];
    const unescaped = html.match(/"channel"\s*:\s*\{\s*"id"\s*:\s*(\d+)/);
    if (unescaped) return unescaped[1];
    return null;
  }

  async function getChannelId(username) {
    const intercepted = await Promise.race([
      channelIdPromise,
      delay(5000).then(() => null),
    ]);

    if (intercepted) return intercepted;

    const fromDOM = parseChannelIdFromDOM();
    if (fromDOM) {
      channelIdResolve(fromDOM);
      return fromDOM;
    }

    try {
      const { promise } = gmFetch(`https://giphy.com/${username}`, { responseType: 'text' });
      const resp = await promise;
      const text = typeof resp.response === 'string' ? resp.response : resp.responseText;
      const pageMatch = text.match(/"channel"\s*:\s*\{\s*"id"\s*:\s*(\d+)/);
      if (pageMatch) {
        channelIdResolve(pageMatch[1]);
        return pageMatch[1];
      }
    } catch (err) {
      console.error('[Giphy Downloader] channelId resolution failed:', err);
    }

    throw new Error('Could not determine channelId for ' + username);
  }

  function getGifDataFromCache(gifId) {
    return gifCache.get(gifId) || null;
  }

  const batchState = {
    isCancelled: false,
    currentRequest: null,
  };

  async function fetchAllGifs(channelId, format, onProgress) {
    const gifs = [];
    let totalSizeEstimate = 0;
    let url = `https://giphy.com/api/v4/channels/${channelId}/feed`;
    let pageNum = 1;

    while (url) {
      if (batchState.isCancelled) break;
      if (onProgress) onProgress({ phase: 'metadata', page: pageNum });

      try {
        const req = gmFetch(url);
        batchState.currentRequest = req;
        const resp = await req.promise;
        const data = typeof resp.response === 'string' ? JSON.parse(resp.response) : resp.response;

        for (const gif of (data.results || [])) {
          gifs.push(gif);
          gifCache.set(gif.id, gif);
          totalSizeEstimate += getFormatSize(gif.images, format);
        }

        url = data.next || null;
        pageNum++;
      } catch (err) {
        return { gifs, totalSizeEstimate, paginationError: err };
      }
    }

    return { gifs, totalSizeEstimate, paginationError: null };
  }

  // ============================================================
  // Styles
  // ============================================================

  function injectStyles() {
    if (document.getElementById('giphy-dl-styles')) return;
    const style = document.createElement('style');
    style.id = 'giphy-dl-styles';
    style.textContent = `
      .gd-btn {
        position: absolute;
        top: 6px;
        right: 6px;
        z-index: 10;
        width: 28px;
        height: 28px;
        border-radius: 4px;
        background: rgba(0, 0, 0, 0.65);
        color: #fff;
        border: none;
        cursor: pointer;
        font-size: 16px;
        line-height: 28px;
        text-align: center;
        opacity: 0;
        transition: opacity 0.15s;
        padding: 0;
        font-family: sans-serif;
      }
      .giphy-gif:hover .gd-btn,
      .gd-btn:focus { opacity: 1; }
      .gd-btn:hover { background: rgba(0, 0, 0, 0.85); }

      .gd-panel {
        position: absolute;
        top: 36px;
        right: 6px;
        z-index: 20;
        background: #1a1a2e;
        border: 1px solid #333;
        border-radius: 6px;
        padding: 4px 0;
        min-width: 160px;
        display: none;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      }
      .gd-panel.gd-open { display: block; }

      .gd-panel-item {
        display: block;
        width: 100%;
        padding: 6px 12px;
        border: none;
        background: none;
        color: #e0e0e0;
        font-size: 12px;
        text-align: left;
        cursor: pointer;
        font-family: sans-serif;
        white-space: nowrap;
      }
      .gd-panel-item:hover { background: #2a2a4a; color: #fff; }

      .gd-btn.gd-success { background: rgba(0, 180, 80, 0.8); }
      .gd-btn.gd-error { background: rgba(220, 40, 40, 0.8); }

      .gd-batch-container {
        position: relative;
        display: flex;
      }
      .gd-batch-btn {
        display: flex;
        background: #212121;
        border-radius: 5px;
        padding: 4px 14px;
        color: #a6a6a6;
        font-size: 14px;
        border: none;
        cursor: pointer;
        font-family: inherit;
        text-decoration: none;
      }
      .gd-batch-btn:hover { color: #fff; }
      .gd-batch-btn:disabled {
        color: #555;
        cursor: not-allowed;
      }

      .gd-batch-panel {
        position: absolute;
        bottom: 100%;
        left: 0;
        margin-bottom: 4px;
        z-index: 20;
        background: #212121;
        border: 1px solid #333;
        border-radius: 5px;
        padding: 4px 0;
        min-width: 160px;
        display: none;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      }
      .gd-batch-panel.gd-open { display: block; }

      .gd-progress {
        display: flex;
        align-items: center;
        gap: 8px;
        background: #212121;
        border-radius: 5px;
        padding: 4px 14px;
        color: #a6a6a6;
        font-size: 14px;
        font-family: inherit;
      }
      .gd-progress-text { white-space: nowrap; }
      .gd-cancel-btn {
        background: #c0392b;
        color: #fff;
        border: none;
        border-radius: 4px;
        padding: 4px 10px;
        cursor: pointer;
        font-size: 12px;
        font-family: sans-serif;
      }
      .gd-cancel-btn:hover { background: #e74c3c; }
      .gd-cancel-btn:disabled { background: #666; cursor: not-allowed; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ============================================================
  // UI Module
  // ============================================================

  const INJECTED_ATTR = 'data-gd-injected';

  function createFormatPanel(containerClass, onFormatClick) {
    const panel = document.createElement('div');
    panel.className = containerClass;

    for (const fmt of DEFAULT_FORMATS) {
      const btn = document.createElement('button');
      btn.className = 'gd-panel-item';
      btn.textContent = FORMAT_INFO[fmt].label;
      btn.dataset.format = fmt;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onFormatClick(fmt);
      });
      panel.appendChild(btn);
    }

    return panel;
  }

  function injectSingleGifButton(gifEl) {
    if (gifEl.getAttribute(INJECTED_ATTR)) return;
    gifEl.setAttribute(INJECTED_ATTR, '1');

    const gifId = gifEl.dataset.giphyId;
    if (!gifId) return;

    const btn = document.createElement('button');
    btn.className = 'gd-btn';
    btn.textContent = '⬇';
    btn.title = 'Download GIF';

    const panel = createFormatPanel('gd-panel', async (format) => {
      panel.classList.remove('gd-open');
      btn.textContent = '…';
      try {
        await downloadSingleGif(gifId, format, gifEl);
        btn.classList.add('gd-success');
        btn.textContent = '✓';
        setTimeout(() => {
          btn.classList.remove('gd-success');
          btn.textContent = '⬇';
        }, 1500);
      } catch (err) {
        console.error('[Giphy Downloader] Download failed:', err);
        btn.classList.add('gd-error');
        btn.textContent = '✗';
        btn.title = 'Error: ' + (err.message || err.status || 'unknown');
        setTimeout(() => {
          btn.classList.remove('gd-error');
          btn.textContent = '⬇';
          btn.title = 'Download GIF';
        }, 3000);
      }
    });

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.querySelectorAll('.gd-panel.gd-open, .gd-batch-panel.gd-open').forEach(p => {
        if (p !== panel) p.classList.remove('gd-open');
      });
      panel.classList.toggle('gd-open');
    });

    gifEl.appendChild(btn);
    gifEl.appendChild(panel);
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.gd-btn, .gd-panel, .gd-batch-btn, .gd-batch-panel')) {
      document.querySelectorAll('.gd-panel.gd-open, .gd-batch-panel.gd-open').forEach(p => {
        p.classList.remove('gd-open');
      });
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.gd-panel.gd-open, .gd-batch-panel.gd-open').forEach(p => {
        p.classList.remove('gd-open');
      });
    }
  });

  // ============================================================
  // Downloader Module
  // ============================================================

  async function downloadSingleGif(gifId, format, gifEl) {
    const cached = getGifDataFromCache(gifId);
    let url = cached ? getFormatUrl(cached.images, format) : null;
    if (!url) {
      const cdnDomain = getCdnDomain(gifEl);
      url = buildCdnUrl(gifId, format, cdnDomain);
    }
    if (!url) throw new Error(`Format "${format}" not available`);

    const title = cached?.title || '';
    const { promise } = gmFetch(url, { responseType: 'blob' });
    const resp = await promise;
    saveBlob(resp.response, makeFilename(title, gifId, format));
  }

  // ============================================================
  // DOM Scanning & MutationObserver
  // ============================================================

  function scanAndInject() {
    document.querySelectorAll('a.giphy-gif').forEach(el => {
      injectSingleGifButton(el);
    });
  }

  let observer = null;

  function setupObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.('a.giphy-gif')) {
            injectSingleGifButton(node);
          }
          if (node.querySelectorAll) {
            node.querySelectorAll('a.giphy-gif').forEach(el => {
              injectSingleGifButton(el);
            });
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ============================================================
  // Initialization
  // ============================================================

  function initPhase2() {
    injectStyles();
    scanAndInject();
    setupObserver();
  }

  var onNavigate = function () {
    document.querySelectorAll(`[${INJECTED_ATTR}]`).forEach(el => {
      el.removeAttribute(INJECTED_ATTR);
      el.querySelectorAll('.gd-btn, .gd-panel').forEach(c => c.remove());
    });
    setTimeout(() => {
      scanAndInject();
    }, 500);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPhase2);
  } else {
    initPhase2();
  }
})();
