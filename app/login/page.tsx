import { Suspense } from "react";
import { LoginForm } from "./login-form";

// Staff only (club managers, DJs, MCs, admins). Attendees never sign in.
export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-10">
      <h1 className="text-2xl font-bold">Staff sign in</h1>
      <p className="mt-1 text-sm text-neutral-400">For club managers, DJs and hype men.</p>
      <Suspense>
        <Form searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Form({ searchParams }: Pick<PageProps<"/login">, "searchParams">) {
  const { next } = await searchParams;
  return <LoginForm next={typeof next === "string" ? next : undefined} />;
}
