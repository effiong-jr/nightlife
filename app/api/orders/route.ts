import { z } from "zod";
import { getPaymentProvider, PaymentProviderError } from "@/lib/payments";
import { appEnv } from "@/lib/server/env";
import { createOrderAndCheckout, orderInputSchema, OrderRejectedError } from "@/lib/server/orders";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Attendee checkout: creates a pending order and returns the hosted checkout URL.
export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const input = orderInputSchema.safeParse(body);
  if (!input.success) {
    return Response.json({ error: "invalid_input", issues: z.flattenError(input.error).fieldErrors }, { status: 400 });
  }

  try {
    const result = await createOrderAndCheckout(input.data, {
      db: await createClient(),
      admin: createAdminClient(),
      provider: getPaymentProvider(),
      appUrl: appEnv().NEXT_PUBLIC_APP_URL,
    });
    return Response.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof OrderRejectedError) {
      const status = err.reason === "venue_not_found" ? 404 : 422;
      return Response.json({ error: err.reason }, { status });
    }
    if (err instanceof PaymentProviderError) {
      console.error("Checkout creation failed", err);
      return Response.json({ error: "payment_provider_unavailable" }, { status: 502 });
    }
    throw err;
  }
}
