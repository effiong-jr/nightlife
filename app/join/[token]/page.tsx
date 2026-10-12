import Link from "next/link";
import { Suspense } from "react";
import { signOut } from "@/app/login/actions";
import { PhoneOtpForm } from "@/app/login/phone-otp-form";
import { formatNigerianPhone } from "@/lib/phone";
import { createClient } from "@/lib/supabase/server";
import { AcceptForm, ProfileForm } from "./join-forms";

// Invite link for a DJ/MC: /join/<token>. Steps: sign in with phone (new
// people get an account), add real + stage name, accept.
export default function JoinPage({ params }: PageProps<"/join/[token]">) {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-10">
      <Suspense fallback={<p className="text-muted-foreground">Loading your invite…</p>}>
        <Join params={params} />
      </Suspense>
    </main>
  );
}

type Preview = {
  venueName: string;
  venueSlug: string;
  role: "dj" | "mc" | "club_manager";
  inviteeName: string | null;
  state: "valid" | "accepted" | "expired" | "cancelled" | "venue_unavailable";
};

const ROLE_NAMES = { dj: "DJ", mc: "hype man (MC)", club_manager: "manager" } as const;

const STATE_MESSAGES: Record<Exclude<Preview["state"], "valid">, string> = {
  accepted: "This invite has already been used.",
  expired: "This invite has expired. Ask the club to send you a new link.",
  cancelled: "The club cancelled this invite. Ask them for a new link if you need one.",
  venue_unavailable: "This venue isn't taking staff right now.",
};

async function Join({ params }: Pick<PageProps<"/join/[token]">, "params">) {
  const { token } = await params;
  const supabase = await createClient();

  const [{ data: preview }, { data: claims }] = await Promise.all([
    supabase.rpc("invite_preview", { p_token: token }),
    supabase.auth.getClaims(),
  ]);
  const invite = preview as Preview | null;

  if (!invite) {
    return <Message title="Invite not found" body="Check the link, or ask the club to send it again." />;
  }
  if (invite.state !== "valid") {
    return <Message title={`${invite.venueName} invite`} body={STATE_MESSAGES[invite.state]} />;
  }

  const heading = (
    <header className="mb-6">
      <p className="text-sm font-medium tracking-wide text-amber-400 uppercase">You&apos;re invited</p>
      <h1 className="mt-1 text-2xl font-bold">
        Join {invite.venueName} as {ROLE_NAMES[invite.role]}
      </h1>
      {invite.inviteeName && <p className="mt-1 text-muted-foreground">For {invite.inviteeName}</p>}
    </header>
  );

  const userId = claims?.claims.sub;
  if (!userId) {
    return (
      <>
        {heading}
        <p className="mb-4 text-sm text-muted-foreground">
          Sign in with your phone number. New here? We&apos;ll create your account.
        </p>
        <PhoneOtpForm next={`/join/${token}`} allowSignUp />
      </>
    );
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, real_name")
    .eq("id", userId)
    .maybeSingle();
  const phone = typeof claims?.claims.phone === "string" && claims.claims.phone ? `+${claims.claims.phone}` : null;
  const signedInAs = (
    <form action={signOut} className="mt-6 text-xs text-muted-foreground">
      Signed in{phone ? ` as ${formatNigerianPhone(phone)}` : ""}.{" "}
      <button type="submit" className="underline">
        Not you?
      </button>
    </form>
  );

  if (!profile?.display_name || !profile.real_name) {
    return (
      <>
        {heading}
        <ProfileForm token={token} realName={profile?.real_name ?? ""} stageName={profile?.display_name ?? ""} />
        {signedInAs}
      </>
    );
  }

  return (
    <>
      {heading}
      <dl className="mb-6 divide-y divide-border rounded-2xl border border-border text-sm">
        <div className="flex justify-between px-4 py-3">
          <dt className="text-muted-foreground">Stage name</dt>
          <dd className="font-medium">{profile.display_name}</dd>
        </div>
        <div className="flex justify-between px-4 py-3">
          <dt className="text-muted-foreground">Real name</dt>
          <dd className="font-medium">{profile.real_name}</dd>
        </div>
        <div className="flex justify-between gap-4 px-4 py-3">
          <dt className="text-muted-foreground">Payouts</dt>
          <dd className="text-right text-muted-foreground">Set up after joining, under “Get paid”</dd>
        </div>
      </dl>
      <AcceptForm token={token} />
      {signedInAs}
    </>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="text-center">
      <h1 className="text-2xl font-bold">{title}</h1>
      <p className="mt-2 text-muted-foreground">{body}</p>
      <Link href="/login" className="mt-6 inline-block text-sm underline">
        Staff sign in
      </Link>
    </div>
  );
}
