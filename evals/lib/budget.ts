/**
 * The neuron cap on a live eval run (section 13).
 *
 * "Live runs cost neurons, so they are manual GitHub Actions runs with a
 * neuron cap."
 *
 * The cap is enforced before each call, not after — a run that notices it
 * overspent has already overspent. Section 12's account ceiling is 10,000
 * per rolling 24 hours for everything, so an eval that ignores its budget
 * takes the product down, not just itself. That happened once during the
 * week 1 spikes: a runaway probe burned 50,583 neurons, five times the
 * daily cap, and blocked every call for a day.
 */

export class NeuronCapExceeded extends Error {
  constructor(
    readonly spent: number,
    readonly cap: number,
  ) {
    super(`Neuron cap reached: ${spent.toFixed(1)} of ${cap}. Stopping before the next call.`);
    this.name = 'NeuronCapExceeded';
  }
}

export class NeuronBudget {
  private spent = 0;
  private calls = 0;

  constructor(readonly cap: number) {}

  /**
   * Call before every model call.
   *
   * `estimate` is what the next call is expected to cost. Refusing on
   * `spent + estimate > cap` rather than `spent > cap` is what keeps the
   * run inside the number it was given instead of one call past it.
   */
  reserve(estimate: number): void {
    if (this.spent + estimate > this.cap) throw new NeuronCapExceeded(this.spent, this.cap);
  }

  record(neurons: number): void {
    this.spent += neurons;
    this.calls += 1;
  }

  get total(): number {
    return Math.round(this.spent * 10) / 10;
  }

  get callCount(): number {
    return this.calls;
  }

  get remaining(): number {
    return Math.max(0, this.cap - this.spent);
  }
}

/**
 * How the suites decide which mode to run in.
 *
 * Live is opt-in and needs both the flag and a cap. Defaulting to recorded
 * means a developer running the whole test suite locally, or CI running it
 * on a pull request, cannot spend anything by accident.
 */
export function evalMode(): { mode: 'recorded' | 'live'; cap: number } {
  const live = process.env.EVAL_LIVE === 'true';
  const cap = Number(process.env.EVAL_NEURON_CAP ?? '500');
  return {
    mode: live ? 'live' : 'recorded',
    cap: Number.isFinite(cap) && cap > 0 ? cap : 500,
  };
}
