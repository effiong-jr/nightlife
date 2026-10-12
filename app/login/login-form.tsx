"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { signIn, type SignInState } from "./actions";

const initial: SignInState = { error: null };

export function LoginForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState(signIn, initial);

  return (
    <form action={action} className="mt-6 flex flex-col gap-4">
      {next && <input type="hidden" name="next" value={next} />}
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Email
        <input
          name="email"
          type="email"
          autoComplete="email"
          required
          className="h-11 rounded-lg border border-input bg-transparent px-3 text-base outline-none focus:border-ring"
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Password
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="h-11 rounded-lg border border-input bg-transparent px-3 text-base outline-none focus:border-ring"
        />
      </label>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <Button type="submit" size="lg" disabled={pending} className="h-11">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
