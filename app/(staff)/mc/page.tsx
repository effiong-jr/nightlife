import { Suspense } from "react";
import { getStaffContext } from "@/lib/server/staff";
import { NoAccess, StaffLoading, StaffShell } from "../_components/staff-shell";
import { McView } from "./mc-view";

// Hype man's phone view: shoutouts to read on the mic and big-spray alerts.
export default function McPage({ searchParams }: PageProps<"/mc">) {
  return (
    <Suspense fallback={<StaffLoading />}>
      <Mc searchParams={searchParams} />
    </Suspense>
  );
}

async function Mc({ searchParams }: Pick<PageProps<"/mc">, "searchParams">) {
  const { venue } = await searchParams;
  const ctx = await getStaffContext("/mc", ["mc"], typeof venue === "string" ? venue : undefined);
  if (!ctx) return <NoAccess role="a hype man" />;

  return (
    <StaffShell ctx={ctx} current="/mc">
      <McView venueId={ctx.venue.id} isMc={ctx.venue.roles.includes("mc")} />
    </StaffShell>
  );
}
