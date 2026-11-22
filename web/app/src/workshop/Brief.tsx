import { useCallback, useEffect, useRef, useState } from 'react';
import type { Work } from '@gestalts/workshop';

const SAVE_AFTER_MS = 600;

/**
 * Saving a text as you type, with a debounce, and on leaving. `flush` saves what's pending now (before a turn reads the
 * draft). `save` writes the draft as it is then, so a turn's changes meanwhile stay.
 */
export function useDebounced(save: (text: string) => Promise<void>) {
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saveRef = useRef(save);
  useEffect(() => { saveRef.current = save; });
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const t = pending.current;
    pending.current = null;
    if (t !== null) await saveRef.current(t);
  }, []);
  useEffect(() => () => { void flush(); }, [flush]);
  const edit = useCallback((text: string) => {
    pending.current = text;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_AFTER_MS);
  }, [flush]);
  return { edit, flush };
}

/**
 * A draft's brief (`spec`): what it should be, in the teacher's words, kept with the draft and sent with every turn
 * as SPEC.md. The same for every kind.
 */
export function Brief({ work, spec, flush, edit, placeholder }: {
  work: Pick<Work, 'id'>; spec: string; flush: () => Promise<void>; edit: (t: string) => void; placeholder?: string;
}) {
  const [text, setText] = useState(spec);
  // another device, or the plan, may set it: shown when nothing is typed here
  const typing = useRef(false);
  useEffect(() => { if (!typing.current) setText(spec); }, [spec]);
  return (
    <details className="border-b border-base-300 px-3 py-2 text-sm" open={!spec.trim()}>
      <summary className="cursor-pointer text-base-content/60">Brief{spec.trim() ? `: ${spec.trim().split('\n')[0].slice(0, 60)}` : ''}</summary>
      <textarea key={work.id} className="textarea textarea-sm mt-1 w-full" rows={5} value={text} placeholder={placeholder}
                onFocus={() => { typing.current = true; }}
                onBlur={() => { typing.current = false; void flush(); }}
                onChange={(e) => { setText(e.target.value); edit(e.target.value); }} />
    </details>
  );
}
