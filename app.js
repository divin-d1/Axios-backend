const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

// Import routes
const companyRoutes = require('./src/routes/companyRoutes');
const jobRoutes = require('./src/routes/jobRoutes');
const candidateRoutes = require('./src/routes/candidateRoutes');
const screeningRoutes = require('./src/routes/screeningRoutes');
const emailRoutes = require('./src/routes/emailRoutes');
const dashboardRoutes = require('./src/routes/dashboardRoutes');
const authRoutes = require('./src/routes/authRoutes');
const configRoutes = require('./src/routes/configRoutes');
const companySetupRoutes = require('./src/routes/companySetupRoutes');

// Import middleware
const { errorHandler, notFound } = require('./src/middlewares/errorHandler');
const { protect } = require('./src/middlewares/auth');

const app = express();

// Trust proxy for Render deployment rate-limiting
app.set('trust proxy', 1);

// ─── Security Middleware ───────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// ─── CORS ──────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─── Rate Limiting ─────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// ─── Body Parsing ──────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Logging ───────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}



// ─── API Routes ────────────────────────────────────────────────
// Public routes (no auth required)
app.use('/api/auth', authRoutes);
app.use('/api/config', configRoutes);

// Company setup (protected internally)
app.use('/api/company', companySetupRoutes);

// Protected routes (require valid JWT)
app.use('/api/companies', protect, companyRoutes);
app.use('/api/jobs', protect, jobRoutes);
app.use('/api/candidates', protect, candidateRoutes);
app.use('/api/screening', protect, screeningRoutes);
app.use('/api/emails', protect, emailRoutes);
app.use('/api/dashboard', protect, dashboardRoutes);

// ─── Health Check ──────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
  });
});

// ─── Error Handling ────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

module.exports = app;
