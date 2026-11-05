const path = require('path');
const fs = require('fs');
const { humanDelay } = require('./human-behavior');
const { formatSpeakerPrompt, splitTextIntoChunks } = require('./tts-text-utils');
const { normalizePillValue, isPillValueMatching, selectVoicePill, dismissPopups } = require('./tts-ui-helpers');
const { TtsSession } = require('./tts-session');
const { renderChunkAudio } = require('./tts-render-chunk');
const { mergeAudioFiles } = require('./audio-converter');

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isBrowserCrash(err) {
  const message = err && err.message ? err.message : '';
  return message.includes('has been closed')
    || message.includes('Target closed')
    || message.includes('browser has been closed')
    || message.includes('crashed');
}

class TtsEngine {
  constructor(options = {}) {
    this.downloadsDir = options.downloadsDir || path.resolve(__dirname, '..', 'downloads');
    this.profilesDir = options.profilesDir || path.resolve(__dirname, '..', 'profiles', 'default');
    this.isBusy = false;

    if (!fs.existsSync(this.downloadsDir)) {
      fs.mkdirSync(this.downloadsDir, { recursive: true });
    }

    // Sesi browser dipakai ulang antar job; ditutup otomatis setelah idle.
    this.session = new TtsSession({
      profilesDir: this.profilesDir,
      downloadsDir: this.downloadsDir,
      idleMs: options.idleMs !== undefined ? options.idleMs : envNumber('SESSION_IDLE_MS', 120000),
      maxJobs: options.maxJobs !== undefined ? options.maxJobs : envNumber('MAX_JOBS_PER_SESSION', 25)
    });
  }

  getStatus() {
    return {
      isBusy: this.isBusy,
      downloadsDirectory: this.downloadsDir,
      sessionAlive: this.session.isAlive(),
      jobsInSession: this.session.jobsInSession,
      sessionIdleMs: this.session.idleMs
    };
  }

  /**
   * Buka browser + halaman AI Studio lebih awal (dipanggil saat service start bila PREWARM_BROWSER=true).
   */
  async warmup() {
    const offscreen = String(process.env.OFFSCREEN ?? 'true').toLowerCase() !== 'false';
    console.log('[TtsEngine] Prewarm: membuka browser + AI Studio...');
    await this.session.warmup({
      offscreen,
      timing: (label, ms) => console.log(`[TIMING] ${label}: ${ms}ms`)
    });
    console.log('[TtsEngine] Prewarm selesai.');
  }

  async shutdown() {
    await this.session.close('shutdown');
  }

  async execute(params, onProgress = () => {}) {
    if (this.isBusy) {
      throw new Error('TtsEngine sedang sibuk memproses pekerjaan lain.');
    }
    this.isBusy = true;
    try {
      return await this._executeJob(params, onProgress);
    } finally {
      this.isBusy = false;
    }
  }

  async _executeJob(params, onProgress = () => {}) {
    const {
      text,
      voice = 'Zephyr',
      style = 'Vocal Smile',
      pace = 'Natural',
      accent = 'Neutral',
      autoChunk = true,
      maxWordsPerChunk = 300,
      // .env OFFSCREEN=false -> jendela Chrome tampil di layar laptop (untuk memantau/mendiagnosis).
      // Default tetap true (disembunyikan di luar layar) agar tidak mengganggu saat produksi.
      offscreen = String(process.env.OFFSCREEN ?? 'true').toLowerCase() !== 'false'
    } = params;

    if (!text || typeof text !== 'string' || !text.trim()) {
      throw new Error('Parameter "text" wajib diisi dan tidak boleh kosong.');
    }

    const chunks = autoChunk ? splitTextIntoChunks(text, maxWordsPerChunk) : [{
      index: 1,
      total: 1,
      text: text.trim(),
      promptText: formatSpeakerPrompt(text),
      wordCount: text.trim().split(/\s+/).length
    }];

    const tJob = Date.now();
    const timings = {};
    const timing = (label, ms) => {
      timings[label] = ms;
      console.log(`[TIMING] ${label}: ${ms}ms`);
    };

    console.log('\n================================================================');
    console.log(`[TtsEngine] Memulai proses TTS (${chunks.length} bagian naskah)...`);
    console.log(`[TtsEngine] Voice: ${voice} | Style: ${style} | Pace: ${pace} | Accent: ${accent}`);
    console.log('================================================================');

    onProgress({
      stage: 'initializing',
      progress: 5,
      currentPart: 0,
      totalParts: chunks.length,
      message: `Menyiapkan peramban Chrome untuk ${chunks.length} bagian naskah...`
    });

    let page = null;

    const prepareSession = async (forceNew = false) => {
      if (forceNew) await this.session.close('retry');
      const tReady = Date.now();
      page = await this.session.ensureReady(params, {
        offscreen,
        onProgress,
        totalChunks: chunks.length,
        timing
      });
      timing('session ready', Date.now() - tReady);
      return page;
    };

    await prepareSession();

    const generatedFiles = [];

    try {
      const totalChunks = chunks.length;
      const progressChunkSlice = 65 / totalChunks;

      for (const chunk of chunks) {
        const chunkBase = 32 + (chunk.index - 1) * progressChunkSlice;

        // Cek apakah browser masih hidup sebelum memproses chunk
        if (page.isClosed()) {
          console.log(`[TtsEngine] Browser crash terdeteksi sebelum bagian ${chunk.index}. Meluncurkan ulang browser...`);
          onProgress({
            stage: 'rendering',
            progress: Math.round(chunkBase),
            currentPart: chunk.index,
            totalParts: totalChunks,
            message: `Meluncurkan ulang browser untuk bagian ${chunk.index}/${totalChunks}...`
          });
          await prepareSession(true);
        }

        let fileData;
        try {
          fileData = await renderChunkAudio(page, chunk, {
            downloadsDir: this.downloadsDir,
            totalChunks,
            chunkBase,
            progressChunkSlice,
            onProgress
          });
        } catch (chunkErr) {
          // Jika browser crash saat rendering/download chunk, coba ulang 1x dengan browser baru
          if (isBrowserCrash(chunkErr)) {
            console.warn(`[TtsEngine] Browser crash saat proses bagian ${chunk.index}. Mencoba ulang dengan browser baru...`);
            onProgress({
              stage: 'rendering',
              progress: Math.round(chunkBase + progressChunkSlice * 0.05),
              currentPart: chunk.index,
              totalParts: totalChunks,
              message: `Browser crash saat bagian ${chunk.index}/${totalChunks}, mencoba ulang...`
            });
            await prepareSession(true);
            fileData = await renderChunkAudio(page, chunk, {
              downloadsDir: this.downloadsDir,
              totalChunks,
              chunkBase,
              progressChunkSlice,
              onProgress
            });
          } else {
            throw chunkErr;
          }
        }

        generatedFiles.push(fileData);

        onProgress({
          stage: 'downloading',
          progress: Math.round(chunkBase + progressChunkSlice),
          currentPart: chunk.index,
          totalParts: totalChunks,
          message: `Berkas audio bagian ${chunk.index}/${totalChunks} berhasil disimpan (${fileData.sizeKb} KB).`
        });

        if (chunk.index < chunk.total) {
          console.log('[TtsEngine] Jeda singkat sebelum bagian berikutnya...');
          await humanDelay(800, 1200);
        }
      }

      console.log('\n================================================================');
      console.log(`[TtsEngine] Semua ${generatedFiles.length} bagian berhasil dibuat!`);
      console.log('================================================================\n');

      let mergedFile = null;
      if (generatedFiles.length > 1) {
        try {
          const firstBase = path.parse(generatedFiles[0].filename).name.replace(/_part\d+$/i, '');
          const mergedFilename = `${firstBase}_merged.mp3`;
          const mergedPath = path.join(this.downloadsDir, mergedFilename);

          onProgress({
            stage: 'merging',
            progress: 96,
            currentPart: totalChunks,
            totalParts: totalChunks,
            message: `Menggabungkan ${generatedFiles.length} bagian audio menjadi 1 berkas MP3...`
          });
          console.log(`[TtsEngine] Menggabungkan ${generatedFiles.length} bagian audio menjadi 1 berkas MP3: ${mergedFilename}...`);

          const tMerge = Date.now();
          await mergeAudioFiles(generatedFiles.map(f => f.filePath), mergedPath);
          timing('merge audio', Date.now() - tMerge);

          if (fs.existsSync(mergedPath)) {
            const mergedStats = fs.statSync(mergedPath);
            mergedFile = {
              filename: mergedFilename,
              filePath: mergedPath,
              downloadUrl: `/api/tts/download/${mergedFilename}`,
              sizeBytes: mergedStats.size,
              sizeKb: (mergedStats.size / 1024).toFixed(1),
              isMerged: true,
              totalParts: generatedFiles.length
            };
            console.log(`[TtsEngine] Penggabungan berhasil: ${mergedFilename} (${mergedFile.sizeKb} KB)`);
          }
        } catch (mergeErr) {
          console.warn(`[TtsEngine] Penggabungan audio otomatis gagal: ${mergeErr.message}`);
        }
      } else if (generatedFiles.length === 1) {
        mergedFile = {
          ...generatedFiles[0],
          isMerged: false
        };
      }

      onProgress({
        stage: 'completed',
        progress: 100,
        currentPart: totalChunks,
        totalParts: totalChunks,
        message: generatedFiles.length > 1
          ? `Semua ${generatedFiles.length} bagian audio berhasil dibuat dan digabungkan menjadi 1 file MP3 utuh.`
          : `Berkas audio berhasil dibuat dan siap diunduh.`
      });

      // Browser TIDAK ditutup di sini: sesi dipakai ulang oleh job berikutnya dan
      // ditutup otomatis setelah SESSION_IDLE_MS tidak ada aktivitas.
      this.session.noteJobDone();
      if (params.keepOpen || process.env.KEEP_BROWSER_OPEN === 'true') {
        this.session.holdOpen();
        console.log('[TtsEngine] Browser dibiarkan terbuka (KEEP_BROWSER_OPEN aktif).');
      } else {
        console.log(`[TtsEngine] Browser dipertahankan untuk job berikutnya (idle ${Math.round(this.session.idleMs / 1000)}s).`);
      }

      const totalMs = Date.now() - tJob;
      const partTotals = generatedFiles.reduce((acc, file) => {
        const part = file.timings || {};
        acc.renderMs += part.renderMs || 0;
        acc.downloadMs += part.downloadMs || 0;
        acc.convertMs += part.convertMs || 0;
        return acc;
      }, { renderMs: 0, downloadMs: 0, convertMs: 0 });
      console.log(`[TIMING] total job: ${totalMs}ms | setup=${timings['session ready'] || 0}ms | render=${partTotals.renderMs}ms | download=${partTotals.downloadMs}ms | convert=${partTotals.convertMs}ms`);

      return {
        success: true,
        message: generatedFiles.length > 1
          ? `Audio berhasil di-generate (${generatedFiles.length} bagian) dan digabungkan menjadi 1 berkas MP3 utuh.`
          : 'Audio berhasil di-generate dan diunduh.',
        totalChunks: chunks.length,
        voiceSettings: { voice, style, pace, accent },
        mergedFile,
        files: generatedFiles,
        timings: { ...timings, totalMs }
      };

    } catch (error) {
      console.error('[TtsEngine] Terjadi kesalahan:', error.message);
      try {
        if (page && !page.isClosed()) {
          const errorScreenshot = path.join(this.downloadsDir, `error_screenshot_${Date.now()}.png`);
          await page.screenshot({ path: errorScreenshot, fullPage: true }).catch(() => {});
          console.log(`[TtsEngine] Screenshot kesalahan telah disimpan ke: ${errorScreenshot}`);
        }
      } catch (sErr) {}

      // Kuota habis atau browser mati: mulai sesi baru pada job berikutnya.
      if (error.code === 'QUOTA_EXCEEDED' || !page || page.isClosed()) {
        await this.session.close(error.code === 'QUOTA_EXCEEDED' ? 'quota' : 'error');
      } else {
        this.session.invalidateVoice();
      }

      throw error;
    }
  }
}

module.exports = {
  TtsEngine,
  splitTextIntoChunks,
  formatSpeakerPrompt,
  normalizePillValue,
  isPillValueMatching,
  selectVoicePill,
  dismissPopups
};
