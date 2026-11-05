const { humanClick, humanPaste, humanDelay } = require('./human-behavior');
const { dismissPopups, selectVoicePill } = require('./tts-ui-helpers');

const VOICE_ALIASES = {
  'zhepyr': 'Zephyr',
  'zepir': 'Zephyr',
  'zephir': 'Zephyr',
};

const OFFICIAL_VOICES = [
  'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Zephyr', 'Aoede',
  'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
  'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat', 'Capella', 'Enif'
];

function normalizeVoiceName(name) {
  if (!name || typeof name !== 'string') return name;
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  if (VOICE_ALIASES[lower]) {
    console.log(`[TtsEngine] Normalisasi nama suara: "${name}" -> "${VOICE_ALIASES[lower]}"`);
    return VOICE_ALIASES[lower];
  }
  const matched = OFFICIAL_VOICES.find((v) => v.toLowerCase() === lower);
  if (matched) return matched;

  const prefixMatch = OFFICIAL_VOICES.find((v) => lower.startsWith(v.toLowerCase()));
  if (prefixMatch) return prefixMatch;

  const containedMatch = OFFICIAL_VOICES.find((v) => lower.includes(v.toLowerCase()));
  if (containedMatch) return containedMatch;

  return trimmed;
}

const HARDCODED_SCENE = 'A modern content creator studio. Casual, well-lit, and energetic atmosphere.';
const HARDCODED_SAMPLE_CONTEXT = 'TikTok educational content. Fast-paced, punchy, conversational, and engaging. Direct address to the audience with curious questioning at the start and a clear, satisfying explanation.';
const HARDCODED_PERSONA = 'A relaxed, friendly young adult hanging out with close friends. Warm, casual, and natural conversational cadence.';

const STUDIO_URL = 'https://aistudio.google.com/generate-speech?model=gemini-2.5-pro-preview-tts';

/**
 * Tahap 1 - cukup dijalankan SEKALI per sesi browser:
 * buka AI Studio, pilih template, beralih ke Text Mode, isi Scene & Sample Context.
 *
 * Dipisahkan dari pengaturan suara supaya job berikutnya tidak perlu mengulang
 * navigasi + pemilihan template (bagian termahal dari waktu setup).
 *
 * @param {import('playwright').Page} page
 * @param {Function} onProgress
 * @param {number} totalChunks
 */
async function openStudioPage(page, onProgress = () => {}, totalChunks = 1) {
  onProgress({
    stage: 'initializing',
    progress: 15,
    currentPart: 0,
    totalParts: totalChunks,
    message: 'Membuka Google AI Studio Gemini TTS...'
  });
  console.log('[TtsEngine] Membuka Google AI Studio...');
  await page.goto(STUDIO_URL, { waitUntil: 'domcontentloaded' });
  await humanDelay(800, 1200);

  // Tangani kemungkinan modal popup sambutan / promo Google AI Studio
  await dismissPopups(page);
  await humanDelay(200, 400);
  await dismissPopups(page);

  // Pilih template
  onProgress({
    stage: 'configuring',
    progress: 22,
    currentPart: 0,
    totalParts: totalChunks,
    message: 'Memilih template suara...'
  });
  console.log('[TtsEngine] Memilih template "The Master Storyteller"...');
  const templateSelector = 'mat-card[aria-label*="The Master Storyteller"], mat-card:has-text("The Master Storyteller"), [aria-label*="The Master Storyteller" i], mat-card[aria-label*="The Patient Teacher"], mat-card:has-text("The Patient Teacher")';
  await humanClick(page, templateSelector).catch(() => {});
  await humanDelay(600, 900);

  // Switch ke Text Mode
  onProgress({
    stage: 'configuring',
    progress: 25,
    currentPart: 0,
    totalParts: totalChunks,
    message: 'Beralih ke Text Mode & mengatur konteks adegan...'
  });
  console.log('[TtsEngine] Beralih ke Text Mode...');
  const textTab = page.locator('button:has-text("edit_noteText"), button:has-text("Text"), [aria-label*="Text" i]').first();
  await textTab.click({ force: true }).catch(() => {});
  await humanDelay(500, 700);

  // Paste contexts
  await dismissPopups(page);
  await humanPaste(page, 'textarea[aria-label="Scene"]', HARDCODED_SCENE);
  await humanDelay(250, 450);
  await humanPaste(page, 'textarea[aria-label="Sample Context"]', HARDCODED_SAMPLE_CONTEXT);
  await humanDelay(300, 500);
}

/**
 * Tahap 2 - hanya dijalankan bila voice/style/pace/accent berubah:
 * buka panel voice settings, isi persona, pilih pill (Style/Pace/Accent) dan karakter suara.
 *
 * @param {import('playwright').Page} page
 * @param {Object} params
 * @param {Function} onProgress
 * @param {number} totalChunks
 */
async function applyVoiceSettings(page, params, onProgress = () => {}, totalChunks = 1) {
  const {
    voice = 'Zephyr',
    style = 'Vocal Smile',
    pace = 'Natural',
    accent = 'Neutral'
  } = params;

  const targetVoice = normalizeVoiceName(voice);

  onProgress({
    stage: 'configuring',
    progress: 30,
    currentPart: 0,
    totalParts: totalChunks,
    message: `Mengatur karakter suara (${voice}, ${style}, ${pace}, ${accent})...`
  });
  console.log('[TtsEngine] Mengatur karakter suara...');

  const voiceTrigger = page.locator('button[aria-label="Open voice settings"], button:has-text("Zephyr"), button:has-text("Achernar"), button:has-text("Speaker 1"), .speaker-voice-trigger, [aria-label*="voice settings" i], [aria-label*="Voice" i]').first();
  if (!(await voiceTrigger.isVisible({ timeout: 4000 }).catch(() => false))) {
    console.warn('[TtsEngine] Tombol voice settings tidak ditemukan; memakai pengaturan yang sudah ada.');
    return;
  }

  await voiceTrigger.click({ force: true });
  await humanDelay(400, 600);

  // Isi Persona jika tersedia
  if (HARDCODED_PERSONA) {
    console.log('[TtsEngine] Mengisi voice persona...');
    const personaSelector = 'textarea[placeholder*="Describe the voice persona" i], textarea[placeholder*="voice persona" i]';
    const personaField = page.locator(personaSelector).first();
    if (await personaField.isVisible({ timeout: 2500 }).catch(() => false)) {
      await humanPaste(page, personaSelector, HARDCODED_PERSONA);
      await humanDelay(250, 400);
    }
  }

  // Atur Voice Settings Pill (Style, Pace, Accent) dengan verifikasi postcondition
  if (style) await selectVoicePill(page, 'Style', style);
  if (pace) await selectVoicePill(page, 'Pace', pace);
  if (accent) await selectVoicePill(page, 'Accent', accent);

  // Pilih Voice (prioritaskan pencarian lewat input Search voices)
  if (targetVoice) {
    console.log(`[TtsEngine] Memilih karakter suara: ${targetVoice}...`);
    const searchInput = page.locator('input[aria-label="Search voices"], input[placeholder*="Search voices" i]').first();
    if (await searchInput.isVisible({ timeout: 2500 }).catch(() => false)) {
      await humanPaste(page, 'input[aria-label="Search voices"]', targetVoice.toLowerCase());
      await humanDelay(250, 400);
    }

    const voiceCard = page.locator(`button[aria-label="${targetVoice}" i], button[aria-label*="${targetVoice}" i], button:has-text("${targetVoice}"), div.voice-card:has-text("${targetVoice}")`).first();
    if (await voiceCard.isVisible({ timeout: 3000 }).catch(() => false)) {
      await voiceCard.scrollIntoViewIfNeeded().catch(() => {});
      await voiceCard.click({ force: true });
      await humanDelay(350, 550);
      console.log(`[TtsEngine] Suara ${targetVoice} dipilih.`);
    } else {
      console.warn(`[TtsEngine] Suara ${targetVoice} tidak ditemukan.`);
    }
  }

  // Tutup panel
  const closeBtn = page.locator('button[aria-label="Close panel"], button[aria-label="Close"], button:has(span:has-text("close"))').first();
  if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await closeBtn.click();
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }
  await humanDelay(400, 600);
}

/**
 * Kompatibilitas: jalankan kedua tahap sekaligus (dipakai bila sesi selalu baru).
 * @param {import('playwright').Page} page
 * @param {Object} params
 * @param {Function} onProgress
 * @param {number} totalChunks
 */
async function setupTtsStudio(page, params, onProgress, totalChunks) {
  await openStudioPage(page, onProgress, totalChunks);
  await applyVoiceSettings(page, params, onProgress, totalChunks);
}

module.exports = {
  setupTtsStudio,
  openStudioPage,
  applyVoiceSettings,
  normalizeVoiceName,
  OFFICIAL_VOICES
};
