require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const connectDB = require('./config/db');
const chainRoutes = require('./routes/chainRoutes');
const fetchAndUpdateData = require('./utils/fetchGlacierData');
const tvlRoutes = require('./routes/tvlRoutes');
require('./models/tvl');

const app = express();

// Add debugging logs
console.log('Starting server with environment:', process.env.NODE_ENV);
console.log('MongoDB URI:', process.env.NODE_ENV === 'production' 
  ? 'PROD URI is set: ' + !!process.env.PROD_MONGODB_URI
  : 'DEV URI is set: ' + !!process.env.DEV_MONGODB_URI
);

// Environment-specific configurations
const isDevelopment = process.env.NODE_ENV === 'development';

// CORS configuration with environment-specific settings
app.use(cors({
  origin: isDevelopment 
    ? '*' 
    : ['https://l1beat.io', 'https://www.l1beat.io', 'http://localhost:4173'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin']
}));

app.use(express.json());

// Connect to MongoDB
connectDB();

// Routes
app.use('/api', chainRoutes);
app.use('/api', tvlRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Schedule data updates - ensure it runs in production too
if (process.env.NODE_ENV === 'production') {
  console.log('Starting production scheduled tasks...');
  // Immediate initial fetch
  fetchAndUpdateData().catch(error => {
    console.error('Initial production data fetch failed:', error);
  });
  // Schedule subsequent updates
  cron.schedule('*/30 * * * *', () => {
    console.log('Running scheduled TVL update in production...');
    fetchAndUpdateData();
  });
}

// Development-only middleware
if (isDevelopment) {
  app.use((req, res, next) => {
    console.log(`${req.method} ${req.path} - ${new Date().toISOString()}`);
    next();
  });
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  
  // Send proper JSON response
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message,
    path: req.path
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

// Add OPTIONS handling for preflight requests
app.options('*', cors());

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

// Start the automatic updates when the server starts
if (process.env.NODE_ENV === 'development') {
  console.log('Starting automatic data updates...');
  fetchAndUpdateData().catch(error => {
    console.error('Initial data fetch failed:', error);
  });
}
