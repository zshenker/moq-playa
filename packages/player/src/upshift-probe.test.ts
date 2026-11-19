import { describe, it, expect } from 'vitest';
import { ProbeMeter, UpshiftProbe, DEFAULT_UPSHIFT_PROBE_OPTIONS, type ProbeVerdict } from './upshift-probe.js';

describe('ProbeMeter', () => {
  it('excludes the first object and counts live bytes inside the window', () => {
    const meter = new ProbeMeter();
    meter.observeLive(50_000, 0); // before the first probe object: ignored
    meter.observeProbe(10_000, 1_000); // pays for the round trip: excluded
    meter.observeProbe(20_000, 51_000);
    meter.observeLive(5_000, 60_000);
    meter.observeProbe(25_000, 101_000);
    const result = meter.result(1, 1);
    expect(result).toEqual({ kind: 'measured', linkKbps: 50_000 * 8 / 100_000 * 1000, bytes: 50_000, durationUs: 100_000, early: false, lowerBound: false });
  });

  it('is inconclusive with too few objects or bytes', () => {
    const meter = new ProbeMeter();
    meter.observeProbe(1_000, 0);
    expect(meter.result(1, 1).kind).toBe('inconclusive');
    meter.observeProbe(1_000, 10);
    expect(meter.result(5_000, 1)).toMatchObject({ kind: 'inconclusive' });
  });

  it('without a send time, times a burst shorter than the minimum window against that window', () => {
    const meter = new ProbeMeter();
    meter.observeProbe(1_000, 0);
    meter.observeProbe(40_000, 5_000);
    expect(meter.result(1, 20_000)).toMatchObject({ kind: 'measured', linkKbps: 41_000 * 8 / 20_000 * 1000, durationUs: 20_000, lowerBound: true });
  });

  it('scores a short burst from the FETCH send, so a batched burst cannot overstate the link', () => {
    // 8 kB that really trickled in at ~400 kbps over 160 ms, but a busy main
    // thread handled every object at once at 200 ms.
    const meter = new ProbeMeter(0);
    for (let i = 0; i < 8; i++) meter.observeProbe(1_000, 200_000);
    const result = meter.result(1, 40_000);
    expect(result).toMatchObject({ kind: 'measured', lowerBound: true, bytes: 8_000, durationUs: 200_000 });
    expect(result.kind === 'measured' && result.linkKbps).toBeLessThanOrEqual(400);
  });
});

function harness() {
  let now = 0;
  const clock = { now: () => now };
  const probe = new UpshiftProbe(clock);
  const verdicts: ProbeVerdict[] = [];
  let arrive!: (bytes: number) => void, end!: (ok: boolean, reason?: string, retryable?: boolean) => void;
  let cancels = 0;
  const start = (requiredKbps = 3_000) => probe.start({
    request: { trackName: 'v', startGroup: 1n, startObject: 1n, endGroup: 1n, endObject: 20n }, requiredKbps,
    // Like the transport, cancellation reports the local discard synchronously.
    issue: (_r, a, e) => { arrive = a; end = e; return { cancel: () => { cancels++; e(false, 'stream ended: local-discard'); } }; },
    onVerdict: v => verdicts.push(v),
  });
  return { probe, verdicts, start, advance: (us: number) => { now += us; }, arrive: (b: number) => arrive(b),
    end: (ok: boolean, reason?: string, retryable?: boolean) => end(ok, reason, retryable), cancels: () => cancels };
}

describe('UpshiftProbe', () => {
  it('decides early once the burst shows enough capacity, and cancels the rest', () => {
    const h = harness();
    h.start(3_000);
    h.arrive(1_000);
    // 10 Mbps for 100 ms: 125 kB.
    for (let i = 0; i < 10; i++) { h.advance(10_000); h.arrive(12_500); }
    expect(h.verdicts).toHaveLength(1);
    expect(h.verdicts[0]).toMatchObject({ upshift: true, result: { kind: 'measured', early: true } });
    expect(h.cancels()).toBe(1);
    expect(h.probe.probing).toBe(false);
  });

  it('gives up by decideByUs on a slow path and backs off exponentially', () => {
    const h = harness();
    h.start(3_000);
    h.arrive(1_000);
    for (let i = 0; i < 10; i++) { h.advance(10_000); h.arrive(500); } // 400 kbps
    expect(h.verdicts).toHaveLength(1);
    expect(h.verdicts[0]).toMatchObject({ upshift: false, result: { kind: 'inconclusive' } });
    expect(h.probe.due()).toBe(false);
    h.advance(DEFAULT_UPSHIFT_PROBE_OPTIONS.initialBackoffUs);
    expect(h.probe.due()).toBe(true);
    h.start(3_000); h.end(false);
    h.advance(DEFAULT_UPSHIFT_PROBE_OPTIONS.initialBackoffUs);
    expect(h.probe.due()).toBe(false); // doubled
    h.advance(DEFAULT_UPSHIFT_PROBE_OPTIONS.initialBackoffUs);
    expect(h.probe.due()).toBe(true);
  });

  it('fails a probe that gets no data by firstByteUs, on the next live object', () => {
    const h = harness();
    const { firstByteUs } = DEFAULT_UPSHIFT_PROBE_OPTIONS;
    h.start();
    // A full link: live media keeps arriving, the low-priority FETCH gets no turn.
    for (let t = 0; t + 33_000 <= firstByteUs; t += 33_000) { h.advance(33_000); h.probe.observeLive(5_000); }
    expect(h.verdicts).toEqual([]);
    h.advance(33_000); h.probe.observeLive(5_000);
    expect(h.verdicts[0]).toMatchObject({ upshift: false,
      result: { kind: 'failed', reason: `no probe data within ${firstByteUs / 1000} ms` } });
    expect(h.cancels()).toBe(1);
    expect(h.probe.probing).toBe(false);
    expect(h.probe.due()).toBe(false); // backed off
  });

  it('lets a probe whose first object arrives before firstByteUs run on', () => {
    const h = harness();
    h.start();
    h.advance(DEFAULT_UPSHIFT_PROBE_OPTIONS.firstByteUs - 100_000);
    h.arrive(1_000);
    h.advance(200_000); h.probe.observeLive(5_000);
    expect(h.probe.probing || h.verdicts[0]?.result.kind !== 'failed').toBe(true);
  });

  it('times out a probe that never finishes', () => {
    const h = harness();
    h.start();
    h.arrive(1_000); // started, then stalls
    h.advance(DEFAULT_UPSHIFT_PROBE_OPTIONS.timeoutUs + 1);
    expect(h.probe.due()).toBe(false);
    expect(h.verdicts[0]).toMatchObject({ upshift: false, result: { kind: 'failed', reason: 'timed out' } });
    expect(h.cancels()).toBe(1);
  });

  it('retries a burst that ended too small to judge soon, without backing off', () => {
    const h = harness();
    const { smallRetryUs, maxSmallRetries, initialBackoffUs } = DEFAULT_UPSHIFT_PROBE_OPTIONS;
    // The whole requested range arrives within 10 ms: a lower bound below the target.
    const smallBurst = () => { h.start(30_000); h.arrive(1_000); h.advance(5_000); h.arrive(4_000); h.advance(5_000); h.arrive(4_000); h.end(true); };
    for (let i = 0; i < maxSmallRetries; i++) {
      smallBurst();
      expect(h.verdicts.at(-1)).toMatchObject({ upshift: false, retryLarger: true, result: { kind: 'measured', lowerBound: true } });
      expect(h.probe.wantsLarger).toBe(true);
      h.advance(smallRetryUs - 1);
      expect(h.probe.due()).toBe(false);
      h.advance(1);
      expect(h.probe.due()).toBe(true);
    }
    // Out of retries: back off as usual, at the initial (undoubled) backoff.
    smallBurst();
    expect(h.verdicts.at(-1)).toMatchObject({ upshift: false, retryLarger: false });
    expect(h.probe.wantsLarger).toBe(false);
    h.advance(initialBackoffUs - 1);
    expect(h.probe.due()).toBe(false);
    h.advance(1);
    expect(h.probe.due()).toBe(true);
  });

  it('a too-small burst that still shows enough capacity upshifts', () => {
    const h = harness();
    h.start(300);
    h.arrive(1_000); h.advance(5_000); h.arrive(8_000); h.advance(5_000); h.arrive(8_000); h.end(true);
    expect(h.verdicts[0]).toMatchObject({ upshift: true, result: { kind: 'measured', lowerBound: true } });
    expect(h.probe.wantsLarger).toBe(false);
  });

  it('a slow burst cut at decideByUs is evidence, not a small request: it backs off', () => {
    const h = harness();
    h.start(3_000);
    h.arrive(1_000);
    for (let i = 0; i < 10; i++) { h.advance(10_000); h.arrive(500); }
    expect(h.verdicts[0]).toMatchObject({ upshift: false, retryLarger: false });
    expect(h.probe.wantsLarger).toBe(false);
    h.advance(DEFAULT_UPSHIFT_PROBE_OPTIONS.smallRetryUs);
    expect(h.probe.due()).toBe(false);
  });

  it('a retryable failure (an unavailable range) is retried soon as inconclusive', () => {
    const h = harness();
    h.start();
    h.end(false, 'previous group unavailable', true);
    expect(h.verdicts[0]).toMatchObject({ upshift: false, retryLarger: true,
      result: { kind: 'inconclusive', reason: 'previous group unavailable' } });
    h.advance(DEFAULT_UPSHIFT_PROBE_OPTIONS.smallRetryUs);
    expect(h.probe.due()).toBe(true);
  });

  it('abort leaves no verdict and ignores late arrivals', () => {
    const h = harness();
    h.start();
    h.probe.abort();
    h.arrive(10_000); h.end(true);
    expect(h.verdicts).toEqual([]);
    expect(h.cancels()).toBe(1);
  });
});
