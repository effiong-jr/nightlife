import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";
import { formatNaira } from "@/lib/money";
import { getPaymentProvider } from "@/lib/payments";
import { requireAdmin } from "@/lib/server/admin";
import { describeRequirement, getPayoutAccount, syncPayoutAccount } from "@/lib/server/payout-accounts";
import { createAdminClient } from "@/lib/supabase/admin";
import { AdminShell, NotAdmin, StatusPill } from "../../_components/admin-shell";
import { ActionForm, Field } from "../../_components/forms";
import { addManagerAction, setVenueStatusAction, startVenuePayoutsAction } from "../../actions";

export default function VenueAdminPage({ params, searchParams }: PageProps<"/admin/venues/[venueId]">) {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">Loading…</p>}>
      <VenueAdmin params={params} searchParams={searchParams} />
    </Suspense>
  );
}

const TYPE_LABELS: Record<string, string> = {
  spray: "Spray",
  screen_shoutout: "Screen shoutout",
  mc_shoutout: "MC shoutout",
  song_request: "Song request",
};
const pct = (bps: number) => `${bps / 100}%`;

async function VenueAdmin({ params, searchParams }: PageProps<"/admin/venues/[venueId]">) {
  const [{ venueId }, { from }] = await Promise.all([params, searchParams]);
  if (!(await requireAdmin(`/admin/venues/${venueId}`))) return <NotAdmin />;
  if (!z.uuid().safeParse(venueId).success) notFound();

  const admin = createAdminClient();
  const provider = getPaymentProvider();
  const { data: venue } = await admin.from("venues").select("id, name, slug, address, status").eq("id", venueId).maybeSingle();
  if (!venue) notFound();

  let payout = await getPayoutAccount(admin, provider.name, { venueId });
  if (payout && from === "bachs") {
    try {
      await syncPayoutAccount({ admin, provider }, payout.recipientId);
      payout = await getPayoutAccount(admin, provider.name, { venueId });
    } catch {
      // Webhook will catch up.
    }
  }

  const [{ data: staff }, { data: pricing }, { data: splits }, { data: target }] = await Promise.all([
    admin
      .from("venue_staff")
      .select("id, role, source, profile:profiles!venue_staff_profile_id_fkey(display_name, real_name)")
      .eq("venue_id", venueId)
      .eq("status", "active")
      .order("role"),
    admin.from("venue_pricing").select("order_type, enabled, min_amount::text").eq("venue_id", venueId),
    admin.from("venue_splits").select("order_type, club_bps, dj_bps, mc_bps, platform_bps").eq("venue_id", venueId),
    admin.from("venue_target_splits").select("target_bps, club_bps, platform_bps").eq("venue_id", venueId).maybeSingle(),
  ]);
  const managers = (staff ?? []).filter((s) => s.role === "club_manager");

  return (
    <AdminShell current="venues">
      <div className="flex flex-col gap-8">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-3 text-2xl font-bold">
              {venue.name} <StatusPill status={venue.status} />
            </h1>
            <p className="text-sm text-muted-foreground">
              /v/{venue.slug}
              {venue.address && ` · ${venue.address}`}
            </p>
          </div>
          <form action={setVenueStatusAction.bind(null, venue.id, venue.status === "active" ? "suspended" : "active")}>
            <button type="submit" className="h-11 rounded-lg border border-border px-4 text-sm font-semibold">
              {venue.status === "active" ? "Suspend venue" : "Approve venue"}
            </button>
          </form>
        </header>
        {venue.status !== "active" && (managers.length === 0 || payout?.view.status !== "active") && (
          <p className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
            Before approving: {managers.length === 0 && "add a manager"}
            {managers.length === 0 && payout?.view.status !== "active" && " and "}
            {payout?.view.status !== "active" && "set up the club's payout account"}. Until then the club&apos;s
            earnings are held.
          </p>
        )}

        <section className="grid gap-6 md:grid-cols-2">
          <div className="flex flex-col gap-3">
            <h2 className="font-semibold">Managers</h2>
            {managers.length === 0 ? (
              <p className="text-sm text-muted-foreground">None yet.</p>
            ) : (
              <ul className="text-sm">
                {managers.map((m) => (
                  <li key={m.id}>
                    {m.profile.display_name || "Unnamed"}{" "}
                    <span className="text-muted-foreground">({m.profile.real_name || "no real name"})</span>
                  </li>
                ))}
              </ul>
            )}
            <ActionForm action={addManagerAction.bind(null, venue.id)} submit="Add manager">
              <Field label="Phone" name="phone" type="tel" required placeholder="0803 123 4567" />
              <Field label="Real name" name="realName" required />
              <Field label="Name shown to staff" name="stageName" required placeholder="e.g. Tunde (Manager)" />
            </ActionForm>
          </div>

          <div className="flex flex-col gap-3">
            <h2 className="font-semibold">Club payout account</h2>
            {payout ? (
              <div className="text-sm">
                <p className="flex items-center gap-2">
                  Bachs account <StatusPill status={payout.view.status} />
                </p>
                {payout.view.outstanding.length > 0 && (
                  <p className="mt-1 text-muted-foreground">
                    Still needed: {payout.view.outstanding.map(describeRequirement).join(", ")}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Not set up. You&apos;ll complete Bachs&apos;s business verification with the club owner (company details,
                director ID, the club&apos;s bank account).
              </p>
            )}
            {payout?.view.status !== "active" && (
              <ActionForm action={startVenuePayoutsAction.bind(null, venue.id)} submit={payout ? "Continue on Bachs" : "Set up on Bachs"}>
                {payout ? (
                  <input type="hidden" name="hasAccount" value="1" />
                ) : (
                  <Field label="Club email (for Bachs)" name="email" type="email" required />
                )}
              </ActionForm>
            )}
          </div>
        </section>

        <section>
          <h2 className="mb-3 font-semibold">Prices and splits</h2>
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  {["Type", "Minimum", "On", "Club", "DJ", "MC", "Platform"].map((h) => (
                    <th key={h} className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(splits ?? []).map((s) => {
                  const p = (pricing ?? []).find((x) => x.order_type === s.order_type);
                  return (
                    <tr key={s.order_type}>
                      <td className="px-3 py-2">{TYPE_LABELS[s.order_type]}</td>
                      <td className="px-3 py-2">{p ? formatNaira(p.min_amount) : "-"}</td>
                      <td className="px-3 py-2">{p?.enabled ? "Yes" : "Paused"}</td>
                      <td className="px-3 py-2">{pct(s.club_bps)}</td>
                      <td className="px-3 py-2">{pct(s.dj_bps)}</td>
                      <td className="px-3 py-2">{pct(s.mc_bps)}</td>
                      <td className="px-3 py-2">{pct(s.platform_bps)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {target && (
            <p className="mt-2 text-sm text-muted-foreground">
              Targeted sprays: target {pct(target.target_bps)} · club {pct(target.club_bps)} · platform {pct(target.platform_bps)}.
              Editing prices and splits comes later; they&apos;re placeholders until terms are agreed.
            </p>
          )}
        </section>
      </div>
    </AdminShell>
  );
}
