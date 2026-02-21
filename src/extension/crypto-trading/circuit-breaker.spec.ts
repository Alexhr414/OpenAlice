import { describe, it, expect, beforeEach } from 'vitest';
import { DailyLossCircuitBreaker } from './circuit-breaker.js';

describe('DailyLossCircuitBreaker', () => {
  let clock: number;
  let cb: DailyLossCircuitBreaker;

  beforeEach(() => {
    clock = Date.now();
    cb = new DailyLossCircuitBreaker({ maxDailyLossPct: 0.05, cooldownMs: 24 * 3600 * 1000 }, () => clock);
  });

  it('allows trading when no losses', () => {
    expect(cb.check(1000).allowed).toBe(true);
  });

  it('allows trading with small losses', () => {
    cb.recordPnL(-30); // 3% of 1000
    expect(cb.check(1000).allowed).toBe(true);
  });

  it('trips when daily loss exceeds 5%', () => {
    cb.recordPnL(-51); // 5.1% of 1000
    const result = cb.check(1000);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('5.1%');
    expect(cb.isTripped).toBe(true);
  });

  it('stays tripped during cooldown', () => {
    cb.recordPnL(-60);
    cb.check(1000); // trips
    clock += 12 * 3600 * 1000; // 12h later
    expect(cb.check(1000).allowed).toBe(false);
  });

  it('resets after cooldown expires', () => {
    cb.recordPnL(-60);
    cb.check(1000);
    clock += 25 * 3600 * 1000; // 25h later, losses also pruned
    expect(cb.check(1000).allowed).toBe(true);
  });

  it('accumulates multiple losses', () => {
    cb.recordPnL(-20);
    cb.recordPnL(-15);
    cb.recordPnL(-16); // total -51 = 5.1%
    expect(cb.check(1000).allowed).toBe(false);
  });

  it('prunes entries older than 24h', () => {
    cb.recordPnL(-40);
    clock += 25 * 3600 * 1000; // 25h later
    cb.recordPnL(-10); // only -10 in window = 1%
    expect(cb.check(1000).allowed).toBe(true);
  });

  it('tracks rollingPnL correctly', () => {
    cb.recordPnL(-20);
    cb.recordPnL(10);
    expect(cb.rollingPnL).toBe(-10);
  });

  it('handles zero equity gracefully', () => {
    cb.recordPnL(-100);
    expect(cb.check(0).allowed).toBe(true); // can't compute %, allow
  });
});
