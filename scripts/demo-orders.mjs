// Local dev only: fills Test Lounge's open night with paid orders so the DJ,
// MC, club and screen views have something to show.
//
//   npm run db:demo
//
// Each order is paid through record_paid_order, the same path as a real
// Bachs webhook, so ledger entries and realtime broadcasts happen as usual.
// Safe to run repeatedly (adds a fresh batch each time).
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
if (!url || !secretKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY (.env.local)");
  process.exit(1);
}
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error(`Refusing to add demo orders to a non-local database: ${url}`);
  process.exit(1);
}

const admin = createClient(url, secretKey, { auth: { persistSession: false } });
const VENUE_SLUG = process.argv[2] ?? "test-lounge";

const ORDERS = [
  { type: "song_request", nickname: "Big Tunde", table_label: "Table 7", song_title: "Ojuelegba", song_artist: "Wizkid", amount: "5000.00" },
  { type: "song_request", nickname: "Amaka", table_label: "Table 3", song_title: "Essence", song_artist: "Wizkid ft. Tems", amount: "10000.00" },
  { type: "song_request", nickname: "Kunle", table_label: "Table 12", song_title: "Calm Down", song_artist: "Rema", amount: "7500.00" },
  { type: "mc_shoutout", nickname: "Chioma", table_label: "Table 4", message: "Happy 30th birthday Ada! Table 4 loves you", amount: "3000.00" },
  { type: "mc_shoutout", nickname: "Seyi", table_label: "VIP 2", message: "Big ups to the Unilag class of 2016, we still dey!", amount: "5000.00" },
  { type: "screen_shoutout", nickname: "Funmi", table_label: "Table 9", message: "Congrats on the new job Dayo! 🎉", amount: "2000.00" },
  { type: "screen_shoutout", nickname: "Emeka", table_label: "Table 1", message: "Lagos to the world! Happy birthday Nneka", amount: "4000.00" },
  { type: "spray", nickname: "Big Tunde", table_label: "Table 7", spray_target: "dj", amount: "20000.00" },
  { type: "spray", nickname: "Amaka", table_label: "Table 3", spray_target: "celebrant", message: "Ada", amount: "50000.00" },
  { type: "spray", nickname: "Quiet Money", table_label: "VIP 1", spray_target: "mc", amount: "100000.00", show_on_leaderboard: false },
];

const { data: venue, error: venueError } = await admin.from("venues").select("id").eq("slug", VENUE_SLUG).maybeSingle();
if (venueError || !venue) {
  console.error(`Venue "${VENUE_SLUG}" not found. Run npm run db:reset first.`);
  process.exit(1);
}
const { data: night } = await admin
  .from("venue_nights")
  .select("id")
  .eq("venue_id", venue.id)
  .not("opened_at", "is", null)
  .is("closed_at", null)
  .maybeSingle();
if (!night) {
  console.error(`${VENUE_SLUG} has no open night. Run npm run db:reset to reseed.`);
  process.exit(1);
}

for (const order of ORDERS) {
  const id = randomUUID();
  const { error: insertError } = await admin
    .from("orders")
    .insert({ id, venue_id: venue.id, venue_night_id: night.id, ...order });
  if (insertError) throw insertError;

  const { data: result, error: payError } = await admin.rpc("record_paid_order", {
    p_provider: "bachs",
    p_event_id: `evt_demo_${id}`,
    p_event_type: "collection.succeeded",
    p_payload: { demo: true },
    p_order_id: id,
    p_checkout_id: null,
    p_collection_id: `ch_demo_${id}`,
    p_amount: order.amount,
    p_currency: "NGN",
  });
  if (payError) throw payError;
  console.log(`${result.padEnd(9)} ${order.type.padEnd(16)} ₦${order.amount.padStart(10)}  ${order.nickname}`);
  // Spread sprays out so the club screen shows each one.
  if (order.type === "spray") await new Promise((r) => setTimeout(r, 1500));
}

console.log(`\nDone. Open /dj, /mc, /club (signed in) and /s/${VENUE_SLUG}.`);
