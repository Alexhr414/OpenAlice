/**
 * Daily Loss Circuit Breaker
 *
 * Tracks realized + unrealized PnL within a 24h rolling window.
 * When daily loss exceeds threshold, blocks all new orders for 24h.
 *
 * P0 risk control — non-bypassable.
 */

export interface CircuitBreakerConfig {
  /** Max daily loss as fraction of equity (default: 0.05 = 5%). */
  maxDailyLossPct: number;
  /** Cooldown period in ms after circuit trips (default: 24h). */
  cooldownMs: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  maxDailyLossPct: 0.05,
  cooldownMs: 24 * 60 * 60 * 1000,
};

interface PnLEntry {
  timestamp: number;
  pnl: number;
}

export class DailyLossCircuitBreaker {
  private config: CircuitBreakerConfig;
  private pnlLog: PnLEntry[] = [];
  private trippedAt: number | null = null;
  private now: () => number;

  constructor(config?: Partial<CircuitBreakerConfig>, now?: () => number) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.now = now ?? Date.now;
  }

  /** Record a realized PnL event (positive = profit, negative = loss). */
  recordPnL(pnl: number): void {
    this.pnlLog.push({ timestamp: this.now(), pnl });
    this.pruneOldEntries();
  }

  /** Check if trading is allowed. Returns { allowed, reason }. */
  check(currentEquity: number): { allowed: boolean; reason?: string } {
    // Check cooldown
    if (this.trippedAt !== null) {
      const elapsed = this.now() - this.trippedAt;
      if (elapsed < this.config.cooldownMs) {
        const remainingH = ((this.config.cooldownMs - elapsed) / 3600000).toFixed(1);
        return {
          allowed: false,
          reason: `Circuit breaker tripped. Trading resumes in ${remainingH}h.`,
        };
      }
      // Cooldown expired, reset
      this.trippedAt = null;
    }

    // Calculate rolling 24h loss
    this.pruneOldEntries();
    const totalPnL = this.pnlLog.reduce((sum, e) => sum + e.pnl, 0);

    if (currentEquity > 0 && totalPnL < 0) {
      const lossPct = Math.abs(totalPnL) / currentEquity;
      if (lossPct >= this.config.maxDailyLossPct) {
        this.trippedAt = this.now();
        return {
          allowed: false,
          reason: `Daily loss ${(lossPct * 100).toFixed(1)}% exceeds ${(this.config.maxDailyLossPct * 100).toFixed(0)}% limit. Circuit breaker tripped for 24h.`,
        };
      }
    }

    return { allowed: true };
  }

  /** Get current 24h rolling PnL. */
  get rollingPnL(): number {
    this.pruneOldEntries();
    return this.pnlLog.reduce((sum, e) => sum + e.pnl, 0);
  }

  get isTripped(): boolean {
    if (this.trippedAt === null) return false;
    return (this.now() - this.trippedAt) < this.config.cooldownMs;
  }

  private pruneOldEntries(): void {
    const cutoff = this.now() - 24 * 60 * 60 * 1000;
    this.pnlLog = this.pnlLog.filter((e) => e.timestamp >= cutoff);
  }
}
