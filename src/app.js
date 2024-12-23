require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const chainRoutes = require('./routes/chainRoutes');
const fetchAndUpdateData = require('./utils/fetchGlacierData');
const tvlRoutes = require('./routes/tvlRoutes');
const TVL = require('./models/tvl');
const tvlService = require('./services/tvlService');
const chainDataService = require('./services/chainDataService');
const Chain = require('./models/chain');
const chainService = require('./services/chainService');
const tpsRoutes = require('./routes/tpsRoutes');
const tpsService = require('./services/tpsService');
const updateRoutes = require('./routes/updateRoutes');
const mongoose = require('mongoose');

const app = express();

// Add debugging logs
console.log('Starting server with environment:', process.env.NODE_ENV);
console.log('MongoDB URI:', process.env.NODE_ENV === 'production' 
  ? 'PROD URI is set: ' + !!process.env.PROD_MONGODB_URI
  : 'DEV URI is set: ' + !!process.env.DEV_MONGODB_URI
);

// Environment-specific configurations
const isDevelopment = process.env.NODE_ENV === 'development';

// Update CORS configuration
const corsOptions = {
  origin: process.env.NODE_ENV === 'production'
    ? ['https://l1beat.io', 'https://www.l1beat.io', 'https://l1beat-io.vercel.app']
    : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Requested-With', 'Accept', 'Origin'],
  credentials: true,
  maxAge: 86400 // 24 hours
};

app.use(cors(corsOptions));

app.use(express.json());

// Add API key middleware
const validateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  const validApiKey = process.env.UPDATE_API_KEY;

  if (!apiKey || apiKey !== validApiKey) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized"
    });
  }
  next();
};

// Single initialization point for data updates
const initializeDataUpdates = async () => {
  console.log(`[${process.env.NODE_ENV}] Initializing data...`);
  try {
    await fetchAndUpdateData();
  } catch (error) {
    console.error('Initialization error:', error);
  }
};

// Call initialization after DB connection
connectDB().then(() => {
  initializeDataUpdates();
});

// Routes
app.use('/api', chainRoutes);
app.use('/api', tvlRoutes);
app.use('/api', tpsRoutes);
app.use('/api', updateRoutes);

// Add test endpoint
app.get('/api/test', validateApiKey, (req, res) => {
  try {
    console.log('Test endpoint called with API key:', !!req.headers['x-api-key']);
    
    // Test database connection
    const dbStatus = mongoose.connection.readyState;
    console.log('Database connection state:', dbStatus);
    
    res.json({
      success: true,
      message: "API is working correctly",
      timestamp: new Date().toISOString(),
      dbStatus: dbStatus === 1 ? 'connected' : 'disconnected'
    });
  } catch (error) {
    console.error('Test endpoint error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Development-only middleware
if (isDevelopment) {
  app.use((req, res, next) => {
    console.log(`${req.method} ${req.path} - ${new Date().toISOString()}`);
    next();
  });
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error details:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    headers: req.headers,
    timestamp: new Date().toISOString()
  });
  
  res.status(500).json({
    success: false,
    error: 'Internal Server Error',
    message: err.message,
    path: req.path,
    timestamp: new Date().toISOString()
  });
});

// Add error handling middleware specifically for chain routes
app.use('/api/chains', async (err, req, res, next) => {
  console.error('Chain route error:', {
    path: req.path,
    method: req.method,
    error: err.message,
    stack: err.stack,
    timestamp: new Date().toISOString()
  });

  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : err.message
  });
});

// Add catch-all route for undefined routes
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: 'The requested resource was not found',
    path: req.path
  });
});

// Ensure OPTIONS requests are handled properly
app.options('*', cors(corsOptions));

const PORT = process.env.PORT || 5001;

// For Vercel, we need to export the app
module.exports = app;

// Only listen if not running on Vercel
if (process.env.NODE_ENV !== 'production') {
    const server = app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        console.log(`Try accessing: http://localhost:${PORT}/api/chains`);
    });

    // Add error handler for the server
    server.on('error', (error) => {
        console.error('Server error:', error);
    });
} else {
    // Add explicit handling for production
    const server = app.listen(PORT, () => {
        console.log(`Production server running on port ${PORT}`);
        console.log(`Try accessing: http://localhost:${PORT}/api/chains`);
    });

    server.on('error', (error) => {
        console.error('Production server error:', error);
    });
}

// Add error event handler for uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
