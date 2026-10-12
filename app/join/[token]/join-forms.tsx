"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { acceptInvite, type AcceptState, type ProfileState, saveProfile } from "./actions";

const inputClass = "h-12 rounded-lg border border-input bg-transparent px-3 text-lg outline-none focus:border-ring";

export function ProfileForm({ token, realName, stageName }: { token: string; realName: string; stageName: string }) {
  const [state, action, pending] = useActionState<ProfileState, FormData>(saveProfile, { error: null });
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Stage name
        <input name="stageName" defaultValue={stageName} maxLength={40} required placeholder="e.g. DJ Spinall" className={inputClass} />
        <span className="text-xs font-normal text-muted-foreground">Shown on the club screen and when people spray you.</span>
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Real name
        <input name="realName" defaultValue={realName} maxLength={100} required autoComplete="name" className={inputClass} />
        <span className="text-xs font-normal text-muted-foreground">
          Private: for payouts and the club only. Never shown to the crowd.
        </span>
      </label>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <Button type="submit" size="lg" disabled={pending} className="h-12 text-base">
        {pending ? "Saving…" : "Continue"}
      </Button>
    </form>
  );
}

export function AcceptForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<AcceptState, FormData>(acceptInvite, { error: null });
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="token" value={token} />
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <Button type="submit" size="lg" disabled={pending} className="h-12 text-base">
        {pending ? "Joining…" : "Accept invite"}
      </Button>
    </form>
  );
}
