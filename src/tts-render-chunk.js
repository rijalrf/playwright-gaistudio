const path = require('path');
const fs = require('fs');
const { humanClick, humanPaste, humanDelay } = require('./human-behavior');
const { dismissPopups } = require('./tts-ui-helpers');
const { formatSpeakerPrompt } = require('./tts-text-utils');
const {
  downloadWithRetry,
  captureAudioElementsSnapshot,
  extractBaselineBlobUrls
} = require('./audio-downloader');
const { convertWavToMp3 } = require('./audio-converter');

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 12000;

function isQuotaText(text) {
  return /quota|limit reached|exceeded your current quota/i.test(String(text || ''));
}

function quotaExceededError(detail) {
  const clean = String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const err = new Error(
    'Kuota harian Gemini TTS habis (HTTP 429).' +
    (clean ? ` Google: "${clean}".` : '') +
    ' Tunggu reset kuota (tengah malam Waktu Pasifik, sekitar 14:00 WIB) atau pakai akun Google lain.'
  );
  err.code = 'QUOTA_EXCEEDED';
  return err;
}

/**
 * Menjalankan render dan mengunduh berkas audio untuk satu bagian (chunk) naskah.
 * @param {import('playwright').Page} page
 * @param {Object} chunk
 * @param {Object} options
 * @returns {Promise<Object>} Metadata berkas audio yang berhasil diunduh
 */
async function renderChunkAudio(page, chunk, options) {
  const { downloadsDir, totalChunks, chunkBase, progressChunkSlice, onProgress } = options;

  onProgress({
    stage: 'rendering',
    progress: Math.round(chunkBase + progressChunkSlice * 0.1),
    currentPart: chunk.index,
    totalParts: totalChunks,
    message: `Menempelkan naskah bagian ${chunk.index}/${totalChunks} (${chunk.wordCount} kata)...`
  });
  console.log(`\n[TtsEngine] Memproses Bagian [${chunk.index}/${chunk.total}] (${chunk.wordCount} kata)...`);

  const tPart = Date.now();
  const partTimings = {};

  // 1. Snapshot baseline audio elements dan download buttons sebelum RUN
  const baselineAudioSnapshot = await captureAudioElementsSnapshot(page);
  const baselineBlobUrls = extractBaselineBlobUrls(baselineAudioSnapshot);
  console.log(`[TtsEngine] Audio baseline snapshot: ${baselineAudioSnapshot.length} elemen, ${baselineBlobUrls.size} blob URL.`);

  // 2. Paste prompt naskah
  const promptTextarea = 'textarea[aria-label="Enter a prompt"]';
  const finalPrompt = formatSpeakerPrompt(chunk.promptText || chunk.text);
  const tPaste = Date.now();
  await humanPaste(page, promptTextarea, finalPrompt);
  await humanDelay(500, 800);
  partTimings.pasteMs = Date.now() - tPaste;

  // Siapkan listener respons jaringan backend Google AI Studio
  let apiDone = false;
  let apiTimestamp = 0;
  let quotaDetail = null;
  let apiResponseResolver = null;
  const apiResponsePromise = new Promise(resolve => {
    apiResponseResolver = resolve;
  });

  const responseHandler = async res => {
    try {
      const u = res.url();
      const isApi = u.includes('alkalimakersuite') || u.includes('generate-speech') || u.includes('predict') || u.includes('googleapis');

      // 429 = kuota Gemini TTS habis. Jangan lanjut menunggu render/unduh.
      if (res.status() === 429) {
        const body = await res.text().catch(() => '');
        quotaDetail = body.slice(0, 300);
        console.error(`\n[TtsEngine] ❌ KUOTA GEMINI TTS HABIS (HTTP 429): ${quotaDetail.replace(/\s+/g, ' ').slice(0, 200)}\n`);
        return;
      }

      if (res.status() >= 400 && isApi) {
        const body = await res.text().catch(() => '');
        console.error(`\n[TtsEngine] ❌ Google API Error ${res.status()}: ${body.slice(0, 500)}\n`);
      }
      if ((u.includes('alkalimakersuite') || u.includes('generate-speech') || u.includes('predict')) && res.status() === 200) {
        console.log(`[TtsEngine] Backend API TTS respons diterima (${res.status()}).`);
        apiDone = true;
        apiTimestamp = Date.now();
        if (apiResponseResolver) apiResponseResolver(res);
      }
    } catch {}
  };
  page.on('response', responseHandler);

  try {
  // 3. Klik tombol RUN
  onProgress({
    stage: 'rendering',
    progress: Math.round(chunkBase + progressChunkSlice * 0.25),
    currentPart: chunk.index,
    totalParts: totalChunks,
    message: `Mengirim perintah render suara bagian ${chunk.index}/${totalChunks} ke Gemini...`
  });
  await dismissPopups(page);
  console.log(`[TtsEngine] Klik RUN (Bagian ${chunk.index})...`);
  const runBtn = 'button:has-text("Run  Ctrl  keyboard_return"), button:has-text("Run"), button.run-button, [aria-label*="Run" i]';
  await humanClick(page, runBtn);

  // 4. Polling UI state sampai audio selesai dirender
  console.log('[TtsEngine] Menunggu Gemini merender audio...');
  const genStartTime = Date.now();
  const tRender = Date.now();
  let lastReportSec = 0;
  let detectedTargetAudio = null;

  await humanDelay(600, 900);

  while (true) {
    const elapsedSec = Math.floor((Date.now() - genStartTime) / 1000);

    if (page.isClosed()) {
      throw new Error(`Target page, context or browser has been closed during rendering of chunk ${chunk.index}`);
    }

    const baselineUrlsArray = Array.from(baselineBlobUrls);
    const uiState = await page.evaluate(({ baselineUrls }) => {
      const allButtons = Array.from(document.querySelectorAll('button'));
      const rBtn = allButtons.find(b => {
        const t = ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
        if (t.includes('run settings') || b.closest('.run-settings-panel') || b.closest('.model-settings')) return false;
        return (t.includes('run') && (t.includes('ctrl') || t.includes('keyboard_return') || b.querySelector('mat-icon, .mat-icon') || b.classList.contains('mat-mdc-unelevated-button') || b.classList.contains('mat-primary'))) ||
               b.classList.contains('run-button') ||
               (t.includes('stop generation') || (t.includes('stop') && !t.includes('play')));
      });

      let isGenBusy = false;
      let isRunReady = false;
      let runHasSpinner = false;

      if (rBtn) {
        const t = ((rBtn.innerText || '') + ' ' + (rBtn.getAttribute('aria-label') || '')).toLowerCase();
        const isDisabled = rBtn.disabled || rBtn.hasAttribute('disabled') || rBtn.getAttribute('aria-disabled') === 'true';
        runHasSpinner = Boolean(rBtn.querySelector('mat-progress-spinner, mat-spinner, .mat-mdc-progress-spinner') || rBtn.parentElement?.querySelector('mat-progress-spinner'));
        const isStop = t.includes('stop') && !t.includes('play');

        isGenBusy = isStop || runHasSpinner;
        isRunReady = t.includes('run') && !runHasSpinner && !isStop && !isDisabled;
      }

      const dlButtons = Array.from(document.querySelectorAll('button')).filter(b => {
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        const txt = (b.innerText || '').toLowerCase();
        const isDl = aria.includes('download') || txt.includes('download');
        const notDisabled = !b.disabled && !b.hasAttribute('disabled') && b.getAttribute('aria-disabled') !== 'true';
        return isDl && notDisabled && b.getBoundingClientRect().width > 0;
      });
      const hasDownloadBtn = dlButtons.length > 0;

      const audios = Array.from(document.querySelectorAll('audio')).map((a, idx) => ({
        index: idx,
        src: a.src || null,
        currentSrc: a.currentSrc || null,
        readyState: a.readyState,
        duration: a.duration
      }));

      let freshAudio = null;
      for (let i = audios.length - 1; i >= 0; i--) {
        const a = audios[i];
        const s = a.currentSrc || a.src || '';
        if (s.startsWith('blob:') && !baselineUrls.includes(s)) {
          freshAudio = a;
          break;
        }
      }

      if (!freshAudio && (!baselineUrls || baselineUrls.length === 0)) {
        freshAudio = audios.filter(a => (a.currentSrc || a.src || '').startsWith('blob:')).pop() || null;
      }

      let errorMessage = null;
      const errorNodes = document.querySelectorAll('mat-snack-bar-container, .error-message, [role="alert"], ms-banner, mat-dialog-container, .mat-mdc-dialog-container');
      for (const el of errorNodes) {
        const txt = el.innerText.trim();
        const lower = txt.toLowerCase();
        if (txt && (/quota/i.test(txt) || txt.includes('403') || txt.includes('400') || txt.includes('500') || lower.includes('permission denied') || lower.includes('rate limit') || lower.includes('no speakers detected'))) {
          errorMessage = txt.replace(/\s+/g, ' ').slice(0, 300);
          break;
        }
      }

      return {
        isGenBusy,
        isRunReady,
        hasSpinner: runHasSpinner,
        hasDownloadBtn,
        freshAudio,
        isFreshAudioReady: Boolean(freshAudio && (freshAudio.src || freshAudio.currentSrc)),
        errorMessage
      };
    }, { baselineUrls: baselineUrlsArray });

    // Kuota habis: gagal cepat dengan pesan jelas, jangan menunggu render/unduh sia-sia.
    if (quotaDetail) {
      throw quotaExceededError(quotaDetail);
    }

    if (uiState.errorMessage) {
      if (isQuotaText(uiState.errorMessage)) {
        throw quotaExceededError(uiState.errorMessage);
      }
      throw new Error(`Google AI Studio merespons error: ${uiState.errorMessage}`);
    }

    if (uiState.freshAudio) {
      detectedTargetAudio = uiState.freshAudio;
    }

    // Tombol download hanya dianggap tanda selesai bila backend benar-benar membalas 200,
    // supaya error 429/kuota tidak disalahartikan sebagai "render selesai".
    const isGenerationComplete = (uiState.isFreshAudioReady && !uiState.isGenBusy) ||
      (uiState.isFreshAudioReady && apiDone && (Date.now() - apiTimestamp > 1200)) ||
      (uiState.hasDownloadBtn && apiDone && !uiState.isGenBusy && elapsedSec >= 4);

    if (isGenerationComplete) {
      console.log(`[TtsEngine] Render audio selesai terdeteksi (${elapsedSec}s)!`);
      partTimings.renderMs = Date.now() - tRender;
      break;
    }

    if (elapsedSec - lastReportSec >= 4) {
      lastReportSec = elapsedSec;
      console.log(`   (${elapsedSec}s) Spinner: ${uiState.hasSpinner} | GenBusy: ${uiState.isGenBusy} | RunReady: ${uiState.isRunReady} | FreshAudio: ${uiState.isFreshAudioReady} | HasDL: ${uiState.hasDownloadBtn} | ApiDone: ${apiDone}`);
      onProgress({
        stage: 'rendering',
        progress: Math.min(Math.round(chunkBase + progressChunkSlice * 0.65), 92),
        currentPart: chunk.index,
        totalParts: totalChunks,
        message: `Gemini sedang merender suara bagian ${chunk.index}/${totalChunks} (${elapsedSec}s)...`
      });
    }

    if (elapsedSec > 180) {
      throw new Error(`[TtsEngine] Batas waktu render audio tercapai (${elapsedSec}s). Audio tidak berhasil digenerate oleh Gemini.`);
    }

    await new Promise(r => setTimeout(r, 800));
  }

  await Promise.race([
    apiResponsePromise,
    new Promise(r => setTimeout(r, 3000))
  ]);

  console.log(`[TtsEngine] Selesai generate bagian ${chunk.index}!`);

  // 5. Akuisisi audio via Direct DOM Blob Extraction
  onProgress({
    stage: 'downloading',
    progress: Math.round(chunkBase + progressChunkSlice * 0.8),
    currentPart: chunk.index,
    totalParts: totalChunks,
    message: `Mengunduh berkas audio bagian ${chunk.index}/${totalChunks}...`
  });
  console.log(`[TtsEngine] Mengakuisisi berkas audio bagian ${chunk.index}...`);

  const downloadStartTime = Date.now();
  const filename = `gemini_tts_${downloadStartTime}_part${chunk.index}.wav`;
  const detectedBlobSrc = detectedTargetAudio ? (detectedTargetAudio.currentSrc || detectedTargetAudio.src) : null;
  const tDownload = Date.now();

  const downloadResult = await downloadWithRetry({
    page,
    downloadDir: downloadsDir,
    customFilename: filename,
    timeout: Number(process.env.DOWNLOAD_TIMEOUT_MS) || DEFAULT_DOWNLOAD_TIMEOUT_MS,
    baselineSnapshot: baselineAudioSnapshot,
    targetBlobSrc: detectedBlobSrc,
    trigger: async () => {
      if (page.isClosed()) return;
      const downloadBtn = page.locator('button[aria-label="Download"], button[aria-label*="Download" i], button:has-text("Download")').last();
      if (await downloadBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await downloadBtn.scrollIntoViewIfNeeded().catch(() => {});
        await downloadBtn.click({ force: true });
      }
    }
  }, 1);

  partTimings.downloadMs = Date.now() - tDownload;
  const downloadedPath = downloadResult.path;

  if (downloadedPath && fs.existsSync(downloadedPath)) {
    const wavStats = fs.statSync(downloadedPath);
    console.log(`[TtsEngine] Berkas WAV diterima: ${filename} (${(wavStats.size / 1024).toFixed(1)} KB) [${downloadResult.strategy}]`);

    // Konversi otomatis ke format MP3 (192 kbps)
    let finalPath = downloadedPath;
    let finalFilename = filename;
    let finalStats = wavStats;

    try {
      console.log(`[TtsEngine] Mengonversi ${filename} ke format MP3 (192 kbps)...`);
      const tConvert = Date.now();
      const mp3Path = await convertWavToMp3(downloadedPath);
      partTimings.convertMs = Date.now() - tConvert;
      finalPath = mp3Path;
      finalFilename = path.basename(mp3Path);
      finalStats = fs.statSync(mp3Path);
      console.log(`[TtsEngine] Berkas MP3 siap: ${finalFilename} (${(finalStats.size / 1024).toFixed(1)} KB)`);
    } catch (convErr) {
      console.warn(`[TtsEngine] Konversi MP3 gagal, menggunakan fallback WAV: ${convErr.message}`);
    }

    partTimings.totalMs = Date.now() - tPart;
    console.log(`[TIMING] part ${chunk.index}: total=${partTimings.totalMs}ms | paste=${partTimings.pasteMs || 0}ms | render=${partTimings.renderMs || 0}ms | download=${partTimings.downloadMs || 0}ms | convert=${partTimings.convertMs || 0}ms`);

    return {
      partIndex: chunk.index,
      totalParts: chunk.total,
      filename: finalFilename,
      filePath: finalPath,
      downloadUrl: `/api/tts/download/${finalFilename}`,
      sizeBytes: finalStats.size,
      sizeKb: (finalStats.size / 1024).toFixed(1),
      strategy: downloadResult.strategy,
      textSnippet: chunk.text.slice(0, 80) + (chunk.text.length > 80 ? '...' : ''),
      wordCount: chunk.wordCount,
      wavFilePath: downloadedPath,
      wavFilename: filename,
      timings: partTimings
    };
  }

  const debugImg = path.join(downloadsDir, `debug_download_failed_part${chunk.index}_${Date.now()}.png`);
  await page.screenshot({ path: debugImg, fullPage: true }).catch(() => {});
  throw new Error(`File audio bagian ${chunk.index} gagal diunduh. Screenshot debug disimpan di ${path.basename(debugImg)}`);
  } finally {
    try {
      page.off('response', responseHandler);
    } catch {}
  }
}

module.exports = {
  renderChunkAudio
};
