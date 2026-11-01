/**
 * Coo's own state between interactions: energy and warmth, each from 0 to 1. A dose moves a value
 * towards its bound by less the closer it already is; time pulls it back towards its base, half the
 * distance every half-life. Nothing here decides what Coo does. `{{pet.mind}}` only says how it
 * feels, and says nothing while nothing stands out.
 */

/** Towards 1, by less the closer the value already is: no sum of doses passes 1. */
export function doseUp(value: number, dose: number): number {
  return value + dose * (1 - value) * (1 + 0.8 * value);
}

/** Towards 0 the same way. */
export function doseDown(value: number, dose: number): number {
  return value - dose * value;
}

/** A value pulled back towards `base`: half the distance is gone after `halfMs`. */
export function leakTo(value: number, base: number, halfMs: number, elapsedMs: number): number {
  if (elapsedMs <= 0 || halfMs <= 0) return value;
  return base + (value - base) * 2 ** (-elapsedMs / halfMs);
}

/** Where energy rests, and how long half of a difference from it takes to leak away. */
const ENERGY_BASE = 0.6;
const ENERGY_HALF_MS = 4 * 60 * 60_000;
/** Warmth cools to nothing: it is about the last few minutes, not the day. */
const WARMTH_BASE = 0;
const WARMTH_HALF_MS = 40 * 60_000;

/** What the mind says of itself, supplied by the model text of the language. */
export interface MindText {
  tired(user: string): string;
  low(user: string): string;
  fresh(user: string): string;
  warm(user: string): string;
}

export class CatMind {
  private energy = ENERGY_BASE;
  private warmth = WARMTH_BASE;
  /** The clock the values were last read at; 0 before the first read, so nothing leaks on it. */
  private at = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** The values as they are now, after the time since the last read has leaked. */
  private read(): { energy: number; warmth: number } {
    const now = this.now();
    if (this.at === 0) this.at = now;
    const elapsed = now - this.at;
    this.energy = leakTo(this.energy, ENERGY_BASE, ENERGY_HALF_MS, elapsed);
    this.warmth = leakTo(this.warmth, WARMTH_BASE, WARMTH_HALF_MS, elapsed);
    this.at = now;
    return { energy: this.energy, warmth: this.warmth };
  }

  /** One touch as the page reported it. */
  touch(kind: 'poke' | 'pet' | 'throw' | 'drop' | 'crash'): void {
    const { energy, warmth } = this.read();
    switch (kind) {
      case 'poke':
        this.energy = doseDown(energy, 0.04);
        this.warmth = doseUp(warmth, 0.08);
        break;
      case 'pet':
        this.energy = doseUp(energy, 0.02);
        this.warmth = doseUp(warmth, 0.12);
        break;
      case 'throw':
        this.energy = doseDown(energy, 0.12);
        this.warmth = doseUp(warmth, 0.03);
        break;
      case 'drop':
        this.energy = doseDown(energy, 0.06);
        break;
      case 'crash':
        this.energy = doseDown(energy, 0.1);
        break;
    }
  }

  /** A walk across `share` of the screen: the distance counts, not the number of orders. */
  walk(share: number): void {
    this.energy = doseDown(this.read().energy, Math.min(Math.abs(share), 1) * 0.12);
  }

  /** How Coo feels, or '' while nothing stands out. */
  line(text: MindText, user: string): string {
    const { energy, warmth } = this.read();
    const lines: string[] = [];
    if (energy < 0.3) lines.push(text.tired(user));
    else if (energy < 0.45) lines.push(text.low(user));
    else if (energy > 0.78) lines.push(text.fresh(user));
    if (warmth > 0.6) lines.push(text.warm(user));
    return lines.join('');
  }
}
