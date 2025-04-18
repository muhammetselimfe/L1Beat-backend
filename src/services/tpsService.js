const TPS = require('../models/tps');
const axios = require('axios');
const Chain = require('../models/chain');
const config = require('../config/config');
const logger = require('../utils/logger');

class TpsService {
  async updateTpsData(chainId, retryCount = 3) {
    for (let attempt = 1; attempt <= retryCount; attempt++) {
      try {
        logger.info(`[TPS Update] Starting update for chain ${chainId} (Attempt ${attempt}/${retryCount})`);
        
        // Use the new metrics API endpoint
        const response = await axios.get(`${config.api.metrics.baseUrl}/chains/${chainId}/metrics/avgTps`, {
          params: {
            timeInterval: 'day',
            pageSize: 30
          },
          timeout: config.api.metrics.timeout,
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'l1beat-backend'
          }
        });

        // Enhanced error logging
        if (!response.data) {
          logger.warn(`[TPS Update] No data in response for chain ${chainId}`);
          continue;
        }

        if (!Array.isArray(response.data.results)) {
          logger.warn(`[TPS Update] Invalid response format for chain ${chainId}:`, response.data);
          continue;
        }

        const currentTime = Math.floor(Date.now() / 1000);
        const thirtyDaysAgo = currentTime - (30 * 24 * 60 * 60);

        // Log raw data before filtering
        logger.info(`[TPS Update] Raw data for chain ${chainId}:`, {
          resultsCount: response.data.results.length,
          sampleData: response.data.results[0],
          environment: process.env.NODE_ENV
        });

        // Validate and filter TPS data
        const validTpsData = response.data.results.filter(item => {
          const timestamp = Number(item.timestamp);
          const value = parseFloat(item.value);
          
          if (isNaN(timestamp) || isNaN(value)) {
            logger.warn(`[TPS Update] Invalid data point for chain ${chainId}:`, item);
            return false;
          }
          
          const isValid = timestamp >= thirtyDaysAgo && timestamp <= currentTime;
          if (!isValid) {
            logger.warn(`[TPS Update] Out of range timestamp for chain ${chainId}:`, {
              timestamp: new Date(timestamp * 1000).toISOString(),
              value
            });
          }
          
          return isValid;
        });

        // If we have valid data, proceed with update
        if (validTpsData.length > 0) {
          const result = await TPS.bulkWrite(
            validTpsData.map(item => ({
              updateOne: {
                filter: { 
                  chainId: chainId,
                  timestamp: Number(item.timestamp)
                },
                update: { 
                  $set: { 
                    value: parseFloat(item.value),
                    lastUpdated: new Date() 
                  }
                },
                upsert: true
              }
            })),
            { ordered: false } // Continue processing even if some operations fail
          );

          logger.info(`[TPS Update] Success for chain ${chainId}:`, {
            validDataPoints: validTpsData.length,
            matched: result.matchedCount,
            modified: result.modifiedCount,
            upserted: result.upsertedCount,
            environment: process.env.NODE_ENV
          });

          return result;
        }

        logger.warn(`[TPS Update] No valid data points for chain ${chainId}`);
        return null;

      } catch (error) {
        logger.error(`[TPS Update] Error for chain ${chainId} (Attempt ${attempt}/${retryCount}):`, {
          message: error.message,
          status: error.response?.status,
          data: error.response?.data,
          stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });

        if (attempt === retryCount) {
          // On final attempt, log but don't throw
          logger.error(`[TPS Update] All attempts failed for chain ${chainId}`);
          return null;
        }

        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, attempt * 2000));
      }
    }
    return null;
  }

  async getTpsHistory(chainId, days = 30) {
    try {
      const existingData = await TPS.countDocuments({ chainId });
      
      if (existingData === 0) {
        logger.info(`No TPS history found for chain ${chainId}, fetching from API...`);
        await this.updateTpsData(chainId);
      }

      const cutoffDate = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);
      
      const data = await TPS.find({
        chainId,
        timestamp: { $gte: cutoffDate }
      })
        .sort({ timestamp: -1 })
        .select('-_id timestamp value')
        .lean();
      
      logger.info(`Found ${data.length} TPS records for chain ${chainId}`);
      return data;
    } catch (error) {
      logger.error(`Error fetching TPS history: ${error.message}`);
      throw new Error(`Error fetching TPS history: ${error.message}`);
    }
  }

  async getLatestTps(chainId) {
    try {
      let latest = await TPS.findOne({ chainId })
        .sort({ timestamp: -1 })
        .select('-_id timestamp value')
        .lean();

      if (!latest) {
        logger.info(`No TPS data found for chain ${chainId}, fetching from API...`);
        await this.updateTpsData(chainId);
        latest = await TPS.findOne({ chainId })
          .sort({ timestamp: -1 })
          .select('-_id timestamp value')
          .lean();
      }
      
      return latest;
    } catch (error) {
      logger.error(`Error fetching latest TPS: ${error.message}`);
      throw new Error(`Error fetching latest TPS: ${error.message}`);
    }
  }

  async getNetworkTps() {
    try {
      const chains = await Chain.find().select('chainId').lean();
      
      const currentTime = Math.floor(Date.now() / 1000);
      const oneDayAgo = currentTime - (24 * 60 * 60);

      // Add more detailed initial logging
      logger.info('Network TPS calculation - Time boundaries:', {
        currentTime: new Date(currentTime * 1000).toISOString(),
        oneDayAgo: new Date(oneDayAgo * 1000).toISOString(),
        currentTimestamp: currentTime,
        oneDayAgoTimestamp: oneDayAgo
      });

      // First get all TPS records for debugging
      const allTpsRecords = await TPS.find({
        timestamp: { $gte: oneDayAgo }
      }).lean();

      logger.info('All TPS records in last 24h:', {
        count: allTpsRecords.length,
        uniqueChains: [...new Set(allTpsRecords.map(r => r.chainId))].length,
        timeRange: {
          oldest: allTpsRecords.length ? new Date(Math.min(...allTpsRecords.map(r => r.timestamp * 1000))).toISOString() : null,
          newest: allTpsRecords.length ? new Date(Math.max(...allTpsRecords.map(r => r.timestamp * 1000))).toISOString() : null
        }
      });

      const latestTpsPromises = chains.map(chain => 
        TPS.findOne({ 
          chainId: chain.chainId,
          timestamp: { $gte: oneDayAgo, $lte: currentTime } // Add upper bound
        })
          .sort({ timestamp: -1 })
          .select('value timestamp chainId')
          .lean()
      );

      const tpsResults = await Promise.all(latestTpsPromises);
      const validResults = tpsResults.filter(result => {
        if (!result) return false;
        
        // Validate the timestamp is reasonable
        const timestamp = result.timestamp;
        const isValid = timestamp >= oneDayAgo && timestamp <= currentTime;
        
        if (!isValid) {
          logger.warn(`Invalid timestamp for chain ${result.chainId}:`, {
            timestamp: new Date(timestamp * 1000).toISOString(),
            value: result.value
          });
        }
        
        return isValid;
      });

      // Detailed logging of valid results
      logger.info('Network TPS calculation - Valid Results:', {
        totalChains: chains.length,
        validResults: validResults.length,
        chainDetails: validResults.map(r => ({
          chainId: r.chainId,
          tps: r.value,
          timestamp: new Date(r.timestamp * 1000).toISOString()
        })),
        environment: process.env.NODE_ENV
      });

      const timestamps = validResults.map(r => r.timestamp);
      const futureTimestamps = timestamps.filter(t => t > currentTime);
      if (futureTimestamps.length > 0) {
        logger.warn('Found future timestamps:', {
          count: futureTimestamps.length,
          timestamps: futureTimestamps.map(t => new Date(t * 1000).toISOString())
        });
      }

      logger.info('Network TPS calculation:', {
        totalChains: chains.length,
        validResults: validResults.length,
        oldestTimestamp: validResults.length ? new Date(Math.min(...timestamps) * 1000).toISOString() : null,
        newestTimestamp: validResults.length ? new Date(Math.max(...timestamps) * 1000).toISOString() : null,
        currentTime: new Date(currentTime * 1000).toISOString(),
        environment: process.env.NODE_ENV
      });

      if (validResults.length === 0) {
        return {
          totalTps: 0,
          chainCount: 0,
          timestamp: currentTime,
          updatedAt: new Date().toISOString(),
          dataAge: 0,
          dataAgeUnit: 'minutes'
        };
      }

      const total = validResults.reduce((sum, result) => sum + (result.value || 0), 0);
      const latestTimestamp = Math.max(...timestamps);
      const dataAge = Math.max(0, Math.floor((currentTime - latestTimestamp) / 60)); // Convert to minutes

      if (dataAge > 24 * 60) { // More than 24 hours in minutes
        logger.warn(`TPS data is ${dataAge} minutes old (${(dataAge/60).toFixed(1)} hours)`);
      }

      return {
        totalTps: parseFloat(total.toFixed(2)),
        chainCount: validResults.length,
        timestamp: latestTimestamp,
        updatedAt: new Date().toISOString(),
        dataAge,
        dataAgeUnit: 'minutes',
        lastUpdate: new Date(latestTimestamp * 1000).toISOString()
      };
    } catch (error) {
      logger.error('Error calculating network TPS:', error);
      throw error;
    }
  }

  async getNetworkTpsHistory(days = 7) {
    try {
      const cutoffDate = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);
      
      // Get all chains
      const chains = await Chain.find().select('chainId').lean();
      
      // Get TPS data for all chains within the time range
      const tpsData = await TPS.aggregate([
        {
          $match: {
            chainId: { $in: chains.map(c => c.chainId) },
            timestamp: { $gte: cutoffDate }
          }
        },
        {
          // Group by timestamp and sum the values
          $group: {
            _id: '$timestamp',
            totalTps: { $sum: '$value' },
            chainCount: { $sum: 1 }
          }
        },
        {
          // Format the output
          $project: {
            _id: 0,
            timestamp: '$_id',
            totalTps: { $round: ['$totalTps', 2] },
            chainCount: 1
          }
        },
        {
          // Sort by timestamp
          $sort: { timestamp: 1 }
        }
      ]);

      // Add metadata to each data point
      const enrichedData = tpsData.map(point => ({
        ...point,
        date: new Date(point.timestamp * 1000).toISOString()
      }));

      logger.info(`Found ${enrichedData.length} historical network TPS records`);
      return enrichedData;
    } catch (error) {
      logger.error(`Error fetching network TPS history: ${error.message}`);
      throw new Error(`Error fetching network TPS history: ${error.message}`);
    }
  }
}

module.exports = new TpsService(); 