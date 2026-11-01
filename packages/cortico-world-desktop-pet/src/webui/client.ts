/**
 * Console panels for the desktop pet: `pet` (window, dressing, window runtime) and `voice`
 * (Doubao's address and API Key (api-rows.ts), its state, microphone level, recognized lines,
 * reading replies aloud and the wake word). Data goes through `ctx.invoke`, the level meter through
 * `ctx.stream('voice')`. Text is the World's table (src/i18n) for the console's language.
 */
import type { WebUiClientBundle, WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { petText } from '../i18n/index.ts';
import { captureKey, PRESSES, splitTaps, withTaps } from './key-capture.ts';
import { doubaoRows, type UrlKeyState } from './api-rows.ts';
import './style.css';

interface Artifact { phase: 'absent' | 'working' | 'ready' | 'error'; path: string; done: number; total: number | null; detail: string | null }
interface PetState {
  inWindow: boolean;
  url: string | null;
  dressUrl: string | null;
  window: { phase: string; pid: number | null; source: string | null; detail: string | null } | null;
  electron: Artifact & { supported: boolean };
  screen: { w: number; h: number } | null;
}
interface VoiceState {
  enabled: boolean;
  /** Doubao's recognition: whether it can hear, and why not. */
  server: { phase: 'stopped' | 'running' | 'error'; url: string; pid: null; detail: string | null } | null;
  /** Doubao's address and whether a key is saved; recognition and synthesis share both. */
  doubao: UrlKeyState;
  /** Reading replies aloud: the settings, and why nothing can be read (no Key). */
  tts: { enabled: boolean; voice: string; speed: number; volume: number; maxChars: number; clean: boolean; problem: string | null };
  /** The wake word: what may wake the pet, and why it is not hearing. */
  wake: {
    enabled: boolean;
    keywords: string;
    threshold: number;
    cooldownMs: number;
    phase: 'stopped' | 'listening' | 'error';
    /** Why nothing can wake the pet now. */
    detail: string | null;
    /** The words as the keywords file has them, which is what the panel shows. */
    words: string[];
    model: Artifact;
  };
  mic: { state: string; detail: string | null };
  input: {
    mode: MicMode;
    hotkey: string;
    deviceId: string;
    openOnPress: boolean;
    /** How long one round the talk key opens or switches on runs, in seconds. */
    roundSeconds: number;
    /** The keys alone; how they are pressed is the press choice beside them */
    keyLabel: string;
    hint: string;
    hotkeyProblem: string | null;
    open: boolean;
    devices: Array<{ id: string; label: string }>;
  };
  level: number;
  thresholdDb: number;
  recent: Array<{ text: string; at: number; ms: number; dropped?: boolean }>;
  counts: { utterances: number; delivered: number; dropped: number };
}

type MicMode = 'hold' | 'always';

const MB = (n: number) => `${Math.round(n / 1048576)} MB`;
/** The voice Doubao's synthesis takes when none is named; a hint in the panel's field. */
const DEFAULT_VOICE = 'zh_female_vv_uranus_bigtts';
const progress = (a: Artifact) => (a.total ? `${Math.round((a.done / a.total) * 100)}%` : MB(a.done));
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function statusRow(ctx: WebUiPanelContext, name: string) {
  const { ui } = ctx;
  const row = ui.h('div', 'mountrow');
  const dot = ui.h('span', 'navdot');
  const state = ui.h('span', 'mstate', '—');
  const detail = ui.h('span', 'mdetail');
  const acts = ui.h('span', 'macts');
  row.append(dot, ui.h('span', 'mname', name), state, detail, acts);
  return {
    row, acts,
    set(text: string, tone: 'on' | 'off' | 'busy' | 'bad', more = '') {
      state.textContent = text;
      detail.textContent = more;
      // cut with an ellipsis where the row is short of room: the whole line on hover
      detail.title = more;
      dot.className = `navdot ${tone === 'on' ? 'ok' : tone === 'bad' ? 'bad' : tone === 'busy' ? 'warn' : ''}`;
    },
  };
}

/** A card without a heading: the tab above it already names the page. */
function untitledSheet(ui: WebUiPanelContext['ui']): { el: HTMLElement; body: HTMLElement } {
  const el = ui.h('div', 'sheet tabbed pet-untitled');
  const body = ui.h('div', 'sheetbody');
  el.append(body);
  return { el, body };
}

const petPanel: WebUiPanel = {
  mount(ctx) {
    const { ui, root } = ctx;
    const t = petText(ctx.language).panel;
    const card = untitledSheet(ui);
    root.appendChild(card.el);
    const s = card.body;
    const msg = ui.msgline('');

    const win = statusRow(ctx, t.window);
    const btnOpen = ui.button(t.openWindow, { size: 'sm', variant: 'primary' });
    const btnClose = ui.button(t.closeWindow, { size: 'sm' });
    win.acts.append(btnClose, btnOpen);

    const rt = statusRow(ctx, t.runtime);
    const btnInstall = ui.button(t.install, { size: 'sm', variant: 'primary' });
    rt.acts.append(btnInstall);

    const dress = ui.sheet({ title: t.dress, desc: t.dressHint });
    root.appendChild(dress.el);
    const frameWrap = ui.h('div', 'pet-dressframe');
    const frame = ui.h('iframe');
    frame.title = t.dress;
    frameWrap.append(frame);
    dress.body.append(frameWrap);

    s.append(win.row, rt.row, msg);

    let st: PetState | null = null;
    const render = (next: PetState) => {
      st = next;
      const w = next.window;
      if (next.inWindow) win.set(t.connected, 'on');
      else if (w?.phase === 'running') win.set(t.starting, 'busy');
      else win.set(w?.phase === 'missing' || w?.phase === 'error' ? t.cannotOpen : t.notOpen, w?.phase === 'missing' || w?.phase === 'error' ? 'bad' : 'off', w?.detail ?? '');
      btnOpen.disabled = w?.phase === 'running';
      btnClose.disabled = w?.phase !== 'running';
      const e = next.electron;
      if (w?.source && w.source !== e.path && e.phase !== 'ready') rt.set(t.external, 'on', w.source);
      else if (e.phase === 'ready') rt.set(t.installed, 'on', e.path);
      else if (e.phase === 'working') rt.set(t.downloading(progress(e)), 'busy', e.detail ?? '');
      else if (e.phase === 'error') rt.set(t.installFailed, 'bad', e.detail ?? '');
      else rt.set(e.supported ? t.notInstalled : t.noBuild, 'off', e.supported ? t.electronSize : '');
      btnInstall.hidden = e.phase === 'ready' || !e.supported;
      btnInstall.disabled = e.phase === 'working';
      if (next.dressUrl && frame.dataset.src !== next.dressUrl) {
        frame.dataset.src = next.dressUrl;
        frame.src = next.dressUrl;
      }
    };
    const refresh = async () => { try { render(await ctx.invoke<PetState>('state')); } catch (err) { msg.textContent = errText(err); } };
    const call = (method: string) => async () => {
      try { render(await ctx.invoke<PetState>(method)); } catch (err) { msg.textContent = errText(err); }
    };
    btnOpen.addEventListener('click', call('openWindow'));
    btnClose.addEventListener('click', call('closeWindow'));
    btnInstall.addEventListener('click', call('installElectron'));
    void refresh();
    ctx.interval(() => void refresh(), 1500);
  },
};

const FLOOR_DB = -60;
const meterPct = (db: number) => Math.max(0, Math.min(100, ((db - FLOOR_DB) / -FLOOR_DB) * 100));
/** The threshold the mark can be set to: the meter's span, whole dB. */
const markDb = (db: number) => Math.round(Math.max(FLOOR_DB, Math.min(0, db)));
const ARROW_STEPS: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };

const voicePanel: WebUiPanel = {
  mount(ctx) {
    const { ui, root } = ctx;
    const text = petText(ctx.language);
    const t = text.panel;
    const card = untitledSheet(ui);
    root.appendChild(card.el);
    const s = card.body;
    const msg = ui.msgline('');

    // The master switch: everything below only works while it is on.
    const master = ui.h('label', 'pet-master');
    const masterText = ui.h('span', 'pet-mastertext');
    const masterTitle = ui.h('span', 'pet-mastertitle', t.enable);
    const masterHint = ui.h('span', 'pet-masterhint');
    masterText.append(masterTitle, masterHint);
    const enabled = ui.h('input', 'pet-switch');
    enabled.type = 'checkbox';
    enabled.setAttribute('role', 'switch');
    enabled.addEventListener('change', () => void call('setEnabled', [enabled.checked])());
    master.append(masterText, enabled);
    // the rows that answer how a sentence starts, in that order; what the service needs is behind 更多设置
    const settings = ui.h('div', 'pet-voicebody');
    const more = ui.h('div', 'pet-voicebody');

    const srv = statusRow(ctx, t.server);
    const doubao = doubaoRows(ctx, t, (name) => statusRow(ctx, name), (patch) => void call('setDoubao', [patch])());

    const micRow = statusRow(ctx, t.mic);
    const deviceSel = ui.select();
    micRow.acts.append(deviceSel);

    const modeRow = statusRow(ctx, t.mode);
    const modeSel = ui.select();
    modeSel.replaceChildren(...(Object.keys(t.modes) as MicMode[]).map((m) => { const o = ui.h('option', null, t.modes[m]); o.value = m; return o; }));
    const pressSel = ui.select();
    modeRow.acts.append(modeSel);
    // hold mode only: the microphone opens with the talk key
    const onPressRow = statusRow(ctx, t.openOnPress);
    const onPress = ui.h('input', 'pet-switch');
    onPress.type = 'checkbox';
    onPress.setAttribute('role', 'switch');
    onPress.addEventListener('change', () => void call('setMic', [{ openOnPress: onPress.checked }])());
    onPressRow.acts.append(onPress);
    // the talk key has a row of its own above how it listens: the key, how it is pressed, and a button for another
    const keyRow = statusRow(ctx, t.talkKeyName);
    const keyBtn = ui.button(t.changeKey, { size: 'sm' });
    keyRow.acts.append(pressSel, keyBtn);

    // the level meter as one more row: its name in the names' column, the bar where the others' values start
    const meterRow = ui.h('div', 'mountrow pet-meterrow');
    const meterDot = ui.h('span', 'navdot');
    meterDot.style.visibility = 'hidden';
    const meterWrap = ui.h('div', 'pet-meterwrap');
    const meter = ui.h('div', 'pet-meter');
    const fill = ui.h('div', 'pet-meterfill');
    meter.append(fill);
    // the speech threshold, dragged along the meter or moved with the arrow keys
    const mark = ui.h('div', 'pet-metermark');
    mark.tabIndex = 0;
    mark.title = t.thresholdHint;
    mark.setAttribute('role', 'slider');
    mark.setAttribute('aria-label', text.config.thresholdDb.title);
    mark.setAttribute('aria-valuemin', String(FLOOR_DB));
    mark.setAttribute('aria-valuemax', '0');
    meterWrap.append(meter, mark);
    meterRow.append(meterDot, ui.h('span', 'mname', t.level), meterWrap);

    const log = ui.log({ max: 100, empty: t.noResults });
    s.append(master, msg, settings);

    // 「朗读」: the same Key reads the replies that answered words heard through the microphone
    const read = ui.sheet({ title: t.read, desc: t.readHint });
    root.appendChild(read.el);
    const readOn = ui.h('input', 'pet-switch');
    readOn.type = 'checkbox';
    readOn.setAttribute('role', 'switch');
    readOn.addEventListener('change', () => void call('setTts', [{ enabled: readOn.checked }])());
    const readRow = statusRow(ctx, t.read);
    const readBody = ui.h('div', 'pet-voicebody pet-groupblock');
    /** A number the person types: committed on change, so a half-typed value is never saved. */
    const numberRow = (name: string, hint: string, attrs: { min: number; max: number; step: number }, method = 'setTts') => {
      const line = statusRow(ctx, name);
      const field = ui.input({ type: 'number' });
      field.min = String(attrs.min);
      field.max = String(attrs.max);
      field.step = String(attrs.step);
      field.style.flex = '0 0 6em';
      field.addEventListener('change', () => {
        const value = Number(field.value);
        if (Number.isFinite(value) && st) void call(method, [{ [hint]: value }])();
      });
      line.acts.append(field);
      return { row: line.row, field };
    };
    const voiceRow = statusRow(ctx, text.config.ttsVoice.title);
    const voiceField = ui.input({ placeholder: DEFAULT_VOICE, cls: 'mono' });
    voiceField.style.flex = '0 1 18em';
    voiceField.addEventListener('change', () => void call('setTts', [{ voice: voiceField.value }])());
    voiceRow.acts.append(voiceField);
    const speed = numberRow(text.config.ttsSpeed.title, 'speed', { min: 0.5, max: 2, step: 0.1 });
    const volume = numberRow(text.config.ttsVolume.title, 'volume', { min: 0, max: 1, step: 0.05 });
    const chars = numberRow(text.config.ttsMaxChars.title, 'maxChars', { min: 40, max: 600, step: 10 });
    // the cleaner drops code blocks, links, emoji and long asides before anything is read
    const cleanOn = ui.h('input', 'pet-switch');
    cleanOn.type = 'checkbox';
    cleanOn.setAttribute('role', 'switch');
    cleanOn.addEventListener('change', () => void call('setTts', [{ clean: cleanOn.checked }])());
    const cleanRow = statusRow(ctx, text.config.ttsClean.title);
    cleanRow.acts.append(cleanOn);
    const btnPreview = ui.button(t.preview, { size: 'sm', variant: 'primary' });
    // 试听 sits beside the switch it tries: the numbers it uses are behind 更多设置
    readRow.acts.append(btnPreview, readOn);
    readBody.append(voiceRow.row, speed.row, volume.row, chars.row, cleanRow.row);
    const readMsg = ui.msgline('');
    read.body.append(readRow.row, readMsg);

    // 「叫名字」: the same microphone, opened by a word instead of the key. The two are the two ways
    // a sentence starts, so its row sits beside the talk key rather than in a card of its own.
    const wake = text.wake;
    const wakeOn = ui.h('input', 'pet-switch');
    wakeOn.type = 'checkbox';
    wakeOn.setAttribute('role', 'switch');
    wakeOn.addEventListener('change', () => void call('setWake', [{ enabled: wakeOn.checked }])());
    const wakeRow = statusRow(ctx, wake.enabled.title);
    // the model is what makes this row work at all, so its download sits here and not behind 更多设置
    const btnWakeModel = ui.button(t.download, { size: 'sm', variant: 'primary' });
    wakeRow.acts.append(btnWakeModel, wakeOn);
    // the words are the model's own tokens, which the hint beside the box says; the rest is tuning
    const wakeWordsRow = statusRow(ctx, wake.keywords.title);
    // the rows below it tune the word rather than the recognizer
    wakeWordsRow.row.classList.add('pet-groupstart');
    const wakeWords = ui.textarea({ rows: 4, placeholder: wake.hint });
    wakeWords.spellcheck = false;
    wakeWords.addEventListener('change', () => void call('setWake', [{ keywords: wakeWords.value }])());
    const wakeThreshold = numberRow(wake.threshold.title, 'threshold', { min: 0.05, max: 0.9, step: 0.05 }, 'setWake');
    const wakeCooldown = numberRow(wake.cooldownMs.title, 'cooldownMs', { min: 0, max: 10000, step: 100 }, 'setWake');
    const wakeModelRow = statusRow(ctx, wake.model);

    // how long one round of listening runs before what was heard goes out
    const roundRow = numberRow(t.roundSeconds, 'roundSeconds', { min: 5, max: 300, step: 5 }, 'setMic');

    settings.append(srv.row, ...doubao.rows, micRow.row, modeRow.row, keyRow.row, wakeRow.row, meterRow);
    // behind 更多设置: how the microphone opens, how long a round runs, how replies are read, and the word that starts a sentence
    more.append(onPressRow.row, roundRow.row, readBody, wakeWordsRow.row, wakeWords, wakeThreshold.row, wakeCooldown.row, wakeModelRow.row);
    more.hidden = true;
    const moreBtn = ui.button(t.more, { size: 'sm' });
    const moreWrap = ui.h('div', 'pet-morebtn');
    moreWrap.append(moreBtn);
    /** Whether a row behind the button is in a state the person has to act on */
    let moreTrouble = false;
    const moreLabel = () => (more.hidden ? (moreTrouble ? t.moreTrouble : t.more) : t.less);
    moreBtn.addEventListener('click', () => {
      more.hidden = !more.hidden;
      moreBtn.textContent = moreLabel();
    });
    s.append(moreWrap, more);

    // 识别结果 is a log a person reads while something is wrong: it stays folded until asked for
    const results = ui.sheet({ title: t.results });
    const logHint = ui.h('div', 'pet-masterhint', t.resultsHint);
    const logBtn = ui.button(t.showLog, { size: 'sm' });
    const logWrap = ui.h('div', 'pet-morebtn');
    logWrap.append(logBtn);
    log.el.hidden = true;
    logHint.hidden = true;
    logBtn.addEventListener('click', () => {
      log.el.hidden = !log.el.hidden;
      logHint.hidden = log.el.hidden;
      logBtn.textContent = log.el.hidden ? t.showLog : t.hideLog;
    });
    results.body.append(logWrap, logHint, log.el);
    root.appendChild(results.el);

    let st: VoiceState | null = null;
    let seen = 0;
    /** The threshold under the pointer while the mark is held */
    let held: number | null = null;
    const placeMark = (db: number) => {
      mark.style.left = `${meterPct(db)}%`;
      mark.setAttribute('aria-valuenow', String(db));
      mark.setAttribute('aria-valuetext', `${db} dBFS`);
    };
    /** The line under the master switch: how a sentence starts right now, the wake word being the second way. */
    const talkHint = (mode: MicMode, key: string, word: string) => {
      const h = t.talkHint;
      if (mode === 'always') return h.always;
      return word ? h.wakeHold(key, word) : h.hold(key);
    };
    const render = (next: VoiceState) => {
      st = next;
      enabled.checked = next.enabled;
      master.classList.toggle('on', next.enabled);
      const onPressOn = next.input.mode === 'hold' && next.input.openOnPress;
      // the wake word is only a second way in while it is actually hearing
      const wakeWord = next.wake.enabled && next.wake.phase === 'listening' ? next.wake.words[0] ?? '' : '';
      masterHint.textContent = !next.enabled
        ? t.disabledHint
        : onPressOn ? t.enabledHintOnPress : talkHint(next.input.mode, next.input.keyLabel, wakeWord);
      settings.classList.toggle('off', !next.enabled);
      more.classList.toggle('off', !next.enabled);
      const sv = next.server;
      if (!sv) srv.set('—', 'off');
      else if (sv.phase === 'running') srv.set(t.ready, 'on', sv.url);
      else if (sv.phase === 'error') srv.set(t.error, 'bad', sv.detail ?? '');
      else srv.set(t.stopped, 'off', sv.url);
      doubao.render(next.doubao, next.enabled);

      // reading aloud: independent of the recognition switch above, one Key for both
      const read0 = next.tts;
      readOn.checked = read0.enabled;
      // the card's own line already says how it sounds: this row only speaks up when nothing can be read
      readRow.set(read0.enabled ? t.switchOn : t.switchOff, read0.problem ? 'bad' : read0.enabled ? 'on' : 'off', read0.problem ?? '');
      // behind 更多设置 it sits inside a body that already dims with the master switch: dim it once
      readBody.classList.toggle('off', next.enabled && !read0.enabled);
      if (document.activeElement !== voiceField) voiceField.value = read0.voice;
      if (document.activeElement !== speed.field) speed.field.value = String(read0.speed);
      if (document.activeElement !== volume.field) volume.field.value = String(read0.volume);
      if (document.activeElement !== chars.field) chars.field.value = String(read0.maxChars);
      cleanOn.checked = read0.clean;
      btnPreview.disabled = !!read0.problem;

      // the wake word: its own switch, its words, and the model the spotter loads
      const wk = next.wake;
      wakeOn.checked = wk.enabled;
      const words = wk.words.length ? wake.words(wk.words.join('、')) : wake.hint;
      // the spotter hears the frames the recognizer's microphone sends: with voice input off there are none
      const hearing = wk.enabled && next.enabled && wk.phase === 'listening';
      const problem = wk.enabled ? wk.detail : null;
      const wm = wk.model;
      // the model's download shows on this row: it is what the row is waiting for, and the button is gone by then
      const fetching = wm.phase === 'working' ? t.downloading(progress(wm)) : null;
      wakeRow.set(
        fetching ?? (hearing ? t.switchOn : t.switchOff),
        fetching ? 'busy' : problem ? 'bad' : hearing ? 'on' : 'off',
        fetching ? wm.detail ?? '' : problem ?? (!next.enabled ? t.disabledHint : words),
      );
      if (document.activeElement !== wakeWords) wakeWords.value = wk.keywords;
      if (document.activeElement !== wakeThreshold.field) wakeThreshold.field.value = String(wk.threshold);
      if (document.activeElement !== wakeCooldown.field) wakeCooldown.field.value = String(wk.cooldownMs);
      if (wm.phase === 'working') wakeModelRow.set(t.downloading(progress(wm)), 'busy', wm.detail ?? '');
      else if (wm.phase === 'error') wakeModelRow.set(t.downloadFailed, 'bad', wm.detail ?? '');
      else if (wm.phase === 'ready') wakeModelRow.set(t.downloaded, 'on', wm.path);
      else wakeModelRow.set(t.notDownloaded, 'off', '');
      btnWakeModel.disabled = wm.phase === 'working';
      btnWakeModel.hidden = wm.phase === 'ready' || wm.phase === 'working';
      btnWakeModel.textContent = wm.phase === 'error' ? t.retry : t.download;
      // the rows behind the button can stop working where nobody sees them: the button says which
      moreTrouble = wm.phase === 'error';
      moreBtn.textContent = moreLabel();

      const mic = next.mic;
      micRow.set(t.micStates[mic.state] ?? mic.state, mic.state === 'on' ? 'on' : mic.state === 'off' ? 'off' : 'bad', mic.detail ?? '');
      const input = next.input;
      const choices = [{ id: '', label: t.defaultDevice }, ...input.devices];
      if (input.deviceId && !choices.some((d) => d.id === input.deviceId)) choices.push({ id: input.deviceId, label: t.missingDevice });
      if (deviceSel.dataset.list !== JSON.stringify(choices)) {
        deviceSel.dataset.list = JSON.stringify(choices);
        deviceSel.replaceChildren(...choices.map((d, i) => { const o = ui.h('option', null, d.label || t.micN(i)); o.value = d.id; return o; }));
      }
      if (document.activeElement !== deviceSel) deviceSel.value = input.deviceId;
      if (document.activeElement !== modeSel) modeSel.value = input.mode;
      // a talk key set to three presses in config.json keeps its choice; the panel offers two or one
      const { taps } = splitTaps(input.hotkey);
      const presses = PRESSES.filter((n) => n < 3 || n === taps).map((n) => [n, t.presses[n]!] as const);
      if (pressSel.dataset.list !== JSON.stringify(presses)) {
        pressSel.dataset.list = JSON.stringify(presses);
        pressSel.replaceChildren(...presses.map(([n, label]) => { const o = ui.h('option', null, label); o.value = String(n); return o; }));
      }
      if (document.activeElement !== pressSel) pressSel.value = String(taps);
      // 「一直收音」 hides the key's row, its 「取消」 with it: a capture still listening there ends
      if (capture && input.mode === 'always') capture.stop();
      if (!capture) keyRow.set(input.keyLabel, input.hotkeyProblem ? 'bad' : 'on');
      pressSel.hidden = input.mode === 'always';
      keyRow.row.style.display = input.mode === 'always' ? 'none' : '';
      modeRow.set(input.open ? t.listening : t.waitingKey, input.open ? 'on' : 'off', input.hint);
      onPressRow.row.style.display = input.mode === 'hold' ? '' : 'none';
      onPress.checked = input.openOnPress;
      onPressRow.set(input.openOnPress ? t.switchOn : t.switchOff, input.openOnPress ? 'on' : 'off', t.openOnPressHint);
      // a held key ends its round when let go: this length only covers always-on listening and the wake word
      roundRow.row.style.display = input.mode === 'hold' && !wk.enabled ? 'none' : '';
      if (document.activeElement !== roundRow.field) roundRow.field.value = String(input.roundSeconds);
      // the loudness threshold only decides where speech starts when the key is not held down
      mark.hidden = input.mode === 'hold';
      if (document.activeElement !== mark) placeMark(next.thresholdDb);
      for (const line of next.recent) {
        if (line.at <= seen) continue;
        seen = line.at;
        const el = log.append(line.text, line.dropped ? 'dim' : 'plain');
        if (line.dropped) el.style.textDecoration = 'line-through';
      }
    };
    const refresh = async () => { try { render(await ctx.invoke<VoiceState>('state')); } catch (err) { msg.textContent = errText(err); } };
    const call = (method: string, args: unknown[] = []) => async () => {
      try { render(await ctx.invoke<VoiceState>(method, args)); msg.textContent = ''; } catch (err) { msg.textContent = errText(err); }
    };
    btnWakeModel.addEventListener('click', call('installWake'));
    modeSel.addEventListener('change', () => void call('setMic', [{ mode: modeSel.value }])());
    deviceSel.addEventListener('change', () => void call('setMic', [{ deviceId: deviceSel.value }])());
    const dbAt = (x: number) => {
      const r = meter.getBoundingClientRect();
      return markDb(FLOOR_DB + ((x - r.left) / r.width) * -FLOOR_DB);
    };
    mark.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      mark.focus();
      mark.setPointerCapture(e.pointerId);
      held = dbAt(e.clientX);
      placeMark(held);
    });
    mark.addEventListener('pointermove', (e) => {
      if (held === null) return;
      held = dbAt(e.clientX);
      placeMark(held);
    });
    mark.addEventListener('pointerup', () => {
      if (held === null) return;
      const db = held;
      held = null;
      void call('setThreshold', [db])();
    });
    mark.addEventListener('pointercancel', () => {
      held = null;
      if (st) placeMark(st.thresholdDb);
    });
    mark.addEventListener('keydown', (e) => {
      const step = ARROW_STEPS[e.key];
      if (!step || held !== null) return;
      e.preventDefault();
      const db = markDb(Number(mark.getAttribute('aria-valuenow')) + step);
      placeMark(db);
      void call('setThreshold', [db])();
    });
    pressSel.addEventListener('change', () => {
      if (st) void call('setMic', [{ hotkey: withTaps(splitTaps(st.input.hotkey).combo, Number(pressSel.value)) }])();
    });

    // try-listen: one short line synthesized whole and played here, without waiting on the pet
    let sample: HTMLAudioElement | null = null;
    btnPreview.addEventListener('click', () => {
      if (btnPreview.disabled || btnPreview.dataset.busy) return;
      btnPreview.dataset.busy = '1';
      btnPreview.textContent = t.previewing;
      readMsg.textContent = '';
      void (async () => {
        try {
          const out = await ctx.invoke<{ audio?: string; error?: string }>('preview', [t.previewSample]);
          if (!out.audio) { readMsg.textContent = out.error ?? ''; return; }
          sample?.pause();
          sample = new Audio(`data:audio/wav;base64,${out.audio}`);
          sample.playbackRate = st?.tts.speed ?? 1;
          sample.volume = Math.min(1, Math.max(0, st?.tts.volume ?? 1));
          await sample.play().catch(() => undefined);
        } catch (err) {
          readMsg.textContent = errText(err);
        } finally {
          delete btnPreview.dataset.busy;
          btnPreview.textContent = t.preview;
          btnPreview.disabled = !!st?.tts.problem;
        }
      })();
    });
    ctx.own({ dispose: () => sample?.pause() });

    // The talk key is a new combination (key-capture.ts); how it is pressed (`*2`) stays as chosen beside it.
    let capture: { stop(): void } | null = null;
    const finishCapture = (combo: string | null) => {
      capture = null;
      keyBtn.textContent = t.changeKey;
      if (combo && st) void call('setMic', [{ hotkey: withTaps(combo, splitTaps(st.input.hotkey).taps) }])();
      else void refresh();
    };
    keyBtn.addEventListener('click', () => {
      if (capture) { capture.stop(); return; }
      keyRow.set('…', 'busy', t.capture);
      keyBtn.textContent = t.cancelKey;
      capture = captureKey(window, finishCapture);
    });
    ctx.own({ dispose: () => capture?.stop() });
    ctx.stream({
      message: (text: string) => {
        const f = JSON.parse(text) as { type: string; level?: number; speaking?: boolean; open?: boolean };
        if (f.type === 'level' && typeof f.level === 'number') {
          fill.style.width = `${meterPct(f.level)}%`;
          fill.classList.toggle('on', !!f.speaking);
          meter.classList.toggle('open', !!f.open);
        } else void refresh();
      },
    });
    void refresh();
    ctx.interval(() => void refresh(), 1500);
  },
};

const bundle: WebUiClientBundle = { panels: { pet: petPanel, voice: voicePanel } };
export default bundle;
