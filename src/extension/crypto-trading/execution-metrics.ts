/**
 * Execution Metrics Collector for G3 validation
 *
 * Tracks per-order: latency, slippage, success/failure
 * Persists to disk for offline analysis by Edge/Quant
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface OrderMetric {
  timestamp: string;        // ISO 8601
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  // Latency
  latencyMs: number;        // createOrder call duration
  // Slippage (market orders only; limit orders = 0)
  expectedPrice: number;    // ticker.last at order time
  filledPrice: number | null;
  slippageBps: number | null; // basis points: (filled - expected) / expected * 10000
  // Outcome
  success: boolean;
  error?: string;
  orderId?: string;
  filledSize?: number;
}

export interface MetricsSummary {
  totalOrders: number;
  successCount: number;
  failCount: number;
  successRate: number;       // 0-1
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  slippageMeanBps: number;
  slippageP95Bps: number;
  // Pass/Fail vs thresholds
  latencyP95Pass: boolean;   // ≤800ms
  successRatePass: boolean;  // ≥97%
  slippageP95Pass: boolean;  // ≤50bps (0.5%)
}

const METRICS_PATH = join(process.cwd(), 'data', 'execution-metrics.jsonl');
const LATENCY_THRESHOLD_MS = 800;
const SUCCESS_RATE_THRESHOLD = 0.97;
const SLIPPAGE_THRESHOLD_BPS = 50;

export class ExecutionMetricsCollector {
  private metrics: OrderMetric[] = [];
  private dirty = false;

  /** Record a single order execution. */
  record(metric: OrderMetric): void {
    this.metrics.push(metric);
    this.dirty = true;
    // Fire-and-forget persist
    this.persist().catch(() => {});
  }

  /** Load historical metrics from disk. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(METRICS_PATH, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);
      this.metrics = lines.map(l => JSON.parse(l) as OrderMetric);
    } catch {
      this.metrics = [];
    }
  }

  /** Persist to JSONL (append-friendly). */
  private async persist(): Promise<void> {
    if (!this.dirty) return;
    try {
      await mkdir(dirname(METRICS_PATH), { recursive: true });
      const content = this.metrics.map(m => JSON.stringify(m)).join('\n') + '\n';
      await writeFile(METRICS_PATH, content, 'utf-8');
      this.dirty = false;
    } catch {
      // best-effort
    }
  }

  /** Compute summary for G3 reporting. */
  summary(): MetricsSummary {
    const n = this.metrics.length;
    if (n === 0) {
      return {
        totalOrders: 0, successCount: 0, failCount: 0, successRate: 0,
        latencyP50Ms: 0, latencyP95Ms: 0, latencyP99Ms: 0,
        slippageMeanBps: 0, slippageP95Bps: 0,
        latencyP95Pass: false, successRatePass: false, slippageP95Pass: false,
      };
    }

    const successes = this.metrics.filter(m => m.success);
    const successRate = successes.length / n;

    // Latency percentiles (all orders)
    const latencies = this.metrics.map(m => m.latencyMs).sort((a, b) => a - b);
    const p50 = percentile(latencies, 0.50);
    const p95 = percentile(latencies, 0.95);
    const p99 = percentile(latencies, 0.99);

    // Slippage (successful market orders only)
    const slippages = successes
      .filter(m => m.slippageBps != null)
      .map(m => Math.abs(m.slippageBps!))
      .sort((a, b) => a - b);
    const slipMean = slippages.length > 0
      ? slippages.reduce((a, b) => a + b, 0) / slippages.length
      : 0;
    const slipP95 = slippages.length > 0 ? percentile(slippages, 0.95) : 0;

    return {
      totalOrders: n,
      successCount: successes.length,
      failCount: n - successes.length,
      successRate,
      latencyP50Ms: p50,
      latencyP95Ms: p95,
      latencyP99Ms: p99,
      slippageMeanBps: slipMean,
      slippageP95Bps: slipP95,
      latencyP95Pass: p95 <= LATENCY_THRESHOLD_MS,
      successRatePass: successRate >= SUCCESS_RATE_THRESHOLD,
      slippageP95Pass: slipP95 <= SLIPPAGE_THRESHOLD_BPS,
    };
  }

  /** Get raw metrics for export. */
  raw(): readonly OrderMetric[] {
    return this.metrics;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}
