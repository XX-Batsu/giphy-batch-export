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
})();
