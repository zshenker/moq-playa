/**
 * Capacity probing for ABR upshift.
 *
 * Live MoQ delivery is source-paced: a relay forwards each object when the
 * publisher produces it, so the receive rate of a live subscription is the
 * encoding rate of the rung being played, whatever the link could carry. A
 * throughput estimate built from live media therefore can never justify a
 * step up. The only way to learn about spare capacity is to send more than
 * the source produces and watch how fast it arrives.
 *
 * A probe is one standalone FETCH, at low subscriber priority, of objects
 * the relay already holds: the part of the current group published so far.
 * Those objects are already cached, so the relay
 * sends them as fast as the path allows; at low priority they take only
 * capacity the live media leaves idle. While the burst is arriving the path
 * is saturated, so everything received in that window (probe and live
 * media), measured from the first probe object to exclude the request round
 * trip, estimates the path's capacity.
 *
 * This module owns the measurement and the probing schedule. It issues no
 * requests itself: the player supplies `issue`, so the probe stays testable
 * without a transport.
 *
 * @module
 */

/** The outcome of a finished probe. */
export type ProbeResult =
  | {
    readonly kind: 'measured'; readonly linkKbps: number; readonly bytes: number; readonly durationUs: number; readonly early: boolean;
    /** The burst ended inside the minimum window: `linkKbps` is a lower bound. */
    readonly lowerBound: boolean;
  }
  | { readonly kind: 'inconclusive'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * Bytes-over-time while a probe burst is arriving. The first probe object
 * starts the window and its bytes are excluded: they paid for the request
 * round trip. Live media arriving inside the window counts too: while the
 * probe still has data queued the path is saturated, so probe plus live is
 * the path's rate whether or not the relay honoured the probe's priority.
 */
export class ProbeMeter {
  private firstUs: number | null = null;
  private lastUs = 0;
  private bytes = 0;
  private objects = 0;

  observeProbe(bytes: number, atUs: number): void {
    this.objects++;
    if (this.firstUs === null) { this.firstUs = atUs; this.lastUs = atUs; return; }
    this.lastUs = Math.max(this.lastUs, atUs);
    this.bytes += bytes;
  }

  /** Live media bytes; ignored before the first probe object. */
  observeLive(bytes: number, atUs: number): void {
    if (this.firstUs === null || atUs < this.firstUs) return;
    this.bytes += bytes;
  }

  /** Time since the first probe object, or null before it. */
  elapsedUs(nowUs: number): number | null { return this.firstUs === null ? null : nowUs - this.firstUs; }

  /**
   * Ends the window at the last probe object (the probe's FIN). A burst that
   * arrives inside `minDurationUs` is timed against `minDurationUs` instead:
   * clock resolution and callback batching make a shorter span unreliable,
   * but the bytes did arrive at least that fast, so the result is a lower
   * bound rather than nothing.
   */
  result(minBytes: number, minDurationUs: number, early = false, endUs?: number): ProbeResult {
    if (this.firstUs === null || this.objects < 2) return { kind: 'inconclusive', reason: 'too few objects' };
    if (this.bytes < minBytes) return { kind: 'inconclusive', reason: `only ${this.bytes} bytes` };
    const spanUs = (endUs ?? this.lastUs) - this.firstUs, lowerBound = spanUs < minDurationUs;
    const durationUs = Math.max(spanUs, minDurationUs);
    return { kind: 'measured', linkKbps: (this.bytes * 8) / durationUs * 1000, bytes: this.bytes, durationUs, early, lowerBound };
  }
}

export interface UpshiftProbeOptions {
  /** Required estimated capacity as a multiple of the next rung's bitrate. */
  readonly headroom: number;
  /** First retry delay after a probe that did not justify an upshift. */
  readonly initialBackoffUs: number;
  readonly maxBackoffUs: number;
  /** Abandon a probe that has not finished in this long. */
  readonly timeoutUs: number;
  readonly minBytes: number;
  readonly minDurationUs: number;
  /**
   * Decide before the burst ends: with enough capacity shown once this long
   * has passed, and either way at `decideByUs`. The rest is cancelled, which
   * bounds how long a relay that ignores the probe's low priority can hold
   * live media behind it.
   */
  readonly earlyUpshiftUs: number;
  readonly decideByUs: number;
}

export const DEFAULT_UPSHIFT_PROBE_OPTIONS: UpshiftProbeOptions = {
  headroom: 1.3,
  initialBackoffUs: 10_000_000,
  maxBackoffUs: 120_000_000,
  timeoutUs: 4_000_000,
  // A low rung's partial group can be only ~15 kB; a whole range arriving
  // inside minDurationUs is scored as a lower bound over that window.
  minBytes: 8_000,
  minDurationUs: 40_000,
  earlyUpshiftUs: 100_000,
  decideByUs: 100_000,
};

/** What a probe asks the player to request: one exact range of one track. */
export interface ProbeRequest {
  readonly trackName: string;
  readonly startGroup: bigint;
  readonly startObject: bigint;
  readonly endGroup: bigint;
  /** Exclusive; 0 requests the whole end group. */
  readonly endObject: bigint;
}

/** A started request, cancelled when the probe decides early or is abandoned. */
export interface ProbeHandle {
  cancel(): void;
}

/** One verdict: step up to `targetTrack`, or stay. */
export type ProbeVerdict =
  | { readonly upshift: true; readonly estimateKbps: number; readonly result: ProbeResult }
  | { readonly upshift: false; readonly estimateKbps: number | null; readonly result: ProbeResult };

/**
 * Probing schedule: at most one probe in flight, exponential backoff after a
 * probe that fails or shows too little capacity, reset after an upshift or
 * a downshift.
 */
export class UpshiftProbe {
  private inFlight: { id: number; meter: ProbeMeter; startedUs: number; handle: ProbeHandle | null;
    nextBitrateKbps: number; onVerdict: (v: ProbeVerdict) => void } | null = null;
  private nextProbeUs = 0;
  private backoffUs: number;
  private seq = 0;
  /** Verdicts so far, newest last (diagnostics and tests). */
  readonly history: Array<ProbeVerdict & { atUs: number }> = [];

  constructor(private readonly clock: { now(): number }, readonly options: UpshiftProbeOptions = DEFAULT_UPSHIFT_PROBE_OPTIONS) {
    this.backoffUs = options.initialBackoffUs;
  }

  get probing(): boolean { return this.inFlight !== null; }

  /** True when no probe is running and the backoff has elapsed. */
  due(): boolean {
    this.expire();
    return this.inFlight === null && this.clock.now() >= this.nextProbeUs;
  }

  /** Delay the next probe by at least `delayUs` (e.g. after any switch). */
  defer(delayUs: number): void {
    this.nextProbeUs = Math.max(this.nextProbeUs, this.clock.now() + delayUs);
  }

  /** A downshift or upshift starts the schedule over. */
  resetBackoff(): void { this.backoffUs = this.options.initialBackoffUs; }

  /**
   * Start a probe. `issue` sends the request and returns a handle; it reports
   * object arrivals through `arrive` and the stream's end through `end`.
   */
  start(params: {
    request: ProbeRequest;
    nextBitrateKbps: number;
    issue: (request: ProbeRequest, arrive: (bytes: number) => void, end: (ok: boolean, reason?: string) => void) => ProbeHandle;
    onVerdict: (verdict: ProbeVerdict) => void;
  }): void {
    if (this.inFlight) return;
    const id = ++this.seq;
    const state = { id, meter: new ProbeMeter(), startedUs: this.clock.now(), handle: null as ProbeHandle | null,
      nextBitrateKbps: params.nextBitrateKbps, onVerdict: params.onVerdict };
    this.inFlight = state;
    const current = () => this.inFlight?.id === id;
    try {
      state.handle = params.issue(params.request,
        bytes => { if (current()) { state.meter.observeProbe(bytes, this.clock.now()); this.decideEarly(); } },
        (ok, reason) => {
          if (!current()) return;
          this.finish(ok ? state.meter.result(this.options.minBytes, this.options.minDurationUs)
            : { kind: 'failed', reason: reason ?? 'stream did not finish' });
        });
    } catch (error) {
      if (current()) this.finish({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Live media bytes that arrived while the probe runs. */
  observeLive(bytes: number): void {
    const state = this.inFlight;
    if (!state) return;
    state.meter.observeLive(bytes, this.clock.now());
    this.decideEarly();
  }

  private decideEarly(): void {
    const state = this.inFlight;
    if (!state) return;
    const now = this.clock.now(), elapsed = state.meter.elapsedUs(now);
    if (elapsed === null || elapsed < this.options.earlyUpshiftUs) return;
    const result = state.meter.result(this.options.minBytes, this.options.minDurationUs, true, now);
    const enough = result.kind === 'measured' && result.linkKbps >= state.nextBitrateKbps * this.options.headroom;
    if (!enough && elapsed < this.options.decideByUs) return;
    // Settle first: cancelling can report the stream's local discard
    // synchronously, which must not overwrite this verdict.
    this.finish(result);
    state.handle?.cancel();
  }

  /** Abandon the running probe without a verdict (e.g. a switch started). */
  abort(): void {
    const state = this.inFlight;
    if (!state) return;
    this.inFlight = null;
    state.handle?.cancel();
  }

  private expire(): void {
    const state = this.inFlight;
    if (state && this.clock.now() - state.startedUs > this.options.timeoutUs) {
      this.finish({ kind: 'failed', reason: 'timed out' });
      state.handle?.cancel();
    }
  }

  private finish(result: ProbeResult): void {
    const state = this.inFlight;
    if (!state) return;
    this.inFlight = null;
    const now = this.clock.now();
    let verdict: ProbeVerdict;
    if (result.kind === 'measured') {
      const estimateKbps = result.linkKbps;
      verdict = estimateKbps >= state.nextBitrateKbps * this.options.headroom
        ? { upshift: true, estimateKbps, result }
        : { upshift: false, estimateKbps, result };
    } else {
      verdict = { upshift: false, estimateKbps: null, result };
    }
    this.history.push({ ...verdict, atUs: now });
    if (this.history.length > 32) this.history.shift();
    if (verdict.upshift) {
      this.backoffUs = this.options.initialBackoffUs;
    } else {
      this.nextProbeUs = now + this.backoffUs;
      this.backoffUs = Math.min(this.backoffUs * 2, this.options.maxBackoffUs);
    }
    state.onVerdict(verdict);
  }
}
