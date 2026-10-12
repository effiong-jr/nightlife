import { getPaymentProvider } from "@/lib/payments";
import { handlePaymentWebhook } from "@/lib/server/payment-webhooks";
import { createAdminClient } from "@/lib/supabase/admin";

// Bachs webhook destination. Locally: `bachs listen --forward-to localhost:3000/api/webhooks/bachs`.
export async function POST(request: Request) {
  // The signature covers the exact bytes, so read the raw body before any parsing.
  const rawBody = await request.text();
  const result = await handlePaymentWebhook(rawBody, request.headers, {
    provider: getPaymentProvider(),
    admin: createAdminClient(),
  });
  return Response.json(result.body, { status: result.status });
}
