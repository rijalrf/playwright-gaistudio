/**
 * Sesi browser TTS yang dipakai ulang antar job.
 *
 * Sebelumnya setiap job membuka Chrome baru, memuat AI Studio, memilih template, dan
 * mengatur voice dari nol (+- 2 menit). Dengan sesi ini, browser + halaman dibiarkan
 * hidup sebentar (idle) sehingga job berikutnya tinggal tempel naskah -> RUN -> unduh.
 *
 * Sesi otomatis ditutup setelah SESSION_IDLE_MS tidak ada job, atau didaur ulang
 * setiap MAX_JOBS_PER_SESSION job agar state halaman AI Studio tetap segar.
 */

const { launchStealthChrome } = require('./stealth-browser');
const { openStudioPage, applyVoiceSettings } = require('./tts-studio-config');

function signatureOf(params = {}) {
  return [
    params.voice || 'Zephyr',
    params.style || 'Vocal Smile',
    params.pace || 'Natural',
    params.accent || 'Neutral'
  ].join('|');
}

class TtsSession {
  constructor({ profilesDir, downloadsDir, headless = false, idleMs = 120000, maxJobs = 25 } = {}) {
    this.profilesDir = profilesDir;
    this.downloadsDir = downloadsDir;
    this.headless = headless;
    this.idleMs = Number(idleMs) >= 0 ? Number(idleMs) : 120000;
    this.maxJobs = Number(maxJobs) > 0 ? Number(maxJobs) : 25;

    this.context = null;
    this.page = null;
    this.signature = null;
    this.jobsInSession = 0;
    this.idleTimer = null;
  }

  isAlive() {
    return Boolean(this.context && this.page && !this.page.isClosed());
  }

  _clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  async _launch(offscreen) {
    const result = await launchStealthChrome({
      userDataDir: this.profilesDir,
      downloadsPath: this.downloadsDir,
      headless: this.headless,
      offscreen: Boolean(offscreen)
    });

    this.context = result.context;
    this.page = this.context.pages().length > 0 ? this.context.pages()[0] : await this.context.newPage();
    this.page.setDefaultTimeout(40000);
    this.signature = null;
    this.jobsInSession = 0;

    this.context.once('close', () => {
      this.context = null;
      this.page = null;
      this.signature = null;
      this.jobsInSession = 0;
      this._clearIdleTimer();
    });

    return this.page;
  }

  /**
   * Pastikan browser + halaman AI Studio siap untuk params tertentu.
   * Navigasi/template hanya dilakukan saat sesi baru; pengaturan suara hanya saat berubah.
   */
  async ensureReady(params, { offscreen = true, onProgress = () => {}, totalChunks = 1, timing } = {}) {
    this._clearIdleTimer();

    const recycle = this.jobsInSession >= this.maxJobs;
    if (!this.isAlive() || recycle) {
      if (this.context) await this.close(recycle ? 'recycle' : 'stale');
      const tLaunch = Date.now();
      await this._launch(offscreen);
      if (timing) timing('launch browser', Date.now() - tLaunch);

      const tOpen = Date.now();
      await openStudioPage(this.page, onProgress, totalChunks);
      if (timing) timing('open AI Studio', Date.now() - tOpen);
    }

    const signature = signatureOf(params);
    if (signature !== this.signature) {
      const tVoice = Date.now();
      await applyVoiceSettings(this.page, params, onProgress, totalChunks);
      if (timing) timing('voice settings', Date.now() - tVoice);
      this.signature = signature;
    } else {
      console.log('[TtsEngine] Pengaturan suara sama dengan sesi sebelumnya, dilewati.');
    }

    return this.page;
  }

  /**
   * Buka browser + halaman AI Studio lebih awal (tanpa pengaturan suara).
   */
  async warmup({ offscreen = true, onProgress = () => {}, totalChunks = 1, timing } = {}) {
    this._clearIdleTimer();
    if (this.isAlive()) return this.page;

    if (this.context) await this.close('warmup-restart');
    const tLaunch = Date.now();
    await this._launch(offscreen);
    if (timing) timing('prewarm launch', Date.now() - tLaunch);

    const tOpen = Date.now();
    await openStudioPage(this.page, onProgress, totalChunks);
    if (timing) timing('prewarm open AI Studio', Date.now() - tOpen);

    this.touch();
    return this.page;
  }

  noteJobDone() {
    this.jobsInSession += 1;
    this.touch();
  }

  /**
   * Jadwalkan penutupan browser setelah tidak ada aktivitas.
   */
  touch() {
    this._clearIdleTimer();
    if (!this.idleMs) return;

    this.idleTimer = setTimeout(() => {
      this.close('idle').catch(() => {});
    }, this.idleMs);

    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  /**
   * Pertahankan browser tetap terbuka (KEEP_BROWSER_OPEN).
   */
  holdOpen() {
    this._clearIdleTimer();
  }

  /**
   * Tandai pengaturan suara perlu diterapkan ulang pada job berikutnya.
   */
  invalidateVoice() {
    this.signature = null;
  }

  async close(reason = 'manual') {
    this._clearIdleTimer();
    const ctx = this.context;
    this.context = null;
    this.page = null;
    this.signature = null;
    this.jobsInSession = 0;

    if (ctx) {
      await ctx.close().catch(() => {});
      console.log(`[TtsEngine] Sesi browser ditutup (${reason}).`);
    }
  }
}

module.exports = { TtsSession, signatureOf };
