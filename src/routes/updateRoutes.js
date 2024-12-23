const express = require('express');
const router = express.Router();
const Chain = require('../models/chain');
const tpsService = require('../services/tpsService');
const tvlService = require('../services/tvlService');
const fetchAndUpdateData = require('../utils/fetchGlacierData');
const mongoose = require('mongoose');

// Middleware to check API key
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

// Update single chain TPS
router.post('/update/chain/:chainId/tps', validateApiKey, async (req, res) => {
  try {
    const { chainId } = req.params;
    await tpsService.updateTpsData(chainId);
    const latestTps = await tpsService.getLatestTps(chainId);
    
    res.json({
      success: true,
      chainId,
      latestTps
    });
  } catch (error) {
    console.error(`Failed to update chain ${chainId}:`, error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Update TVL
router.post('/update/tvl', validateApiKey, async (req, res) => {
  try {
    await tvlService.updateTvlData();
    res.json({
      success: true,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('TVL update failed:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Health check endpoint
router.get('/health', validateApiKey, async (req, res) => {
  try {
    // Get DB connection state
    const dbState = mongoose.connection.readyState;
    const isConnected = dbState === 1;
    
    // Log detailed connection info
    console.log('Health check - DB connection state:', {
      readyState: dbState,
      isConnected,
      host: mongoose.connection.host,
      name: mongoose.connection.name,
      environment: process.env.NODE_ENV,
      timestamp: new Date().toISOString()
    });

    // If not connected, try to reconnect
    if (!isConnected) {
      console.log('Database not connected, attempting to reconnect...');
      try {
        await mongoose.connect(
          process.env.NODE_ENV === 'production' 
            ? process.env.PROD_MONGODB_URI 
            : process.env.DEV_MONGODB_URI,
          {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 5000
          }
        );
        console.log('Reconnection successful');
      } catch (dbError) {
        console.error('Reconnection failed:', dbError);
      }
    }

    // Get updated connection state
    const finalDbState = mongoose.connection.readyState;
    const finalIsConnected = finalDbState === 1;

    res.json({
      success: true,
      status: finalIsConnected ? 'ok' : 'degraded',
      timestamp: Date.now(),
      metrics: {
        dbConnected: finalIsConnected,
        dbState: finalDbState,
        environment: process.env.NODE_ENV
      }
    });
  } catch (error) {
    console.error('Health check error:', {
      message: error.message,
      stack: error.stack,
      dbState: mongoose.connection.readyState,
      environment: process.env.NODE_ENV,
      timestamp: new Date().toISOString()
    });
    
    res.status(503).json({ 
      success: false, 
      error: 'Service unavailable - Database connection issues',
      status: 'error',
      metrics: {
        dbState: mongoose.connection.readyState,
        environment: process.env.NODE_ENV
      }
    });
  }
});

// Test endpoint - make it super lightweight
router.get('/test', validateApiKey, (req, res) => {
  try {
    // Remove async/await since we don't need it
    // Return minimal response
    res.status(200).json({
      success: true,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('Test endpoint error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error'
    });
  }
});

// Batch update endpoint
router.post('/update/batch', validateApiKey, async (req, res) => {
  try {
    // Start the update process but don't wait for it to complete
    res.json({
      success: true,
      message: 'Update process started',
      timestamp: new Date().toISOString()
    });

    // Continue processing in the background
    console.log('Starting batch update...');
    fetchAndUpdateData()
      .then(() => {
        console.log('Background update completed successfully');
      })
      .catch((error) => {
        console.error('Background update failed:', error);
      });

  } catch (error) {
    console.error('Batch update initiation failed:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router; 