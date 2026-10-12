import { Suspense } from "react";
import { getStaffContext } from "@/lib/server/staff";
import { NoAccess, StaffLoading, StaffShell } from "../_components/staff-shell";
import { DjQueue } from "./dj-queue";

// DJ request queue, used on a tablet in the booth.
export default function DjPage({ searchParams }: PageProps<"/dj">) {
  return (
    <Suspense fallback={<StaffLoading />}>
      <Dj searchParams={searchParams} />
    </Suspense>
  );
}

async function Dj({ searchParams }: Pick<PageProps<"/dj">, "searchParams">) {
  const { venue } = await searchParams;
  const ctx = await getStaffContext("/dj", ["dj"], typeof venue === "string" ? venue : undefined);
  if (!ctx) return <NoAccess role="a DJ" />;

  return (
    <StaffShell ctx={ctx} current="/dj">
      <DjQueue venueId={ctx.venue.id} requestTimeoutMinutes={ctx.venue.requestTimeoutMinutes} />
    </StaffShell>
  );
}
