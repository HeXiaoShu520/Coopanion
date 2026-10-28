/**
 * The voice panel's rows for a service reached by an address and an API Key: the transcription
 * service (engine `api`, address, model and key) and Doubao (engine `doubao`, address and key),
 * each saved through its panel method on the field's change event (Enter, or leaving it changed).
 * The key is never sent back; its row shows whether one is saved.
 */
import type { WebUiInputOptions, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { PetText } from '../i18n/index.ts';
import './api-rows.css';

export interface UrlKeyState { baseUrl: string; keySaved: boolean }
export interface UrlKeyPatch { baseUrl?: string; key?: string }
export interface ApiState extends UrlKeyState { model: string }
export interface ApiPatch extends UrlKeyPatch { model?: string }
interface Row { row: HTMLElement; acts: HTMLElement; set(text: string, tone: 'on' | 'off' | 'busy' | 'bad', more?: string): void }

const field = (ctx: WebUiPanelContext, row: Row, opts: Pick<WebUiInputOptions, 'type' | 'placeholder'>, change: (value: string) => void) => {
  const input = ctx.ui.input({ ...opts, cls: 'pet-apifield', onChange: change });
  row.acts.append(input);
  return input;
};

/** The address and key rows, and what shows them or hides them; a service with a model adds that row between them. */
function urlKeyRows(ctx: WebUiPanelContext, t: PetText['panel'], statusRow: (name: string) => Row, save: (patch: UrlKeyPatch) => void, placeholder: string) {
  const url = statusRow(t.apiUrl);
  const urlInput = field(ctx, url, { placeholder }, (baseUrl) => save({ baseUrl }));
  const key = statusRow(t.apiKey);
  const keyInput = field(ctx, key, { type: 'password' }, (value) => {
    if (!value.trim()) return;
    keyInput.value = '';
    save({ key: value });
  });
  keyInput.autocomplete = 'off';
  return {
    urlRow: url.row,
    keyRow: key.row,
    render(state: UrlKeyState, shown: boolean) {
      url.row.style.display = shown ? '' : 'none';
      key.row.style.display = shown ? '' : 'none';
      if (document.activeElement !== urlInput) urlInput.value = state.baseUrl;
      url.set('', state.baseUrl ? 'on' : 'off');
      key.set(state.keySaved ? t.keySaved : t.keyMissing, state.keySaved ? 'on' : 'off');
    },
  };
}

/** The transcription service's rows: address, model and API Key. */
export function apiRows(ctx: WebUiPanelContext, t: PetText['panel'], statusRow: (name: string) => Row, save: (patch: ApiPatch) => void) {
  const shared = urlKeyRows(ctx, t, statusRow, save, 'https://…/v1');
  const model = statusRow(t.apiModel);
  const modelInput = field(ctx, model, {}, (value) => save({ model: value }));
  return {
    rows: [shared.urlRow, model.row, shared.keyRow],
    render(state: ApiState, shown: boolean) {
      shared.render(state, shown);
      model.row.style.display = shown ? '' : 'none';
      if (document.activeElement !== modelInput) modelInput.value = state.model;
      model.set('', state.model ? 'on' : 'off');
    },
  };
}

/** Doubao's rows, recognition and synthesis sharing them: the address (empty for the official one) and the key. */
export function doubaoRows(ctx: WebUiPanelContext, t: PetText['panel'], statusRow: (name: string) => Row, save: (patch: UrlKeyPatch) => void) {
  const shared = urlKeyRows(ctx, t, statusRow, save, 'wss://…');
  return { rows: [shared.urlRow, shared.keyRow], render: shared.render };
}
