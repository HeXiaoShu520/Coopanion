/**
 * The voice panel's rows for Doubao, the service both recognition and synthesis use: its address
 * (empty for the official one) and its API Key, each saved through the panel's `setDoubao` when the
 * field changes (Enter, or leaving it changed). The key is never sent back; its row shows whether
 * one is saved.
 */
import type { WebUiInputOptions, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { PetText } from '../i18n/index.ts';
import './api-rows.css';

export interface UrlKeyState { baseUrl: string; keySaved: boolean }
export interface UrlKeyPatch { baseUrl?: string; key?: string }
interface Row { row: HTMLElement; acts: HTMLElement; set(text: string, tone: 'on' | 'off' | 'busy' | 'bad', more?: string): void }

const field = (ctx: WebUiPanelContext, row: Row, opts: Pick<WebUiInputOptions, 'type' | 'placeholder'>, change: (value: string) => void) => {
  const input = ctx.ui.input({ ...opts, cls: 'pet-apifield', onChange: change });
  row.acts.append(input);
  return input;
};

/**
 * The address and key rows, and their state. `keyNeeded` marks a missing key as the fault it is
 * while voice input is on, rather than as a field not filled in yet.
 */
export function doubaoRows(ctx: WebUiPanelContext, t: PetText['panel'], statusRow: (name: string) => Row, save: (patch: UrlKeyPatch) => void) {
  const url = statusRow(t.apiUrl);
  const urlInput = field(ctx, url, { placeholder: 'wss://…' }, (baseUrl) => save({ baseUrl }));
  const key = statusRow(t.apiKey);
  const keyInput = field(ctx, key, { type: 'password' }, (value) => {
    if (!value.trim()) return;
    keyInput.value = '';
    save({ key: value });
  });
  keyInput.autocomplete = 'off';
  return {
    rows: [url.row, key.row],
    render(state: UrlKeyState, keyNeeded = false) {
      if (document.activeElement !== urlInput) urlInput.value = state.baseUrl;
      url.set('', state.baseUrl ? 'on' : 'off');
      key.set(state.keySaved ? t.keySaved : t.keyMissing, state.keySaved ? 'on' : keyNeeded ? 'bad' : 'off', t.sharedKey);
    },
  };
}
