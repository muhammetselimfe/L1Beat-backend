const express = require('express');
const router = express.Router();
const chainController = require('../controllers/chainController');
const chainDataService = require('../services/chainDataService');

router.get('/chains', chainController.getAllChains);
router.get('/chains/:chainId', chainController.getChainById);
router.get('/chains/:chainId/validators', chainController.getChainValidators);

router.post('/chains/update', async (req, res) => {
  try {
    console.log('[Vercel Cron] Starting chain update');
    const chains = await chainDataService.fetchChainData();
    
    for (const chain of chains) {
      await chainService.updateChain(chain);
    }
    
    res.json({
      success: true,
      chainsUpdated: chains.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Vercel Cron] Chain update failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
