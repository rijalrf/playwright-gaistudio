const path = require('path');
const fs = require('fs');
const {
  sanitizeFilename,
  isWavFile,
  findRecentDownloadedWav,
  extractBaselineBlobUrls,
  isFreshBlob,
  findFreshBlobAudio,
  captureAudioElementsSnapshot,
  findTargetAudioElement
} = require('./audio-detector');
const { extractBlobDirectly } = require('./audio-blob-extractor');

/**
 * Handler unduhan dengan prioritas utama Direct DOM Blob Extraction dan fallback Playwright download event.
 * @param {Object} options
 * @returns {Promise<Object>}
 */
async function downloadFile({
  page,
  trigger,
  downloadDir,
  customFilename = null,
  timeout = 12000,
  baselineSnapshot = [],
  targetBlobSrc = null
}) {
  if (!page || page.isClosed()) {
    throw new Error('Page sudah ditutup sebelum proses unduhan audio dimulai');
  }

  const startTime = Date.now();
  console.log('[DOWNLOAD] Memulai akuisisi audio...');

  await fs.promises.mkdir(downloadDir, { recursive: true });

  const resolvedName = customFilename
    ? sanitizeFilename(customFilename)
    : sanitizeFilename(`gemini_tts_${Date.now()}.wav`);
  const finalPath = path.resolve(downloadDir, resolvedName);

  let strategyUsed = 'DOM_BLOB';
  let downloadUrl = 'blob:local';
  let blobSuccess = false;
  let activeBlobSrc = targetBlobSrc;

  // STRATEGI 1: DIRECT DOM BLOB EXTRACTION
  try {
    if (!activeBlobSrc) {
      const pollStart = Date.now();
      while (Date.now() - pollStart < 1500 && !page.isClosed()) {
        const targetAudio = await findTargetAudioElement(page, baselineSnapshot);
        if (targetAudio && (targetAudio.currentSrc || targetAudio.src)) {
          activeBlobSrc = targetAudio.currentSrc || targetAudio.src;
          break;
        }
        await new Promise(r => setTimeout(r, 600));
      }
    }

    if (activeBlobSrc && activeBlobSrc.startsWith('blob:')) {
      console.log(`[DOWNLOAD] Mengambil Blob URL target: ${activeBlobSrc}`);
      const blobResult = await extractBlobDirectly(page, activeBlobSrc, finalPath);
      if (blobResult.success) {
        downloadUrl = blobResult.src;
        blobSuccess = true;
        console.log(`[DOWNLOAD] Strategi: DOM_BLOB | Ukuran: ${(blobResult.byteLength / 1024).toFixed(1)} KB`);
      }
    }
  } catch (initialBlobErr) {
    console.warn(`[DOWNLOAD] Ekstraksi Blob awal gagal: ${initialBlobErr.message}. Mencoba retry deteksi audio...`);
    try {
      if (!page.isClosed()) {
        const retryAudio = await findTargetAudioElement(page, baselineSnapshot);
        if (retryAudio && (retryAudio.currentSrc || retryAudio.src)) {
          const retryBlobSrc = retryAudio.currentSrc || retryAudio.src;
          const retryResult = await extractBlobDirectly(page, retryBlobSrc, finalPath);
          if (retryResult.success) {
            downloadUrl = retryResult.src;
            blobSuccess = true;
            console.log(`[DOWNLOAD] Strategi: DOM_BLOB (Retry Sukses) | Ukuran: ${(retryResult.byteLength / 1024).toFixed(1)} KB`);
          }
        }
      }
    } catch (retryBlobErr) {
      console.warn(`[DOWNLOAD] Retry ekstraksi Blob gagal: ${retryBlobErr.message}`);
    }
  }

  // STRATEGI 2: NATIVE PLAYWRIGHT DOWNLOAD EVENT (FALLBACK)
  if (!blobSuccess) {
    strategyUsed = 'PLAYWRIGHT_DOWNLOAD';
    if (page.isClosed()) {
      throw new Error('Page telah ditutup sebelum menjalankan fallback download.');
    }
    if (typeof trigger !== 'function') {
      throw new Error('Ekstraksi Blob tidak berhasil dan tidak ada fungsi trigger download.');
    }

    console.warn('[DOWNLOAD] Beralih ke fallback Native Playwright Download...');
    try {
      const browserContext = typeof page.context === 'function' ? page.context() : null;
      const downloadPromise = browserContext
        ? Promise.race([
            page.waitForEvent('download', { timeout: Math.min(timeout, 25000) }),
            browserContext.waitForEvent('download', { timeout: Math.min(timeout, 25000) })
          ])
        : page.waitForEvent('download', { timeout: Math.min(timeout, 25000) });

      const [download] = await Promise.all([
        downloadPromise,
        (async () => {
          if (!page.isClosed()) {
            try { await trigger(); } catch (trigErr) { console.warn(`[DOWNLOAD] Warning trigger download: ${trigErr.message}`); }
          }
        })()
      ]);

      downloadUrl = typeof download.url === 'function' ? download.url() : 'native:download';
      let saved = false;

      const userDownloadsDir = path.join(process.env.USERPROFILE || process.env.HOME || '', 'Downloads');
      const searchDirs = [downloadDir, userDownloadsDir];

      try {
        await download.saveAs(finalPath);
        saved = true;
      } catch (saveErr) {
        console.warn(`[DOWNLOAD] saveAs gagal (${saveErr.message}), mencari berkas di direktori unduhan...`);
        try {
          const tempPath = await download.path();
          if (tempPath && fs.existsSync(tempPath)) {
            await fs.promises.copyFile(tempPath, finalPath);
            saved = true;
          }
        } catch (pErr) {}

        if (!saved) {
          const foundWav = findRecentDownloadedWav(searchDirs, 45000);
          if (foundWav) {
            await fs.promises.copyFile(foundWav, finalPath);
            saved = true;
            strategyUsed = 'CHROME_DIRECT_DOWNLOAD';
            console.log(`[DOWNLOAD] Pulih via scan direktori unduhan: ${path.basename(foundWav)}`);
          }
        }

        if (!saved) {
          throw new Error(`Gagal menyimpan download: ${saveErr.message}`);
        }
      }
    } catch (downloadErr) {
      let recovered = false;
      const userDownloadsDir = path.join(process.env.USERPROFILE || process.env.HOME || '', 'Downloads');
      const searchDirs = [downloadDir, userDownloadsDir];

      await new Promise(r => setTimeout(r, 1500));

      const foundWav = findRecentDownloadedWav(searchDirs, 45000);
      if (foundWav) {
        try {
          if (path.resolve(foundWav) !== path.resolve(finalPath)) {
            await fs.promises.copyFile(foundWav, finalPath);
          }
          recovered = true;
          strategyUsed = 'CHROME_DIRECT_DOWNLOAD';
          console.log(`[DOWNLOAD] Berhasil pulih via scan direktori: ${path.basename(foundWav)}`);
        } catch (copyErr) {
          console.warn(`[DOWNLOAD] Gagal menyalin berkas hasil scan: ${copyErr.message}`);
        }
      }

      if (!recovered) {
        throw new Error(`Seluruh strategi unduhan gagal: ${downloadErr.message}`);
      }
    }
  }

  // VALIDASI BERKAS HASIL
  const stat = await fs.promises.stat(finalPath);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Berkas unduhan kosong atau tidak valid: ${finalPath}`);
  }

  const fileSize = stat.size;
  const elapsedMs = Date.now() - startTime;

  console.log(`[DOWNLOAD] Berhasil: ${(fileSize / 1024).toFixed(1)} KB dalam ${elapsedMs} ms (${strategyUsed})`);

  return {
    path: finalPath,
    filename: path.basename(finalPath),
    url: downloadUrl,
    sizeBytes: fileSize,
    sizeKb: (fileSize / 1024).toFixed(1),
    elapsedMs,
    strategy: strategyUsed
  };
}

/**
 * Unduh dengan mekanisme pengulangan (retry).
 */
async function downloadWithRetry(options, maxRetries = 1) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      if (options.page && options.page.isClosed()) {
        throw new Error('Page telah ditutup, membatalkan retry download.');
      }
      if (attempt > 1) {
        console.log(`[DOWNLOAD] Mencoba ulang akuisisi audio (Percobaan ${attempt}/${maxRetries + 1})...`);
      }
      return await downloadFile(options);
    } catch (error) {
      lastError = error;
      console.error(`[DOWNLOAD] Percobaan ${attempt} gagal: ${error.message}`);
      if (error.message.includes('ENOENT') || error.message.includes('permission denied') || error.message.includes('closed')) {
        break;
      }
      if (attempt <= maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }

  throw lastError;
}

module.exports = {
  sanitizeFilename,
  isWavFile,
  findRecentDownloadedWav,
  extractBaselineBlobUrls,
  isFreshBlob,
  findFreshBlobAudio,
  captureAudioElementsSnapshot,
  findTargetAudioElement,
  extractBlobDirectly,
  downloadFile,
  downloadWithRetry
};
