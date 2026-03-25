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
})();
