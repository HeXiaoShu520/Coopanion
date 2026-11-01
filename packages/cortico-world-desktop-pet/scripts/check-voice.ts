/**
 * Manual end-to-end check of voice input against Doubao: one WAV through the segmenter, the real
 * recognition service and the speech event, with nothing else.
 *
 *   set DESKTOP_PET_DOUBAO_API_KEY=…
 *   npx tsx scripts/check-voice.ts <speech.wav> [app language, zh when absent]
 *
 * The Key is the deployment secret Core hands the World (`DESKTOP_PET_SECRETS.doubaoApiKey`), the
 * same one reading replies aloud uses. The WAV (mono PCM16, any rate) goes over the pet socket in
 * 20 ms frames; what the bubble showed and the speech event are printed.
 */
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLanguage } from 'cortico/core/language.ts';
import { DESKTOP_PET_DEFAULTS, DESKTOP_PET_SECRETS } from '../src/config.ts';
import { DesktopPetWorld } from '../src/world.ts';
import { FakeHost } from '../tests/helpers/fake-host.ts';
import { FakePage } from '../tests/helpers/page.ts';

const [wavFile, language = 'zh'] = process.argv.slice(2);
if (!wavFile || !isLanguage(language)) throw new Error('usage: check-voice.ts <wav> [app language]');
const key = process.env[DESKTOP_PET_SECRETS.doubaoApiKey] ?? '';
if (!key) throw new Error(`${DESKTOP_PET_SECRETS.doubaoApiKey} is not set`);

function readWav(file: string): Int16Array {
  const b = readFileSync(file);
  const rate = b.readUInt32LE(24);
  let at = 12;
  while (b.toString('ascii', at, at + 4) !== 'data') at += 8 + b.readUInt32LE(at + 4);
  const pcm = new Int16Array(b.buffer.slice(b.byteOffset + at + 8, b.byteOffset + at + 8 + b.readUInt32LE(at + 4)));
  const out = new Int16Array(Math.floor(pcm.length * 16000 / rate));
  for (let i = 0; i < out.length; i++) out[i] = pcm[Math.floor(i * rate / 16000)]!;
  return out;
}

const cfg = structuredClone(DESKTOP_PET_DEFAULTS);
Object.assign(cfg, { enabled: true, port: 0 });
cfg.window.enabled = false;
cfg.asr.mic.mode = 'always';
const world = new DesktopPetWorld({
  cfg, timezone: 'Asia/Shanghai', persist: () => {}, runtimesRoot: () => mkdtempSync(join(tmpdir(), 'pet-check-')), modelsDir: () => mkdtempSync(join(tmpdir(), 'pet-check-m-')),
  language: () => language, doubaoApiKey: () => key,
});
const host = new FakeHost();
await world.start(host);
console.log('server', JSON.stringify(world.voiceState().server), 'doubao', JSON.stringify(world.voiceState().doubao));
if ((world.voiceState().server as { phase: string }).phase !== 'running') throw new Error('the recognizer did not start; see its detail above');
const page = await FakePage.open(world.petUrl.replace(/\/pet$/, ''));
const shown: string[] = [];
void (async () => {
  for (;;) {
    const m = await page.next((x) => x.t === 'listen' && (x.phase === 'partial' || x.phase === 'heard')).catch(() => null);
    if (!m) return;
    shown.push(`${m.phase}: ${m.text ?? ''}${m.interim ? ` [${m.interim}]` : ''}`);
  }
})();
const pcm = readWav(wavFile);
const frames = Math.ceil(pcm.length / 320);
for (let f = 0; f < frames + 60; f++) {
  const fr = new Int16Array(320);
  if (f < frames) fr.set(pcm.subarray(f * 320, f * 320 + 320));
  page.audio(fr);
  await new Promise((r) => setTimeout(r, 20));
}
const deadline = Date.now() + 60_000;
while (host.events.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
console.log('bubble', shown);
console.log('events', host.events.map((e) => e.text));
console.log('voice', JSON.stringify(world.voiceState().recent));
await page.close();
await world.stop();
process.exit(host.events.length ? 0 : 1);
