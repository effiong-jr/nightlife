"use client";

import { useActionState } from "react";
import type { FormState } from "../actions";

// Small form wrapper for admin actions: fields, a submit button, and the
// action's error/success message.
export function ActionForm({
  action,
  submit,
  children,
  className = "flex flex-col gap-3",
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  submit: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, { error: null });
  return (
    <form action={formAction} className={className}>
      {children}
      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
      {state.done && <p className="text-sm text-emerald-400">{state.done}</p>}
      <button
        type="submit"
        disabled={pending}
        className="h-11 rounded-lg bg-foreground px-4 text-sm font-semibold text-background disabled:opacity-60"
      >
        {pending ? "Working…" : submit}
      </button>
    </form>
  );
}

export function Field({ label, name, ...props }: { label: string; name: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input name={name} className="h-11 rounded-lg border border-input bg-transparent px-3 outline-none focus:border-ring" {...props} />
    </label>
  );
}
