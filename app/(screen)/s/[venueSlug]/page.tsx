import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getPublicVenue } from "@/lib/server/venues";
import { ClubScreen } from "./club-screen";

// Big screen on a TV/laptop in the club. Public: it only ever shows what's
// already on the screen (paid sprays, approved shoutouts, nickname leaderboard).
export default function ScreenPage({ params }: PageProps<"/s/[venueSlug]">) {
  return (
    <Suspense fallback={<div className="h-dvh bg-black" />}>
      <Screen params={params} />
    </Suspense>
  );
}

async function Screen({ params }: Pick<PageProps<"/s/[venueSlug]">, "params">) {
  const { venueSlug } = await params;
  const venue = await getPublicVenue(venueSlug);
  if (!venue) notFound();
  return <ClubScreen venueId={venue.id} venueName={venue.name} />;
}
