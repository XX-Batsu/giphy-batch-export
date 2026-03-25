# Giphy Batch Export

A Tampermonkey userscript that adds single-GIF and batch download to any Giphy channel page.

## Requirements

[Tampermonkey](https://www.tampermonkey.net/) (Chrome / Firefox / Safari)

## Install

1. Open Tampermonkey → **Create a new script**
2. Paste the contents of [`giphy-downloader.user.js`](giphy-downloader.user.js)
3. Save

## Usage

### Single GIF

Hover any GIF — a **⬇** button appears. Click it and pick a format.

### Batch download

Navigate to a Giphy channel (e.g. `giphy.com/someuser`). A **Download All** button appears in the footer bar next to the Privacy link. Click it, pick a format, and the script will:

- Page through the full channel feed
- Download each file with a 500 ms delay between requests
- Retry up to 3× on rate-limit (429) or network errors
- Stream files into ZIP archives, splitting at 500 MB
- Prompt before downloading if the total exceeds 500 MB

Click **Cancel** at any time — already-downloaded files are saved as a partial ZIP.

## Formats

| Key | Description |
|---|---|
| `source` | Source GIF (原始) — highest quality |
| `original` | Original GIF |
| `original_mp4` | Original MP4 |

## Output filenames

`<title>_<id>.<ext>` for individual files  
`<username>_<format>_<YYYYMMDD>[_partN].zip` for batch ZIPs
