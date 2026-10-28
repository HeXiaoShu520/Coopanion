/** The wire format of both Doubao services, read and written against fixed bytes — no socket here. */
import { gunzipSync, gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  ASR_SAMPLE_RATE,
  AsrReader,
  SpeechFrameError,
  TTS_SAMPLE_RATE,
  audioFrame,
  parseAsrFrame,
  parseTtsFrame,
  startFrame,
  ttsFrame,
} from '../../src/voice/protocol.ts';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

function be32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function beI32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, value, false);
  return bytes;
}

const u32At = (bytes: Uint8Array, at: number): number => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, false);

/** A frame as the recognition service sends it: gzip JSON, and a sequence when its flags say so. */
function response(body: unknown, opts: { flags?: number; sequence?: number } = {}): Uint8Array {
  const payload = gzipSync(utf8(JSON.stringify(body)));
  const flags = opts.flags ?? 1;
  const seq = opts.sequence === undefined ? new Uint8Array(0) : beI32(opts.sequence);
  return concat([Uint8Array.of(0x11, (0x9 << 4) | flags, 0x11, 0), seq, be32(payload.length), payload]);
}

/** An error frame: the code, the size, then the message as UTF-8. */
function errorFrame(code: number, message: string): Uint8Array {
  return concat([Uint8Array.of(0x11, 0xf0, 0x10, 0), be32(code), be32(message.length), utf8(message)]);
}

describe('recognition frames', () => {
  it('opens a session with the audio format, the model and what to return, gzipped JSON behind a size', () => {
    const frame = startFrame({ uid: 'coo', language: 'zh-CN' });
    expect([...frame.subarray(0, 4)]).toEqual([0x11, 0x10, 0x11, 0x00]);
    expect(u32At(frame, 4)).toBe(frame.length - 8);
    const body = JSON.parse(new TextDecoder().decode(gunzipSync(frame.subarray(8)))) as Record<string, unknown>;
    expect(body).toMatchObject({
      user: { uid: 'coo' },
      audio: { format: 'pcm', codec: 'raw', rate: ASR_SAMPLE_RATE, bits: 16, channel: 1, language: 'zh-CN' },
      request: { model_name: 'bigmodel', show_utterances: true, result_type: 'full', end_window_size: 800 },
    });
  });

  it('leaves the language out when the caller has none, and sends hotwords as the service context', () => {
    const frame = startFrame({ uid: 'coo', hotwords: ['Coo', '侧边栏'] });
    const body = JSON.parse(new TextDecoder().decode(gunzipSync(frame.subarray(8)))) as Record<string, unknown>;
    expect(body.audio).not.toHaveProperty('language');
    expect(JSON.parse((body.request as Record<string, string>).context!)).toEqual({ hotwords: [{ word: 'Coo' }, { word: '侧边栏' }] });
  });

  it('marks the last audio frame and numbers frames when the caller numbers them', () => {
    const pcm = Uint8Array.of(1, 2, 3, 4);
    expect([...audioFrame(pcm).subarray(0, 4)]).toEqual([0x11, 0x20, 0x01, 0x00]);
    expect([...audioFrame(pcm, { final: true }).subarray(0, 4)]).toEqual([0x11, 0x22, 0x01, 0x00]);
    const numbered = audioFrame(pcm, { sequence: 2 });
    expect([...numbered.subarray(0, 8)]).toEqual([0x11, 0x21, 0x01, 0x00, 0, 0, 0, 2]);
    expect([...audioFrame(pcm, { final: true, sequence: -3 }).subarray(0, 8)]).toEqual([0x11, 0x23, 0x01, 0x00, 0xff, 0xff, 0xff, 0xfd]);
    expect(u32At(numbered, 8)).toBe(gzipSync(pcm).length);
    expect([...gunzipSync(numbered.subarray(12))]).toEqual([...pcm]);
  });

  it('reads a response with its sequence, and the one that closes the session', () => {
    const frame = parseAsrFrame(response({ result: { text: '你好' } }, { flags: 1, sequence: 2 }));
    expect(frame).toMatchObject({ kind: 'json', sequence: 2, last: false });
    expect(frame.kind === 'json' ? frame.payload : null).toEqual({ result: { text: '你好' } });

    const last = parseAsrFrame(response({ result: { text: '你好。' } }, { flags: 2 }));
    expect(last).toMatchObject({ kind: 'json', sequence: null, last: true });
  });

  it('reads an error frame as the code and the message', () => {
    expect(parseAsrFrame(errorFrame(45_000_001, 'quota exceeded'))).toEqual({ kind: 'error', code: 45_000_001, message: 'quota exceeded' });
  });

  it('refuses a frame it cannot make sense of', () => {
    expect(() => parseAsrFrame(Uint8Array.of(0x11, 0x10))).toThrow(SpeechFrameError);
    expect(() => parseAsrFrame(Uint8Array.of(0x11, 0xb0, 0x10, 0, 0, 0, 0, 0))).toThrow(SpeechFrameError);
  });
});

describe('AsrReader', () => {
  it('gives the text so far with only the utterances that just closed, each once', () => {
    const reader = new AsrReader();
    const first = reader.read({ result: { text: '你好世', utterances: [{ text: '你好', definite: true, start_time: 0, end_time: 500 }, { text: '世界', definite: false }] } }, false);
    expect(first).toEqual({ partial: '你好世', finals: ['你好'], last: false });

    // the service repeats the settled utterance in every later frame of the session
    const second = reader.read({ result: { text: '你好世界。', utterances: [{ text: '你好', definite: true, start_time: 0, end_time: 500 }, { text: '世界。', definite: true, start_time: 500, end_time: 900 }] } }, true);
    expect(second).toEqual({ partial: '你好世界。', finals: ['世界。'], last: true });

    expect(reader.read({}, true)).toEqual({ partial: '', finals: [], last: true });
  });
});

describe('synthesis frames', () => {
  it('asks for PCM at the rate playback takes, with the filters the cleaned text no longer needs', () => {
    const frame = ttsFrame('你好', { speaker: 'zh_female_vv_uranus_bigtts' });
    expect([...frame.subarray(0, 4)]).toEqual([0x11, 0x10, 0x10, 0x00]);
    const body = JSON.parse(new TextDecoder().decode(frame.subarray(8))) as Record<string, unknown>;
    expect(body).toEqual({
      req_params: {
        text: '你好',
        speaker: 'zh_female_vv_uranus_bigtts',
        audio_params: { format: 'pcm', sample_rate: TTS_SAMPLE_RATE },
        additions: JSON.stringify({ disable_markdown_filter: true, disable_emoji_filter: true, max_length_to_filter_parenthesis: 100 }),
      },
    });
    expect(u32At(frame, 4)).toBe(frame.length - 8);
  });

  it('reads an audio frame as the PCM it carries', () => {
    const pcm = Uint8Array.of(9, 8, 7);
    const frame = concat([Uint8Array.of(0x11, 0xb0, 0x00, 0), be32(pcm.length), pcm]);
    expect(parseTtsFrame(frame)).toEqual({ kind: 'audio', payload: pcm });
  });

  it('reads the empty object that ends the stream, after the session id frame when one comes', () => {
    const end = concat([Uint8Array.of(0x11, 0x90, 0x10, 0), be32(2), utf8('{}')]);
    expect(parseTtsFrame(end)).toEqual({ kind: 'json', payload: {}, end: true });

    const sessionId = utf8('session-1');
    const withSession = concat([Uint8Array.of(0x11, 0x94, 0x10, 0), be32(0), be32(sessionId.length), sessionId, be32(2), utf8('{}')]);
    expect(parseTtsFrame(withSession)).toEqual({ kind: 'json', payload: {}, end: true });
  });

  it('reads the error frame, and a body that is not the end of the stream', () => {
    expect(parseTtsFrame(errorFrame(35_000_000, 'no quota'))).toEqual({ kind: 'error', code: 35_000_000, message: 'no quota' });
    const body = utf8('{"error":"speaker not found"}');
    const frame = concat([Uint8Array.of(0x11, 0x90, 0x10, 0), be32(body.length), body]);
    expect(parseTtsFrame(frame)).toEqual({ kind: 'json', payload: { error: 'speaker not found' }, end: false });
  });
});
