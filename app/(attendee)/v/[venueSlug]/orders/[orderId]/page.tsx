import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { formatNaira } from "@/lib/money";
import { getOrderReceipt, type OrderReceipt } from "@/lib/server/order-receipt";
import { RefreshWhilePending } from "./refresh-while-pending";

// Bachs returns the attendee here after checkout. Payment is only confirmed by
// the webhook, so a fresh order may still be pending: the page polls until then.
export default function OrderPage({ params }: PageProps<"/v/[venueSlug]/orders/[orderId]">) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col px-4 pt-10 pb-10">
      <Suspense fallback={<p className="text-neutral-400">Loading your order…</p>}>
        <Receipt params={params} />
      </Suspense>
    </main>
  );
}

const TYPE_NAMES: Record<OrderReceipt["type"], string> = {
  spray: "Spray",
  screen_shoutout: "Screen shoutout",
  mc_shoutout: "MC shoutout",
  song_request: "Song request",
};

async function Receipt({ params }: Pick<PageProps<"/v/[venueSlug]/orders/[orderId]">, "params">) {
  const { venueSlug, orderId } = await params;
  const order = await getOrderReceipt(orderId, venueSlug);
  if (!order) notFound();

  const { title, detail, tone } = statusCopy(order);
  const pending = order.status === "pending_payment";

  return (
    <>
      <div className="text-center">
        <p className="text-5xl" aria-hidden>
          {tone === "good" ? "✅" : tone === "wait" ? "⏳" : "ℹ️"}
        </p>
        <h1 className="mt-4 text-2xl font-bold">{title}</h1>
        <p className="mt-2 text-neutral-400">{detail}</p>
        {pending && <RefreshWhilePending />}
      </div>

      <dl className="mt-8 divide-y divide-neutral-800 rounded-2xl border border-neutral-800 bg-neutral-900 text-sm">
        <Row label="Venue" value={order.venueName} />
        <Row label="What" value={TYPE_NAMES[order.type]} />
        <Row label="Amount" value={formatNaira(order.amount)} />
        <Row label="Nickname" value={order.nickname} />
        <Row label="Reference" value={order.reference} />
      </dl>

      <Link
        href={`/v/${venueSlug}`}
        className="mt-8 flex h-14 items-center justify-center rounded-2xl border border-neutral-800 font-semibold"
      >
        Send another
      </Link>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 px-4 py-3">
      <dt className="text-neutral-400">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}

// Receipts use plain, clear language.
function statusCopy(order: OrderReceipt): { title: string; detail: string; tone: "good" | "wait" | "info" } {
  switch (order.status) {
    case "pending_payment":
      return {
        title: "Confirming your payment…",
        detail: "This usually takes a few seconds. Keep this page open.",
        tone: "wait",
      };
    case "paid":
      return { title: "Payment received", detail: paidDetail(order), tone: "good" };
    case "approved":
      return {
        title: "Approved",
        detail:
          order.type === "song_request"
            ? "The DJ accepted your request."
            : order.type === "mc_shoutout"
              ? "The hype man will read it out soon."
              : "Watch the screen!",
        tone: "good",
      };
    case "fulfilled":
      return {
        title: "Done",
        detail: order.type === "song_request" ? "Your song has been played." : "Thanks for the vibes!",
        tone: "good",
      };
    case "rejected":
      return {
        title: "Not accepted",
        detail: `This one wasn't accepted, so you'll get ${formatNaira(order.amount)} back to your original payment method.`,
        tone: "info",
      };
    case "refunded":
      return {
        title: "Refunded",
        detail: `${formatNaira(order.amount)} has been refunded to your original payment method.`,
        tone: "info",
      };
    case "expired":
      return {
        title: "Payment not completed",
        detail: "This checkout expired before payment, so you haven't been charged.",
        tone: "info",
      };
  }
}

function paidDetail(order: OrderReceipt): string {
  switch (order.type) {
    case "spray":
      return "Your spray will show on the screen shortly.";
    case "screen_shoutout":
      return "Your shoutout goes on screen once staff approve it.";
    case "mc_shoutout":
      return "The hype man will read your shoutout once it's approved.";
    case "song_request":
      return `Your request is with the DJ. If it isn't played within ${order.requestTimeoutMinutes} minutes, you'll be refunded automatically.`;
  }
}
