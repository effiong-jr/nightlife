import Link from "next/link";
import { signOut } from "@/app/login/actions";
import type { StaffContext } from "@/lib/server/staff";
import { InstallHint } from "./install-hint";

const VIEWS = [
  { href: "/dj", label: "DJ", role: "dj" },
  { href: "/mc", label: "MC", role: "mc" },
  { href: "/club", label: "Club", role: "club_manager" },
] as const;

export function StaffShell({
  ctx,
  current,
  children,
}: {
  ctx: StaffContext;
  current: "/dj" | "/mc" | "/club" | "/payouts";
  children: React.ReactNode;
}) {
  const isManager = ctx.venue.roles.includes("club_manager");
  const views = VIEWS.filter((v) => isManager || ctx.venue.roles.includes(v.role));
  const isPayee = ctx.venue.roles.includes("dj") || ctx.venue.roles.includes("mc");
  const venueQuery = ctx.venues.length > 1 ? `?venue=${ctx.venue.slug}` : "";

  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur">
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{ctx.venue.name}</p>
          <p className="truncate text-xs text-muted-foreground">{ctx.displayName || "Staff"}</p>
        </div>
        {(views.length > 1 || isPayee) && (
          <nav className="flex gap-1">
            {(views.length > 1 ? views : []).map((v) => (
              <Link
                key={v.href}
                href={`${v.href}${venueQuery}`}
                aria-current={v.href === current ? "page" : undefined}
                className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground"
              >
                {v.label}
              </Link>
            ))}
            {isPayee && (
              <Link
                href="/payouts"
                aria-current={current === "/payouts" ? "page" : undefined}
                className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground"
              >
                Get paid
              </Link>
            )}
          </nav>
        )}
        <form action={signOut}>
          <button type="submit" className="rounded-lg px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
            Sign out
          </button>
        </form>
      </header>
      <InstallHint />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-5">{children}</main>
    </div>
  );
}

export function NoAccess({ role }: { role: string }) {
  return (
    <main className="mx-auto flex max-w-sm flex-1 flex-col items-center justify-center px-4 text-center">
      <h1 className="text-xl font-bold">No access</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Your account isn&apos;t set up as {role} at any venue. Ask the club manager for an invite.
      </p>
      <form action={signOut} className="mt-6">
        <button type="submit" className="text-sm underline">
          Sign out
        </button>
      </form>
    </main>
  );
}

export function StaffLoading() {
  return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
}
