require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
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
        ? [
            'https://www.l1beat.io',     // Main production URL
            'https://l1beat.io',         // Apex domain
            'http://localhost:5173',     // Development URL
            'http://localhost:4173'      // Vite preview URL
        ]
        : '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'x-api-key'],
    exposedHeaders: ['Access-Control-Allow-Origin'],
    maxAge: 86400 // 24 hours
};

// Apply CORS with options
app.use(cors(corsOptions));

// Add preflight handler for all routes
app.options('*', cors(corsOptions));

// Add CORS headers middleware as backup
app.use((req, res, next) => {
    // Get origin from request
    const origin = req.headers.origin;
    
    // Check if origin is allowed
    if (corsOptions.origin === '*' || 
        (Array.isArray(corsOptions.origin) && corsOptions.origin.includes(origin))) {
        res.header('Access-Control-Allow-Origin', origin);
    }
    
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 
        'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-api-key');
    next();
});

app.use(express.json());

// Single initialization point for data updates
const initializeDataUpdates = async () => {
  console.log(`[${process.env.NODE_ENV}] Initializing data updates at ${new Date().toISOString()}`);
  
  try {
    // First update chains
    console.log('Fetching initial chain data...');
    const chains = await chainDataService.fetchChainData();
    console.log(`Fetched ${chains.length} chains from Glacier API`);

    if (chains && chains.length > 0) {
      for (const chain of chains) {
        await chainService.updateChain(chain);
        // Add initial TPS update for each chain
        await tpsService.updateTpsData(chain.chainId);
      }
      console.log(`Updated ${chains.length} chains in database`);
      
      // Verify chains were saved
      const savedChains = await Chain.find();
      console.log('Chains in database:', {
        count: savedChains.length,
        chainIds: savedChains.map(c => c.chainId)
      });
    } else {
      console.error('No chains fetched from Glacier API');
    }

    // Then update TVL
    console.log('Updating TVL data...');
    await tvlService.updateTvlData();
    
    // Verify TVL update
    const lastTVL = await TVL.findOne().sort({ date: -1 });
    console.log('TVL Update Result:', {
      lastUpdate: lastTVL?.date ? new Date(lastTVL.date * 1000).toISOString() : 'none',
      tvl: lastTVL?.tvl,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Initialization error:', error);
  }

  // Set up scheduled updates for both production and development
  console.log('Setting up update schedules...');
  
  // TVL updates every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    try {
      console.log(`[CRON] Starting scheduled TVL update at ${new Date().toISOString()}`);
      await tvlService.updateTvlData();
      console.log('[CRON] TVL update completed');
    } catch (error) {
      console.error('[CRON] TVL update failed:', error);
    }
  });

  // Chain and TPS updates every hour
  cron.schedule('0 * * * *', async () => {
    try {
      console.log(`[CRON] Starting scheduled chain update at ${new Date().toISOString()}`);
      const chains = await chainDataService.fetchChainData();
      for (const chain of chains) {
        await chainService.updateChain(chain);
        // Add TPS update for each chain
        await tpsService.updateTpsData(chain.chainId);
      }
      console.log(`[CRON] Updated ${chains.length} chains with TPS data`);
    } catch (error) {
      console.error('[CRON] Chain/TPS update failed:', error);
    }
  });

  // Check TPS data every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    try {
        console.log(`[CRON] Starting TPS verification at ${new Date().toISOString()}`);
        
        const currentTime = Math.floor(Date.now() / 1000);
        const oneDayAgo = currentTime - (24 * 60 * 60);
        
        // Get chains with missing or old TPS data
        const chains = await Chain.find().select('chainId').lean();
        const tpsData = await TPS.find({
            timestamp: { $gte: oneDayAgo }
        }).distinct('chainId');

        const chainsNeedingUpdate = chains.filter(chain => 
            !tpsData.includes(chain.chainId)
        );

        if (chainsNeedingUpdate.length > 0) {
            console.log(`[CRON] Found ${chainsNeedingUpdate.length} chains needing TPS update`);
            
            // Update chains in batches
            const BATCH_SIZE = 5;
            for (let i = 0; i < chainsNeedingUpdate.length; i += BATCH_SIZE) {
                const batch = chainsNeedingUpdate.slice(i, i + BATCH_SIZE);
                await Promise.all(
                    batch.map(chain => tpsService.updateTpsData(chain.chainId))
                );
                if (i + BATCH_SIZE < chainsNeedingUpdate.length) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }

        console.log(`[CRON] TPS verification complete at ${new Date().toISOString()}`);
    } catch (error) {
        console.error('[CRON] TPS verification failed:', error);
    }
  });
};

// Call initialization after DB connection
connectDB().then(() => {
  initializeDataUpdates();
});

// Routes
app.use('/api', chainRoutes);
app.use('/api', tvlRoutes);
app.use('/api', tpsRoutes);

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
    console.error('Error:', err);

    // Ensure CORS headers are set even for errors
    const origin = req.headers.origin;
    if (corsOptions.origin === '*' || 
        (Array.isArray(corsOptions.origin) && corsOptions.origin.includes(origin))) {
        res.header('Access-Control-Allow-Origin', origin);
    }
    res.header('Access-Control-Allow-Credentials', 'true');
    
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
