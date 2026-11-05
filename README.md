# AI Studio TTS Playwright - Stealth Recorder & Automation Studio

Aplikasi Playwright modern dengan antarmuka web dan CLI untuk merekam langkah browser secara manual menggunakan **Google Chrome bawaan Windows**, dengan fitur **Auto-Save instan** dan proteksi **Anti-Bot Stealth** (lolos Cloudflare, Datadome, Akamai, dan bot detector lainnya).

---

## 🌟 Fitur Utama

1. **Google Chrome Bawaan Windows**
   - Menggunakan executable Chrome asli yang terpasang di sistem (`C:\Program Files\Google\Chrome\Application\chrome.exe` atau `channel: chrome`).
   - Bukan chromium bundle standar.

2. **Anti-Bot & Stealth Engine**
   - Integrasi `playwright-extra` + `puppeteer-extra-plugin-stealth`.
   - Menghapus flag otomatisasi `--enable-automation` dan banner *"Chrome is being controlled by automated test software"*.
   - Menyetel flag `--disable-blink-features=AutomationControlled`.
   - `navigator.webdriver = undefined` / `false`.
   - Mendukung **Persistent Profile** (`./profiles/default`) sehingga cookies, sesi login, dan cache tersimpan seperti browser manusia biasa, memberikan *trust score* tinggi di sistem anti-bot.

3. **Perekaman Langkah Manual Real-Time (Live Action Recorder)**
   - Injeksi pelacak interaksi cerdas:
     - **Click** & **Double Click**
     - **Input / Typing** (dengan debouncing cerdas sehingga mengetik 10 karakter tidak direkam sebagai 10 langkah terpisah, melainkan 1 langkah `fill` utuh)
     - **Keydown** (`Enter`, `Tab`, `Escape`)
     - **Dropdown Select**
     - **Navigasi URL** (perpindahan halaman / frame navigation)
     - **Scroll window**
   - Smart Selector Generator: Memprioritaskan `data-testid`, `id`, `name`, `placeholder`, `aria-label`, text content, lalu ke CSS path unik.
   - Dilengkapi **Floating HUD** di sudut kanan bawah browser (`🔴 AuStudio Recording...`) untuk memantau status secara live.

4. **Auto-Save Instan ke File**
   - Setiap kali Anda melakukan interaksi di Chrome, detik itu juga langkah akan langsung ditulis ke disk di folder `recordings/<nama_sesi>/`:
     - `steps.json` : Riwayat langkah dalam format JSON terstruktur.
     - `script.js` : Script Playwright executable mandiri dengan stealth engine aktif.
     - `test.spec.js` : Format Playwright Test (`@playwright/test`).
   - Jika Chrome tertutup mendadak atau listrik padam, seluruh langkah yang sudah dilakukan tetap 100% aman tersimpan.

5. **Web Studio & Control Panel (Dashboard Modern)**
   - Akses via `http://localhost:3740`.
   - Desain modern dark mode dengan aksen glowing.
   - Live stream langkah yang terekam via WebSocket.
   - Tab kode Playwright dengan syntax preview dan tombol salin.
   - Tombol **Replay Script** untuk memutar ulang alur yang telah direkam langsung dari dashboard dengan visual progress bar.

---

## 🚀 Alur Kerja Paling Praktis (Tinggal Klik 2x)

### Langkah 1: Login & Simpan Sesi (Hanya Dilakukan Sekali)
Cukup **klik 2x**:
👉 **`open-browser.bat`** (atau `npm run open-browser`)
- Google Chrome Windows asli Anda akan terbuka di `https://aistudio.google.com/`.
- Silakan login dengan akun Google Anda secara normal, selesaikan 2FA/verifikasi.
- Setelah berhasil login ke halaman utama, kembali ke jendela hitam dan tekan **ENTER**.
- Seluruh session login, cookies, dan auth token akan **tersimpan permanen** di `profiles/default_storage_state.json`.

---

### Langkah 2: Rekam Alur Automasi Murni (Bebas dari Langkah Login)
Setelah sesi tersimpan, kapan saja Anda ingin merekam langkah baru, cukup **klik 2x**:
👉 **`npm run record`** (atau `node cli.js`)
- Google Chrome akan terbuka **dalam keadaan SUDAH LOGIN** otomatis menggunakan sesi dari Langkah 1.
- **Langkah login TIDAK AKAN PERNAH direkam ke dalam script** (URL `accounts.google.com`, password, dan tombol login otomatis difilter/diabaikan).
- Anda hanya perlu merekam aksi aplikasi (misal: memilih template TTS, mengetik naskah suara, memilih voice, dan klik generate).
- Setiap aksi langsung ter-auto-save ke folder `recordings/<nama_sesi>/`.
- Tekan **ENTER** di terminal atau tutup Chrome jika sudah selesai.

---

### Langkah 3: Auto-Run Test Hasil Rekaman (Otomatis Generate & Download)
Untuk menguji dan memastikan seluruh langkah berjalan otomatis dari awal sampai akhir via REST API:
Cukup **klik 2x**:
👉 **`npm run test:api`** (atau `test.bat`)
- Menguji endpoint REST API TTS (`/api/tts/jobs`) secara live.
- Memantau progres job hingga selesai dan memverifikasi file audio MP3 (192 kbps) terunduh di folder `downloads/`.

### 📦 Layanan REST API Gemini TTS (Arsitektur Asynchronous Jobs):
Server REST API lokal yang menyediakan pembuatan suara sintetis Gemini 2.5 Pro TTS dengan **Teknik Jobs (Asynchronous Job Queue)**:
- Menghindari kendala HTTP timeout untuk render audio durasi lama / multi-chunk.
- **Auto-Chunking & Auto-Merging**: Naskah panjang (>300 kata) otomatis dipecah menjadi beberapa bagian, diproses secara andal, dan otomatis digabungkan menjadi **1 berkas audio MP3 utuh** (`mergedFile`).
- **Konversi Otomatis MP3 192 kbps**: Hasil render WAV dari AI Studio langsung dikonversi ke format MP3 berkualitas tinggi secara native tanpa window popup.
- Memberikan respons instan `202 Accepted` dengan `jobId` dan `statusUrl`.
- Pelacakan progres live `0% - 100%` (`initializing` ➔ `configuring` ➔ `rendering` ➔ `downloading` ➔ `merging`).
- Dukungan WebSocket live broadcasting untuk web dashboard.
- Endpoint utama:
  - `POST /api/tts/jobs` — Submit tugas TTS baru (Async Job).
  - `GET /api/tts/jobs/:id` — Cek status & ambil berkas audio.
  - `GET /api/tts/jobs/:id/audio` — Stream / unduh langsung 1 file audio utuh.
  - `GET /api/tts/jobs` — Riwayat & statistik antrian.
  - `DELETE /api/tts/jobs/:id` — Batalkan tugas yang sedang antre.
  - `POST /api/tts/generate` — Endpoint fleksibel (dukung `?sync=true` atau mode jobs).
- Konfigurasi `.env`: `PORT`, `API_KEY`, dan `OFFSCREEN` (`false` = jendela Chrome tampil di layar untuk memantau proses; `true` = disembunyikan). Detail: [API_DOCUMENTATION.md](API_DOCUMENTATION.md).
- Untuk dokumentasi lengkap dan contoh kode (Node.js, Python, PowerShell, cURL), baca [API_DOCUMENTATION.md](API_DOCUMENTATION.md).

Untuk menjalankan server API:
Cukup klik 2x 👉 **`start-server.bat`** (atau jalankan `npm start`).

---

### Opsi Tambahan (Action Recorder):
- Jika sewaktu-waktu Anda ingin melihat antarmuka visual / dashboard web, jalankan server lalu buka `http://localhost:3740`.
Jalankan perintah berikut di terminal:
```bash
npm start
```
Buka browser di:
👉 **[http://localhost:3740](http://localhost:3740)**

Langkah-langkah merekam via Web UI:
1. Masukkan nama sesi (contoh: `my_flow_1`).
2. Masukkan URL awal (contoh: `https://bot.sannysoft.com` atau web target Anda).
3. Klik **"Mulai Rekam Manual"**.
4. Jendela Google Chrome asli Windows Anda akan terbuka dengan proteksi stealth.
5. Lakukan interaksi (klik, ketik form, login, dll.).
6. Di halaman dashboard, setiap aksi akan langsung muncul di tabel dan langsung ter-auto-save ke file disk.
7. Klik **"Stop & Selesai"** saat selesai merekam.
8. Anda bisa langsung mengklik **"▶ Replay Script"** untuk memutar ulang rekaman tersebut secara otomatis.

---

### 2. Menjalankan via CLI (Terminal)
Jika ingin merekam cepat langsung dari terminal tanpa web dashboard:
```bash
npm run record [URL_TARGET] [NAMA_SESI]
```
Contoh:
```bash
npm run record https://bot.sannysoft.com test_sannysoft
```
Tekan `[ENTER]` di terminal jika sudah selesai merekam.

---

### 3. Menjalankan Script Hasil Rekaman Secara Mandiri
Setiap sesi rekaman menghasilkan file `script.js` yang bisa Anda jalankan kapan saja tanpa ketergantungan pada dashboard:
```bash
node recordings/<nama_sesi>/script.js
```

---

### 4. Menjalankan Uji Otomasi (Test Suite)
Untuk memverifikasi integrasi anti-bot dan deteksi Chrome Windows:
```bash
npm run test:stealth
```

---

## 📁 Struktur Direktori
```
aistudiotts-playwright/
├── public/                 # Frontend Web Studio Dashboard
│   ├── index.html          # HTML antarmuka dashboard
│   ├── style.css           # Styling modern dark mode
│   └── app.js              # Controller logika Web & WebSocket
├── src/                    # Backend & Core Engine
│   ├── stealth-browser.js  # Peluncur Chrome Windows + anti-bot stealth
│   ├── injected-recorder.js# Script injeksi pelacak event di browser & HUD
│   ├── code-generator.js   # Generator kode Playwright mandiri
│   ├── recorder-engine.js  # Manajemen sesi perekaman & Auto-Save instan
│   ├── runner.js           # Mesin pemutar ulang (replay) script rekaman
│   └── server.js           # Server Express & WebSocket
├── recordings/             # Folder hasil rekaman yang otomatis tersimpan
│   └── <nama_sesi>/
│       ├── steps.json      # Log langkah JSON
│       ├── script.js       # Script Node.js Playwright runnable
│       └── test.spec.js    # Script Playwright Test runner
├── profiles/               # Direktori profil Chrome persisten (cookies, login)
├── test/                   # Test suite (stealth & e2e)
├── cli.js                  # Entry point CLI
└── package.json
```
