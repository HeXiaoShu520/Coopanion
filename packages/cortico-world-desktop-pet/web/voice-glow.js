/**
 * The voice as light on Coo's body: a glow in its own colour that waits while the microphone is open,
 * comes up when the person speaks, breathes while the answer is worked out and read out, one pulse for
 * a tapped talk key, and red for a moment when a sentence is lost. What was heard or said is still the
 * bubbles' business (`pet-app.js` lines); this answers "is it listening?" to someone who is not reading
 * them, and "is what it hears me or the room?" to someone who is.
 *
 * The light takes the form the body already has for its halo (`body-host.js` setHalo): a coloured drop
 * shadow of the figure, so it follows the silhouette instead of boxing it in.
 */

/**
 * One phase's pulse: its period in seconds, the share of light it swings by and starts from, how far the
 * light reaches in pixels, and what the person's own voice adds while it is heard.
 *
 * `wait` is the microphone open with nothing said yet: dim and slow, so an open microphone reads as
 * "I am here" instead of claiming words that have not come.
 */
const PHASES = {
  wait: { period: 3.4, base: .10, swing: .07, voice: 0, reach: 5, reachSwing: 1, reachVoice: 0 },
  listen: { period: 1.15, base: .34, swing: .30, voice: .34, reach: 8, reachSwing: 3, reachVoice: 5 },
  think: { period: 2.2, base: .22, swing: .16, voice: 0, reach: 6, reachSwing: 2, reachVoice: 0 },
  speak: { period: .62, base: .34, swing: .30, voice: 0, reach: 8, reachSwing: 2, reachVoice: 0 },
  cue: { period: .45, base: .20, swing: .30, voice: 0, reach: 7, reachSwing: 3, reachVoice: 0 },
  error: { period: .5, base: .62, swing: .26, voice: 0, reach: 12, reachSwing: 1, reachVoice: 0 },
};
/** Seconds the light takes to come up when the voice starts and to go out when it ends. */
const FADE = .3;
/** How long a failure keeps the light red, in milliseconds. */
const FAULT_MS = 1600;
/** How long the answer to a tapped talk key lasts, in milliseconds: one breath, then the talking takes over. */
const CUE_MS = 450;
/** Seconds that answer takes to come up: shorter than a talk takes to start, so the tap is felt at once. */
const CUE_FADE = .12;
/** Seconds the microphone's level takes to reach a new reading; the World samples it ten times a second. */
const LEVEL_TAU = .09;
/** dBFS of a voice at full strength and of one that is not there: the light moves with what lies between. */
const LOUD = { none: -52, full: -12 };
/** The most light there is; above this the body stops reading as a shape. */
const K_MAX = .95;

/**
 * `rgb` is the light's colour, `fault` the one a failure takes, both `[r, g, b]` and read once a frame, so
 * the page can follow its theme without telling the glow about it.
 */
export function createVoiceGlow({ rgb = () => [0, 168, 112], fault = () => [229, 72, 77] } = {}) {
  let t = 0, level = LOUD.none, hear = 0, env = 0, phase = null, since = 0, faultUntil = 0, cueUntil = 0;

  return {
    /** The microphone's level in dBFS; `listen` moves the light with it. */
    level(db) {
      if (Number.isFinite(db)) level = db;
    },
    /** Something of the voice failed: the light turns red for a moment. */
    fault(at = t) {
      faultUntil = at + FAULT_MS / 1000;
    },
    /** The talk key was tapped: one breath that says Coo is there, before the words come. */
    cue(at = t) {
      cueUntil = at + CUE_MS / 1000;
    },
    /** A piece of the reply starts: its breath starts over, so the light follows the sentences read. */
    beat(at = t) {
      if (phase === 'speak') since = at;
    },
    /**
     * The halo to draw this frame — `{ k, reach, rgb }` — or null when the voice is doing nothing.
     * `state` is the page's `{ listening, hearing, speaking, thinking }`: the microphone is open, words
     * are being heard, a reply is being read out, an answer is being worked out. The first that holds
     * wins, an answer being read out before the work still going on behind it.
     */
    next(dt, state = {}) {
      const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
      t += step;
      const now = t < faultUntil ? 'error'
        : t < cueUntil ? 'cue'
          : state.speaking ? 'speak'
            : state.hearing ? 'listen'
              : state.thinking ? 'think'
                : state.listening ? 'wait'
                  : null;
      if (now !== phase) { phase = now; since = t; }
      env += ((phase ? 1 : 0) - env) * Math.min(1, step / (phase === 'cue' ? CUE_FADE : FADE));
      if (!phase && env < .02) { env = 0; return null; }
      // a level read ten times a second would step the light: smoothing it reads as the person breathing,
      // and starting from silence lets the light rise with the first word instead of at full height
      const heard = phase === 'listen' ? Math.max(0, Math.min(1, (level - LOUD.none) / (LOUD.full - LOUD.none))) : 0;
      hear += (heard - hear) * (1 - Math.exp(-step / LEVEL_TAU));
      const p = PHASES[phase ?? 'think'];
      // one pulse, from its foot up, so a phase starts small instead of with a flash
      const wave = .5 - .5 * Math.cos((t - since) * 2 * Math.PI / p.period);
      return {
        k: Math.min(K_MAX, env * (p.base + p.swing * wave + p.voice * hear)),
        reach: p.reach + p.reachSwing * wave + p.reachVoice * hear,
        rgb: phase === 'error' ? fault() : rgb(),
      };
    },
  };
}
