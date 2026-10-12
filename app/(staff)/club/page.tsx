import { Suspense } from "react";
import { getStaffContext } from "@/lib/server/staff";
import { NoAccess, StaffLoading, StaffShell } from "../_components/staff-shell";
import { ClubLive } from "./club-live";
import { StaffPanel } from "./staff-panel";

// Manager dashboard: tonight (lineup, approvals, takings) and staff (invites,
// removal). Prices, splits and earnings come later.
export default function ClubPage({ searchParams }: PageProps<"/club">) {
  return (
    <Suspense fallback={<StaffLoading />}>
      <Club searchParams={searchParams} />
    </Suspense>
  );
}

async function Club({ searchParams }: Pick<PageProps<"/club">, "searchParams">) {
  const { venue } = await searchParams;
  const ctx = await getStaffContext("/club", ["club_manager"], typeof venue === "string" ? venue : undefined);
  if (!ctx) return <NoAccess role="a club manager" />;

  return (
    <StaffShell ctx={ctx} current="/club">
      <div className="flex flex-col gap-10">
        <ClubLive venueId={ctx.venue.id} venueSlug={ctx.venue.slug} />
        <StaffPanel venueId={ctx.venue.id} venueName={ctx.venue.name} myUserId={ctx.userId} />
      </div>
    </StaffShell>
  );
}
