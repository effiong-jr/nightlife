import Link from "next/link";
import { Suspense } from "react";
import { getReviewQueue, requireAdmin } from "@/lib/server/admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { AdminShell, NotAdmin, StatusPill } from "./_components/admin-shell";
import { ActionForm, Field } from "./_components/forms";
import { createVenueAction } from "./actions";

// Admin home: venues and a new-venue form. Clubs are admin-approved.
export default function AdminPage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">Loading…</p>}>
      <Admin />
    </Suspense>
  );
}

async function Admin() {
  if (!(await requireAdmin("/admin"))) return <NotAdmin />;
  const admin = createAdminClient();
  const [{ data: venues }, queue] = await Promise.all([
    admin.from("venues").select("id, name, slug, status, created_at").order("created_at", { ascending: false }),
    getReviewQueue(admin),
  ]);
  const toReview = queue.failedRefunds.length + queue.flaggedEvents.length + queue.failedPayouts.length;

  return (
    <AdminShell current="venues">
      <div className="flex flex-col gap-8">
        {toReview > 0 && (
          <Link href="/admin/review" className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
            <span className="font-semibold">{toReview} item{toReview === 1 ? "" : "s"} need review</span>
            <span className="text-muted-foreground"> · failed refunds, flagged payments or failed payouts →</span>
          </Link>
        )}

        <section>
          <h1 className="mb-3 text-2xl font-bold">Venues</h1>
          <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border">
            {(venues ?? []).map((v) => (
              <li key={v.id}>
                <Link href={`/admin/venues/${v.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/40">
                  <span>
                    <span className="font-medium">{v.name}</span>
                    <span className="text-sm text-muted-foreground"> · /v/{v.slug}</span>
                  </span>
                  <StatusPill status={v.status} />
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section className="max-w-md">
          <h2 className="mb-3 font-semibold">New venue</h2>
          <ActionForm action={createVenueAction} submit="Create venue">
            <Field label="Name" name="name" required placeholder="e.g. Quilox" />
            <Field label="Web address (slug)" name="slug" required placeholder="e.g. quilox-lagos" />
            <Field label="Address" name="address" placeholder="Victoria Island, Lagos" />
          </ActionForm>
          <p className="mt-2 text-xs text-muted-foreground">
            Starts as pending with default prices and splits. Approve it once a manager and payout account are set up.
          </p>
        </section>
      </div>
    </AdminShell>
  );
}
