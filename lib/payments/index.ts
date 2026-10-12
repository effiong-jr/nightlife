import "server-only";
import { bachsEnv } from "@/lib/server/env";
import { createBachsProvider } from "./bachs";
import type { PaymentProvider } from "./types";

// Payment provider boundary. All Bachs calls live in this folder behind
// PaymentProvider, so we can swap to Paystack/Flutterwave later.

export type {
  Checkout,
  CreateCheckoutInput,
  CreatePayeeAccountInput,
  CreateRefundInput,
  OnboardingLink,
  PayeeAccount,
  PaymentEvent,
  PaymentProvider,
  PayoutToBankInput,
  ProviderPayout,
  TransferToPayeeInput,
  Refund,
  RefundStatus,
} from "./types";
export { PaymentProviderError, WebhookNotConfiguredError, WebhookSignatureError } from "./types";

export function getPaymentProvider(): PaymentProvider {
  const env = bachsEnv();
  return createBachsProvider({
    secretKey: env.BACHS_SECRET_KEY,
    webhookSecret: env.BACHS_WEBHOOK_SECRET,
  });
}
