import { describe, expect, it } from 'vitest';
import { createVoiceGlow } from '../packages/cortico-world-desktop-pet/web/voice-glow.js';

const DT = 1 / 60;
/** The light of `seconds` of frames, one entry a frame (null once the voice is idle and the light is out). */
const run = (glow, seconds, state) => Array.from({ length: Math.round(seconds / DT) }, () => glow.next(DT, state));
const GREEN = [0, 168, 112], RED = [255, 0, 0];

describe('the voice as light on the body', () => {
  it('is out while the voice does nothing, comes up when it starts and goes out when it stops', () => {
    const glow = createVoiceGlow();
    expect(glow.next(DT, {})).toBeNull();
    const lit = run(glow, 1, { hearing: true });
    // it starts at the foot of its pulse instead of with a flash
    expect(lit[0].k).toBeLessThan(lit.at(-1).k);
    expect(lit.at(-1).k).toBeGreaterThan(.3);
    const after = run(glow, 2, {});
    expect(after[0].k).toBeGreaterThan(0);
    expect(after.at(-1)).toBeNull();
  });

  it('waits dim while the microphone is open and nothing is said, and comes up with the first word', () => {
    const glow = createVoiceGlow();
    glow.level(-20);
    const waiting = run(glow, 2, { listening: true });
    // an open microphone is not yet a voice: the light stays below the height it holds while hearing
    expect(waiting.at(-1).k).toBeGreaterThan(0);
    expect(waiting.at(-1).k).toBeLessThan(.2);
    const spoken = run(glow, 1, { listening: true, hearing: true });
    expect(spoken.at(-1).k).toBeGreaterThan(waiting.at(-1).k * 2);
  });

  it('sends rings out while it waits for the wake word, and none while it listens', () => {
    // the light of a ring a given number of seconds into the wait
    const ring = (seconds) => run(createVoiceGlow(), seconds, { armed: true }).at(-1).rings[0];
    const own = ring(.96), far = ring(2.9);
    // one ring travels outwards and fades as it goes
    expect(far.s).toBeGreaterThan(own.s);
    expect(far.a).toBeLessThan(own.a);
    // waiting for the word is the dimmest of the waits, and the only one with rings
    expect(run(createVoiceGlow(), 2, { armed: true }).at(-1).k).toBeLessThan(run(createVoiceGlow(), 2, { listening: true }).at(-1).k);
    expect(run(createVoiceGlow(), 1, { hearing: true }).at(-1).rings).toBeNull();
    expect(run(createVoiceGlow(), 1, { speaking: true }).at(-1).rings).toBeNull();
  });

  it('sends rings out with the reply\'s voice, and none through its silences', () => {
    const loud = createVoiceGlow(), quiet = createVoiceGlow();
    loud.speakLevel(-14); quiet.speakLevel(-70);
    expect(run(loud, 1, { speaking: true }).at(-1).rings).toHaveLength(2);
    expect(run(quiet, 1, { speaking: true }).at(-1).rings).toBeNull();
  });

  it('follows the person\'s voice: the louder they are, the brighter the light', () => {
    const quiet = createVoiceGlow(), loud = createVoiceGlow();
    quiet.level(-50); loud.level(-14);
    for (let i = 0; i < 60; i++) {
      const a = quiet.next(DT, { hearing: true }), b = loud.next(DT, { hearing: true });
      expect(b.k).toBeGreaterThan(a.k);
      expect(b.reach).toBeGreaterThan(a.reach);
    }
  });

  it('follows the reply\'s own voice the same way, so reading aloud is not one flat glow', () => {
    const quiet = createVoiceGlow(), loud = createVoiceGlow();
    quiet.speakLevel(-42); loud.speakLevel(-14);
    for (let i = 0; i < 60; i++) {
      const a = quiet.next(DT, { speaking: true }), b = loud.next(DT, { speaking: true });
      expect(b.k).toBeGreaterThan(a.k);
      expect(b.reach).toBeGreaterThan(a.reach);
    }
    // and the reading is brighter than the same pause in a silence
    expect(run(loud, 1, { speaking: true }).at(-1).k).toBeGreaterThan(.5);
  });

  it('lights the body for the answer being read out before the work still going on behind it', () => {
    const speak = createVoiceGlow(), speakAndListen = createVoiceGlow(), listen = createVoiceGlow();
    for (const glow of [speak, speakAndListen]) glow.speakLevel(-12);
    listen.level(-12);
    const reading = run(speak, 1.5, { speaking: true });
    expect(run(speakAndListen, 1.5, { speaking: true, listening: true, thinking: true }).map((f) => f.k)).toEqual(reading.map((f) => f.k));
    expect(run(listen, 1.5, { hearing: true }).map((f) => f.k)).not.toEqual(reading.map((f) => f.k));
  });

  it('pulses faster while reading out than while thinking', () => {
    const spread = (frames) => Math.max(...frames.map((f) => f.k)) - Math.min(...frames.map((f) => f.k));
    // two seconds and a fifth covers one pulse of each
    expect(spread(run(createVoiceGlow(), 2.2, { speaking: true }))).toBeGreaterThan(spread(run(createVoiceGlow(), 2.2, { thinking: true })) * 1.5);
  });

  it('answers a tapped talk key with one breath of light, then goes out', () => {
    const glow = createVoiceGlow();
    glow.cue();
    const pulse = run(glow, .6, {}).filter(Boolean);
    expect(Math.max(...pulse.map((f) => f.k))).toBeGreaterThan(.3);
    expect(run(glow, 1.5, {}).at(-1)).toBeNull();
  });

  it('starts the breath over with each sentence read, instead of carrying the last one on', () => {
    const glow = createVoiceGlow();
    run(glow, .3, { speaking: true });
    const high = glow.next(DT, { speaking: true }).k;
    glow.beat();
    expect(glow.next(DT, { speaking: true }).k).toBeLessThan(high);
  });

  it('turns red when a sentence is lost, stays red for a moment and clears itself while the voice goes on', () => {
    const glow = createVoiceGlow({ rgb: () => GREEN, fault: () => RED });
    run(glow, .5, { hearing: true });
    glow.fault();
    const red = run(glow, 1, { hearing: true });
    expect(red.every((f) => f.rgb === RED)).toBe(true);
    expect(run(glow, 2, { hearing: true }).at(-1).rgb).toBe(GREEN);
  });
});
