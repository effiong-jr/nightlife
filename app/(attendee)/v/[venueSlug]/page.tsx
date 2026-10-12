import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getPublicVenue } from "@/lib/server/venues";
import { OrderForm } from "./order-form";

// Table QR codes point here, e.g. /v/test-lounge?t=7
export default function VenuePage({ params, searchParams }: PageProps<"/v/[venueSlug]">) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-6 pb-10">
      <Suspense fallback={<VenueSkeleton />}>
        <Venue params={params} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Venue({ params, searchParams }: PageProps<"/v/[venueSlug]">) {
  const [{ venueSlug }, query] = await Promise.all([params, searchParams]);
  const venue = await getPublicVenue(venueSlug);
  if (!venue) notFound();

  const tableLabel = toTableLabel(query.t);
  const available = venue.options.filter((o) => o.enabled);

  return (
    <>
      <header className="mb-6">
        <p className="text-sm font-medium tracking-wide text-amber-400 uppercase">
          {tableLabel ?? "Welcome"}
        </p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">{venue.name}</h1>
      </header>

      {!venue.isOpen || available.length === 0 ? (
        <section className="rounded-2xl border border-neutral-800 bg-neutral-900 p-6 text-center">
          <p className="text-lg font-semibold">Not taking requests right now</p>
          <p className="mt-2 text-neutral-400">
            {venue.isOpen ? "Everything is paused for a moment." : "Check back when the night starts."}
          </p>
        </section>
      ) : (
        <OrderForm
          venueSlug={venue.slug}
          tableLabel={tableLabel}
          options={venue.options}
          requestTimeoutMinutes={venue.requestTimeoutMinutes}
        />
      )}
    </>
  );
}

// "7" -> "Table 7"; anything else ("VIP 2") is used as-is. Unsafe values are dropped.
function toTableLabel(t: string | string[] | undefined): string | null {
  if (typeof t !== "string") return null;
  const value = t.trim();
  if (!/^[A-Za-z0-9 -]{1,14}$/.test(value)) return null;
  return /^\d+$/.test(value) ? `Table ${value}` : value;
}

function VenueSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="animate-pulse">
      <div className="h-4 w-20 rounded bg-neutral-800" />
      <div className="mt-3 h-8 w-48 rounded bg-neutral-800" />
      <div className="mt-8 grid grid-cols-2 gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-32 rounded-2xl bg-neutral-900" />
        ))}
      </div>
    </div>
  );
}
