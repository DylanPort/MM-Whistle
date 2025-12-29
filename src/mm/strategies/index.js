/**
 * MM STRATEGIES INDEX - MEME TOKEN EDITION
 * 
 * All strategies tuned for Solana meme token volatility:
 * - Wide price thresholds (10-30% moves)
 * - Fast reaction times (5 second intervals)
 * - High slippage tolerance (25-30%)
 * - Position sizing relative to balance
 */

import { VolumeBot } from './volume-bot.js';
import { PriceReactiveBot } from './price-reactive.js';
import { GridBot } from './grid-bot.js';
import { TrendFollowerBot } from './trend-follower.js';
import { SpreadMarketMaker } from './spread-mm.js';
import { PumpHunterBot } from './pump-hunter.js';

// Strategy registry
export const STRATEGIES = {
    'volume': VolumeBot,
    'price-reactive': PriceReactiveBot,
    'grid': GridBot,
    'trend-follower': TrendFollowerBot,
    'spread-mm': SpreadMarketMaker,
    'pump-hunter': PumpHunterBot,
};

// Get strategy info for UI
export function getStrategyInfo() {
    return Object.entries(STRATEGIES).map(([key, Strategy]) => ({
        id: key,
        name: Strategy.name,
        description: Strategy.description,
        difficulty: Strategy.difficulty,
    }));
}

// Create strategy instance
export function createStrategy(strategyId, connection, wallet, tokenMint, config) {
    const Strategy = STRATEGIES[strategyId];
    if (!Strategy) {
        throw new Error(`Unknown strategy: ${strategyId}`);
    }
    return new Strategy(connection, wallet, tokenMint, config);
}

export {
    VolumeBot,
    PriceReactiveBot,
    GridBot,
    TrendFollowerBot,
    SpreadMarketMaker,
    PumpHunterBot,
};
