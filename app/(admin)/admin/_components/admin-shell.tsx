import Link from "next/link";
import { signOut } from "@/app/login/actions";

export function AdminShell({ current, children }: { current: "venues" | "review"; children: React.ReactNode }) {
  const link = (href: string, label: string, active: boolean) => (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground"
    >
      {label}
    </Link>
  );
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <p className="flex-1 font-semibold">Nightlife admin</p>
        <nav className="flex gap-1">
          {link("/admin", "Venues", current === "venues")}
          {link("/admin/review", "Review", current === "review")}
        </nav>
        <form action={signOut}>
          <button type="submit" className="px-3 py-2 text-sm text-muted-foreground">
            Sign out
          </button>
        </form>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}

export function NotAdmin() {
  return (
    <main className="mx-auto flex max-w-sm flex-1 flex-col items-center justify-center px-4 text-center">
      <h1 className="text-xl font-bold">Admins only</h1>
      <p className="mt-2 text-sm text-muted-foreground">This area is for the Nightlife team.</p>
    </main>
  );
}

export function StatusPill({ status }: { status: string }) {
  const tones: Record<string, string> = {
    active: "bg-emerald-500/15 text-emerald-300",
    pending: "bg-amber-500/15 text-amber-300",
    suspended: "bg-red-500/15 text-red-300",
    restricted: "bg-red-500/15 text-red-300",
  };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tones[status] ?? "bg-muted"}`}>{status}</span>;
}
