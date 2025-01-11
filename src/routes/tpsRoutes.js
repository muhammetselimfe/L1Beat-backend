const express = require('express');
const router = express.Router();
const tpsService = require('../services/tpsService');
const Chain = require('../models/chain');
const TPS = require('../models/tps');

// Add these new routes at the top of the file
router.post('/tps/update', async (req, res) => {
  try {
    const chains = await Chain.find().select('chainId');
    console.log(`[Vercel Cron] Updating TPS for ${chains.length} chains`);
    
    // Update TPS for all chains
    const updates = await Promise.all(
      chains.map(chain => tpsService.updateTpsData(chain.chainId))
    );
    
    res.json({
      success: true,
      chainsUpdated: chains.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Vercel Cron] TPS update failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get TPS history for a chain
router.get('/chains/:chainId/tps/history', async (req, res) => {
  try {
    const { chainId } = req.params;
    const days = parseInt(req.query.days) || 30;
    const data = await tpsService.getTpsHistory(chainId, days);
    res.json({
      success: true,
      chainId,
      count: data.length,
      data
    });
  } catch (error) {
    console.error('TPS History Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get latest TPS for a chain
router.get('/chains/:chainId/tps/latest', async (req, res) => {
  try {
    const { chainId } = req.params;
    const data = await tpsService.getLatestTps(chainId);
    res.json({
      success: true,
      chainId,
      data,
      timestamp: data ? new Date(data.timestamp * 1000).toISOString() : null
    });
  } catch (error) {
    console.error('Latest TPS Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Add new route for total network TPS
router.get('/tps/network/latest', async (req, res) => {
  try {
    const data = await tpsService.getNetworkTps();
    res.json({
      success: true,
      data,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Network TPS Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Add new route for historical network TPS
router.get('/tps/network/history', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const data = await tpsService.getNetworkTpsHistory(days);
    res.json({
      success: true,
      data,
      count: data.length,
      period: `${days} days`
    });
  } catch (error) {
    console.error('Network TPS History Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Add new health check route
router.get('/tps/health', async (req, res) => {
    try {
        const chains = await Chain.find().select('chainId').lean();
        const currentTime = Math.floor(Date.now() / 1000);
        const oneDayAgo = currentTime - (24 * 60 * 60);

        const tps = await TPS.find({
            timestamp: { $gte: oneDayAgo, $lte: currentTime }
        })
            .sort({ timestamp: -1 })
            .lean();

        const chainTpsCount = await TPS.aggregate([
            {
                $match: {
                    timestamp: { $gte: oneDayAgo, $lte: currentTime }
                }
            },
            {
                $group: {
                    _id: '$chainId',
                    count: { $sum: 1 },
                    lastUpdate: { $max: '$timestamp' }
                }
            }
        ]);
            
        res.json({
            success: true,
            stats: {
                totalChains: chains.length,
                chainIds: chains.map(c => c.chainId),
                recentTpsRecords: tps.length,
                lastTpsUpdate: tps[0] ? new Date(tps[0].timestamp * 1000).toISOString() : null,
                environment: process.env.NODE_ENV,
                chainsWithTps: chainTpsCount.length,
                chainTpsDetails: chainTpsCount.map(c => ({
                    chainId: c._id,
                    recordCount: c.count,
                    lastUpdate: new Date(c.lastUpdate * 1000).toISOString()
                })),
                timeRange: {
                    start: new Date(oneDayAgo * 1000).toISOString(),
                    end: new Date(currentTime * 1000).toISOString()
                }
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Add new diagnostic routes
router.get('/tps/diagnostic', async (req, res) => {
    try {
        const currentTime = Math.floor(Date.now() / 1000);
        const oneDayAgo = currentTime - (24 * 60 * 60);
        
        // Get all chains
        const chains = await Chain.find().select('chainId').lean();
        
        // Get TPS data for each chain
        const chainData = await Promise.all(chains.map(async chain => {
            const latestTps = await TPS.findOne({ 
                chainId: chain.chainId,
                timestamp: { $gte: oneDayAgo, $lte: currentTime }
            })
                .sort({ timestamp: -1 })
                .lean();

            const tpsCount = await TPS.countDocuments({
                chainId: chain.chainId,
                timestamp: { $gte: oneDayAgo, $lte: currentTime }
            });

            return {
                chainId: chain.chainId,
                hasData: !!latestTps,
                recordCount: tpsCount,
                latestValue: latestTps?.value,
                latestTimestamp: latestTps ? new Date(latestTps.timestamp * 1000).toISOString() : null
            };
        }));

        // Get overall stats
        const totalRecords = await TPS.countDocuments({
            timestamp: { $gte: oneDayAgo, $lte: currentTime }
        });

        const chainsWithData = chainData.filter(c => c.hasData);
        const totalTps = chainsWithData.reduce((sum, chain) => sum + (chain.latestValue || 0), 0);

        res.json({
            success: true,
            environment: process.env.NODE_ENV,
            timeRange: {
                start: new Date(oneDayAgo * 1000).toISOString(),
                end: new Date(currentTime * 1000).toISOString()
            },
            summary: {
                totalChains: chains.length,
                chainsWithData: chainsWithData.length,
                totalRecords,
                calculatedTotalTps: parseFloat(totalTps.toFixed(2))
            },
            chainDetails: chainData.sort((a, b) => (b.latestValue || 0) - (a.latestValue || 0))
        });
    } catch (error) {
        console.error('Diagnostic Error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Add a simple status endpoint
router.get('/tps/status', async (req, res) => {
    try {
        const currentTime = Math.floor(Date.now() / 1000);
        const oneDayAgo = currentTime - (24 * 60 * 60);
        
        const tpsCount = await TPS.countDocuments({
            timestamp: { $gte: oneDayAgo, $lte: currentTime }
        });
        
        const chainCount = await Chain.countDocuments();
        
        res.json({
            success: true,
            environment: process.env.NODE_ENV,
            timestamp: new Date().toISOString(),
            stats: {
                tpsRecords: tpsCount,
                chains: chainCount,
                timeRange: {
                    start: new Date(oneDayAgo * 1000).toISOString(),
                    end: new Date(currentTime * 1000).toISOString()
                }
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Add this new route near the top of the file
router.post('/daily-update', async (req, res) => {
  try {
    console.log('[Daily Update] Starting daily update process');
    const startTime = Date.now();

    // Update chains first
    const chains = await Chain.find().select('chainId');
    console.log(`[Daily Update] Found ${chains.length} chains to update`);

    // Update TPS for all chains
    for (const chain of chains) {
      await tpsService.updateTpsData(chain.chainId);
    }

    // Update TVL
    await tvlService.updateTvlData();

    const duration = (Date.now() - startTime) / 1000;
    console.log(`[Daily Update] Completed in ${duration}s`);

    res.json({
      success: true,
      chainsUpdated: chains.length,
      duration: `${duration}s`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Daily Update] Failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router; 