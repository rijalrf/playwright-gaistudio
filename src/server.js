const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { RecorderEngine } = require('./recorder-engine');
const { ScriptRunner } = require('./runner');
const { findWindowsChromePath } = require('./stealth-browser');
const { DEFAULT_API_KEY, apiKeyAuth } = require('./auth');
const { TtsEngine } = require('./tts-engine');
const { JobManager } = require('./job-manager');
const { createTtsRouter } = require('./routes/tts-routes');
const { createRecorderRouter } = require('./routes/recorder-routes');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3740;

process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] Server uncaughtException:', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[CRITICAL] Server unhandledRejection:', reason?.message || reason);
});

app.use(express.json());
app.use(express.static(path.resolve(__dirname, '..', 'public')));

const recorder = new RecorderEngine();
const runner = new ScriptRunner();
const ttsEngine = new TtsEngine();
const jobManager = new JobManager();

jobManager.setWorker(async (params, onProgress) => {
  return await ttsEngine.execute(params, onProgress);
});

// Opsional: buka browser + AI Studio lebih awal supaya job pertama tidak cold-start.
if (String(process.env.PREWARM_BROWSER || '').toLowerCase() === 'true') {
  console.log('[Server] PREWARM_BROWSER=true, membuka browser lebih awal...');
  ttsEngine.warmup().catch((err) => console.warn('[Server] Prewarm browser gagal:', err.message));
}

// Pastikan Chrome tidak tertinggal saat service dihentikan (sesi browser dipakai ulang antar job).
async function closeBrowserSession() {
  await ttsEngine.shutdown().catch(() => {});
}

['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, async () => {
    console.log(`[Server] Menerima ${signal}, menutup sesi browser...`);
    await closeBrowserSession();
    process.exit(0);
  });
});

function getBaseUrl(req) {
  const host = req.get('host') || `localhost:${PORT}`;
  const protocol = req.protocol || 'http';
  return `${protocol}://${host}`;
}

function broadcast(type, data) {
  const payload = JSON.stringify({ type, data });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

recorder.onEvent((type, payload) => broadcast(`recorder_${type}`, payload));
runner.onEvent((type, payload) => broadcast(type, payload));

jobManager.on('job:created', (job) => broadcast('job_created', job));
jobManager.on('job:started', (job) => broadcast('job_started', job));
jobManager.on('job:progress', (job) => broadcast('job_progress', job));
jobManager.on('job:completed', (job) => broadcast('job_completed', job));
jobManager.on('job:failed', (job) => broadcast('job_failed', job));
jobManager.on('job:cancelled', (job) => broadcast('job_cancelled', job));

// Health Check
app.get(['/health', '/api/health'], (req, res) => {
  res.json({
    status: 'ok',
    service: 'Google AI Studio TTS API',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    authRequired: true,
    jobs: jobManager.getStats(),
    ttsEngine: {
      isBusy: ttsEngine.isBusy || jobManager.isProcessing,
      queueLength: jobManager.queue.length
    }
  });
});

// System Status
app.get('/api/status', (req, res) => {
  res.json({
    chromePath: findWindowsChromePath(),
    recorder: recorder.getStatus(),
    runner: {
      isRunning: runner.isRunning,
      currentStep: runner.currentStep,
      totalSteps: runner.totalSteps
    }
  });
});

// Mount modular sub-routers
const ttsRouter = createTtsRouter({ jobManager, ttsEngine, getBaseUrl });
app.use('/api/tts', ttsRouter);
app.use('/', ttsRouter);
app.use('/api', createRecorderRouter({ recorder, runner }));

// Graceful Shutdown Endpoint for local runner
app.post('/shutdown', apiKeyAuth, (req, res) => {
  const remote = req.socket.remoteAddress || '';
  const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (!isLoopback) {
    return res.status(403).json({ error: 'Shutdown hanya diizinkan dari localhost.' });
  }
  res.status(202).json({ status: 'shutting_down' });
  res.once('finish', () => {
    console.log('[Server] Permintaan shutdown diterima dari local runner. Menghentikan service...');
    server.close(async () => {
      await closeBrowserSession();
      process.exit(0);
    });
  });
});

function startServer(port) {
  const srv = server.listen(port, () => {
    console.log('====================================================');
    console.log('Google AI Studio TTS - Playwright Automation Server');
    console.log(`URL: http://localhost:${port}`);
    console.log(`API Key Auth: Aktif (${process.env.API_KEY || process.env.AUSTUDIO_API_KEY ? 'Custom Key' : 'Default Key: ' + DEFAULT_API_KEY})`);
    console.log(`TTS Jobs Endpoint: POST http://localhost:${port}/api/tts/jobs`);
    console.log(`TTS Jobs Status:   GET  http://localhost:${port}/api/tts/jobs/:id`);
    console.log('Stealth Engine: Aktif (Anti-bot detection bypass)');
    console.log(`Windows Chrome: ${findWindowsChromePath() || 'channel: chrome'}`);
    console.log('====================================================');
  });

  srv.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[Server] Port ${port} sedang digunakan, mencoba port ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('[Server] Fatal listen error:', err);
    }
  });
}

if (require.main === module) {
  startServer(Number(PORT) || 3740);
}

module.exports = { app, server, startServer, jobManager, ttsEngine };
