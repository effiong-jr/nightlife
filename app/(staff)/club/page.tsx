import { Suspense } from "react";
import { getStaffContext } from "@/lib/server/staff";
import { NoAccess, StaffLoading, StaffShell } from "../_components/staff-shell";
import { ClubLive } from "./club-live";

// Manager dashboard. Step 5 covers tonight's live view and screen approvals;
// prices, splits, earnings and invites come with the admin work (step 7).
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
      <ClubLive venueId={ctx.venue.id} venueSlug={ctx.venue.slug} />
    </StaffShell>
  );
}
