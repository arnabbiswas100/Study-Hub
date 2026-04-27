require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { testConnection } = require('./config/database');
const routes = require('./routes/index');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const { cleanupOrphanedFiles } = require('./controllers/pdfController');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Security Headers ─────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      frameSrc: ["'self'", "blob:"],
      workerSrc: ["'self'", "blob:"],
      objectSrc: ["'self'", "blob:"],
    }
  }
}));

// ── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000'];

app.use(cors({
  origin: process.env.NODE_ENV === 'development' ? true : allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ── Rate Limiting ─────────────────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { success: false, error: 'Too many requests, please try again later' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'Too many login attempts, please try again later' }
});

// Auth routes get strict limiter only — not counted against general quota
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// All other API routes get the lenient limiter
app.use('/api/', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  return generalLimiter(req, res, next);
});

// ── Body Parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Logging ───────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'development' ? 'dev' : 'combined'));
}

// ── Static Frontend ───────────────────────────────────────────────────────────
// In production: serve from dist/ (Vite build output)
// In development: serve from frontend/ (raw source — used when running backend only)
const distDir     = path.join(__dirname, '../dist');
const frontendDir = path.join(__dirname, '../frontend');
const fs          = require('fs');
const staticDir   = (process.env.NODE_ENV === 'production' && fs.existsSync(distDir))
  ? distDir
  : frontendDir;

app.use(express.static(staticDir, {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0
}));

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api', routes);

// ── Frontend Routing (SPA fallback) ───────────────────────────────────────────
app.get('*', (req, res) => {
  // Don't catch API routes
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, error: 'API route not found' });
  }
  res.sendFile(path.join(staticDir, 'index.html'));
});

// ── Error Handling ────────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);


// ── Periodic Reconciliation Scheduler ─────────────────────────────────────────
// Runs the same self-healing cleanup on a timer so long-running servers
// (weeks/months uptime) don't accumulate orphaned files or stale DB records.
let cleanupTimer = null;

const startPeriodicCleanup = (uploadDir) => {
  const intervalHours = parseInt(process.env.CLEANUP_INTERVAL_HOURS, 10) || 6;
  const intervalMs = intervalHours * 60 * 60 * 1000;

  console.log(`[Scheduler] Periodic reconciliation set to every ${intervalHours}h`);

  cleanupTimer = setInterval(async () => {
    console.log(`\n[Scheduler] Running periodic reconciliation (every ${intervalHours}h)...`);
    await cleanupOrphanedFiles(uploadDir);
  }, intervalMs);

  // Don't let the timer keep Node alive if everything else shuts down
  if (cleanupTimer.unref) cleanupTimer.unref();
};

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
const gracefulShutdown = (signal) => {
  console.log(`\n[Shutdown] Received ${signal}, cleaning up...`);
  if (cleanupTimer) clearInterval(cleanupTimer);
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ── Startup ───────────────────────────────────────────────────────────────────
const start = async () => {
  console.log('\n Starting Study-Hub...\n');

  const dbOk = await testConnection();
  if (!dbOk) {
    console.error('\nERROR: Cannot start without database. Check your .env configuration.\n');
    process.exit(1);
  }

  // Auto-run schema on every boot (CREATE TABLE IF NOT EXISTS — safe to re-run)
  try {
    const fs   = require('fs');
    const path = require('path');
    const { pool } = require('./config/database');
    const schema = fs.readFileSync(path.join(__dirname, './config/schema.sql'), 'utf-8');
    await pool.query(schema);
    console.log(' Schema applied successfully');
  } catch (err) {
    console.error(' Schema apply failed:', err.message);
    process.exit(1);
  }

  // Clean up orphaned files and stale DB records (startup)
  const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads/pdfs');
  await cleanupOrphanedFiles(uploadDir);

  // Schedule periodic reconciliation while server is running
  startPeriodicCleanup(uploadDir);

  app.listen(PORT, () => {
    console.log(`\nSUCCESS: Study-Hub running at http://localhost:${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   API Base: http://localhost:${PORT}/api\n`);
  });
};

start().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

module.exports = app;
