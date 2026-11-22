import { useState } from 'react';
import type { Answers, Question } from './agents/types';

/**
 * The agent's questions as a card: per question its options (several for `multiSelect`), and always a field for an
 * answer of one's own. Nothing is picked beforehand: a recommendation is marked, never chosen for the person.
 */
export function AskCard({ questions, answered, disabled, onAnswer }: {
  questions: Question[]; answered?: string; disabled?: boolean; onAnswer: (answers: Answers) => void;
}) {
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [own, setOwn] = useState<Record<number, string>>({});
  const answerOf = (i: number) => [...(picked[i] ?? []), own[i]?.trim() ?? ''].filter(Boolean).join('; ');
  const complete = questions.every((_, i) => answerOf(i));
  const toggle = (i: number, label: string, multi?: boolean) => setPicked((p) => {
    const now = p[i] ?? [];
    return { ...p, [i]: multi ? (now.includes(label) ? now.filter((l) => l !== label) : [...now, label]) : [label] };
  });
  const submit = () => onAnswer(Object.fromEntries(questions.map((q, i) => [q.question, answerOf(i)])));

  if (answered) {
    return (
      <div className="rounded-box border border-base-300 p-2 text-xs text-base-content/60">
        {questions.map((q) => <p key={q.question}>{q.question}</p>)}
        <p className="mt-1 whitespace-pre-wrap italic">{answered}</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-box border border-primary/40 bg-base-200 p-3">
      {questions.map((q, i) => (
        <fieldset key={q.question} className="flex flex-col gap-1">
          <legend className="mb-1"><span className="badge badge-sm badge-outline mr-2">{q.header}</span><span className="font-medium">{q.question}</span></legend>
          {q.options.map((o) => (
            <label key={o.label} className="flex cursor-pointer items-start gap-2 rounded p-1 hover:bg-base-300">
              <input type={q.multiSelect ? 'checkbox' : 'radio'} name={`ask-${i}`} className={`${q.multiSelect ? 'checkbox checkbox-sm' : 'radio radio-sm'} mt-0.5`}
                     checked={(picked[i] ?? []).includes(o.label)} onChange={() => toggle(i, o.label, q.multiSelect)} />
              <span className="min-w-0">
                <span className="font-medium">{o.label}</span>
                {o.recommended && <span className="badge badge-xs badge-primary ml-2">recommended</span>}
                <span className="block text-xs text-base-content/70">{o.description}</span>
                {o.preview && <pre className="mt-1 overflow-x-auto rounded bg-base-100 p-2 text-xs">{o.preview}</pre>}
              </span>
            </label>
          ))}
          <input className="input input-sm w-full" placeholder={q.options.length ? 'Or in your own words' : 'Your answer'} value={own[i] ?? ''}
                 onChange={(e) => setOwn((o) => ({ ...o, [i]: e.target.value }))} />
        </fieldset>
      ))}
      <button type="button" className="btn btn-sm btn-primary self-end" disabled={disabled || !complete} onClick={submit}>Answer</button>
    </div>
  );
}
