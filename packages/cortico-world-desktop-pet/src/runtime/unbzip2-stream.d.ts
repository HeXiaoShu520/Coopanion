/** No types are published for the decoder `src/runtime/store.ts` uses on `.tar.bz2`. */
declare module 'unbzip2-stream' {
  import type { Transform } from 'node:stream';
  export default function unbzip2(opts?: { highWaterMark?: number }): Transform;
}
