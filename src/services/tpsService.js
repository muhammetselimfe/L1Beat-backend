const TPS = require('../models/tps');
const axios = require('axios');
const Chain = require('../models/chain');

class TpsService {
  async updateTpsData(chainId, retryCount = 3) {
    console.log(`[TPS Update] Starting update for chain ${chainId} in ${process.env.NODE_ENV}`);
    
    for (let attempt = 1; attempt <= retryCount; attempt++) {
      try {
        console.log(`[TPS Update] Attempt ${attempt}/${retryCount} for chain ${chainId}`);
        
        const response = await axios.get(`https://popsicle-api.avax.network/v1/avg_tps/${chainId}`, {
          timeout: 30000,
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'l1beat-backend/1.0',
            'Cache-Control': 'no-cache'
          },
          validateStatus: status => status === 200
        });

        if (!response.data?.results?.length) {
          console.warn(`[TPS Update] Empty response for chain ${chainId}, attempt ${attempt}`);
          if (attempt < retryCount) {
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
            continue;
          }
        }

        // Enhanced error logging
        if (!response.data) {
          console.warn(`[TPS Update] No data in response for chain ${chainId}`);
          continue;
        }

        if (!Array.isArray(response.data.results)) {
          console.warn(`[TPS Update] Invalid response format for chain ${chainId}:`, response.data);
          continue;
        }

        const currentTime = Math.floor(Date.now() / 1000);
        const thirtyDaysAgo = currentTime - (30 * 24 * 60 * 60);

        // Log raw data before filtering
        console.log(`[TPS Update] Raw data for chain ${chainId}:`, {
          resultsCount: response.data.results.length,
          sampleData: response.data.results[0],
          environment: process.env.NODE_ENV
        });

        // Validate and filter TPS data
        const validTpsData = response.data.results.filter(item => {
          const timestamp = Number(item.timestamp);
          const value = parseFloat(item.value);
          
          if (isNaN(timestamp) || isNaN(value)) {
            console.warn(`[TPS Update] Invalid data point for chain ${chainId}:`, item);
            return false;
          }
          
          const isValid = timestamp >= thirtyDaysAgo && timestamp <= currentTime;
          if (!isValid) {
            console.warn(`[TPS Update] Out of range timestamp for chain ${chainId}:`, {
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

          console.log(`[TPS Update] Success for chain ${chainId}:`, {
            validDataPoints: validTpsData.length,
            environment: process.env.NODE_ENV,
            timestamp: new Date().toISOString()
          });

          return result;
        }

        console.warn(`[TPS Update] No valid data points for chain ${chainId}`);
        return null;

      } catch (error) {
        console.error(`[TPS Update] Failed for chain ${chainId}, attempt ${attempt}:`, {
          message: error.message,
          status: error.response?.status,
          data: error.response?.data
        });

        if (attempt < retryCount) {
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
          continue;
        }
      }
    }

    // If all retries failed, return null but don't throw
    return null;
  }

  async getTpsHistory(chainId, days = 30) {
    try {
      const existingData = await TPS.countDocuments({ chainId });
      
      if (existingData === 0) {
        console.log(`No TPS history found for chain ${chainId}, fetching from API...`);
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
      
      console.log(`Found ${data.length} TPS records for chain ${chainId}`);
      return data;
    } catch (error) {
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
        console.log(`No TPS data found for chain ${chainId}, fetching from API...`);
        await this.updateTpsData(chainId);
        latest = await TPS.findOne({ chainId })
          .sort({ timestamp: -1 })
          .select('-_id timestamp value')
          .lean();
      }
      
      return latest;
    } catch (error) {
      throw new Error(`Error fetching latest TPS: ${error.message}`);
    }
  }

  async getNetworkTps() {
    try {
      const chains = await Chain.find().select('chainId').lean();
      
      const currentTime = Math.floor(Date.now() / 1000);
      const oneDayAgo = currentTime - (24 * 60 * 60);

      // Add more detailed initial logging
      console.log('Network TPS calculation - Time boundaries:', {
        currentTime: new Date(currentTime * 1000).toISOString(),
        oneDayAgo: new Date(oneDayAgo * 1000).toISOString(),
        currentTimestamp: currentTime,
        oneDayAgoTimestamp: oneDayAgo
      });

      // First get all TPS records for debugging
      const allTpsRecords = await TPS.find({
        timestamp: { $gte: oneDayAgo }
      }).lean();

      console.log('All TPS records in last 24h:', {
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
          console.warn(`Invalid timestamp for chain ${result.chainId}:`, {
            timestamp: new Date(timestamp * 1000).toISOString(),
            value: result.value
          });
        }
        
        return isValid;
      });

      // Detailed logging of valid results
      console.log('Network TPS calculation - Valid Results:', {
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
        console.warn('Found future timestamps:', {
          count: futureTimestamps.length,
          timestamps: futureTimestamps.map(t => new Date(t * 1000).toISOString())
        });
      }

      console.log('Network TPS calculation:', {
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
        console.warn(`TPS data is ${dataAge} minutes old (${(dataAge/60).toFixed(1)} hours)`);
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
      console.error('Error calculating network TPS:', error);
      throw error;
    }
  }

  async getNetworkTpsHistory(days = 7) {
    try {
      const cutoffDate = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);
      
      // Get TPS data for all chains within the time range
      const tpsData = await TPS.aggregate([
        {
          $match: {
            timestamp: { $gte: cutoffDate }
          }
        },
        {
          // Convert timestamp to start of day
          $addFields: {
            dayTimestamp: {
              $subtract: [
                "$timestamp",
                { $mod: ["$timestamp", 86400] }
              ]
            }
          }
        },
        {
          // First group by day and chainId to get daily chain averages
          $group: {
            _id: {
              day: "$dayTimestamp",
              chainId: "$chainId"
            },
            avgTps: { $avg: "$value" }  // Average TPS per chain per day
          }
        },
        {
          // Then group by day to sum the averages
          $group: {
            _id: "$_id.day",
            totalTps: { $sum: "$avgTps" },  // Sum of chain averages
            chainCount: { $sum: 1 }  // Count of unique chains
          }
        },
        {
          $project: {
            _id: 0,
            timestamp: "$_id",
            totalTps: { $round: ["$totalTps", 2] },
            chainCount: 1
          }
        },
        {
          $sort: { timestamp: 1 }
        }
      ]);

      console.log(`[TPS History] Found ${tpsData.length} daily records. Environment: ${process.env.NODE_ENV}`);
      console.log('[TPS History] Sample data:', tpsData[tpsData.length - 1]); // Log last day's data

      return tpsData.map(record => ({
        ...record,
        date: new Date(record.timestamp * 1000).toISOString()
      }));

    } catch (error) {
      console.error('Error fetching network TPS history:', error);
      throw error;
    }
  }
}

module.exports = new TpsService(); 