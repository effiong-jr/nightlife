import { Suspense } from "react";
import { LoginForm } from "./login-form";
import { PhoneOtpForm } from "./phone-otp-form";

// Staff only (club managers, DJs, MCs, admins). Attendees never sign in.
export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-10">
      <h1 className="text-2xl font-bold">Staff sign in</h1>
      <p className="mt-1 text-sm text-muted-foreground">For club managers, DJs and hype men.</p>
      <Suspense>
        <Forms searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Forms({ searchParams }: Pick<PageProps<"/login">, "searchParams">) {
  const { next } = await searchParams;
  const nextPath = typeof next === "string" ? next : undefined;
  return (
    <>
      <div className="mt-6">
        <PhoneOtpForm next={nextPath} />
      </div>
      <details className="mt-8 text-sm text-muted-foreground">
        <summary className="cursor-pointer">Use email and password instead (test accounts)</summary>
        <LoginForm next={nextPath} />
      </details>
      <p className="mt-8 text-xs text-muted-foreground">
        New DJ or hype man? Open the invite link your club sent you.
      </p>
    </>
  );
}
