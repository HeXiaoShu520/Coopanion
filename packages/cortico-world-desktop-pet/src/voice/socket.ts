/**
 * The WebSocket both Doubao services answer on, as the engines see it: a session sends binary
 * frames and hears back `open`, `message`, `error` and `close`. Keeping it behind this one object
 * is what lets the tests drive a session with a socket of their own, and no network at all.
 */
import { WebSocket, type RawData } from 'ws';

export interface SocketHandlers {
  open(): void;
  message(data: Uint8Array): void;
  error(why: string): void;
  close(): void;
}

export interface SpeechSocket {
  send(data: Uint8Array): void;
  close(): void;
}

/** How a session reaches the service; tests pass a socket of their own. */
export type SocketOpen = (url: string, headers: Record<string, string>, handlers: SocketHandlers) => SpeechSocket;

/** The socket `ws` opens, with the frames of the session as a listener hands them over. */
export const openSocket: SocketOpen = (url, headers, handlers) => {
  const socket = new WebSocket(url, { headers, handshakeTimeout: 15_000 });
  socket.on('open', () => handlers.open());
  socket.on('message', (data: RawData) => {
    const view = Array.isArray(data) ? Buffer.concat(data) : data as Buffer;
    handlers.message(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  });
  socket.on('error', (err: Error) => handlers.error(err.message));
  socket.on('close', () => handlers.close());
  return { send: (data) => socket.send(data), close: () => socket.close() };
};
