import "server-only";

// Payment provider boundary. All Bachs calls (and the only `@bachs/sdk` import)
// live in this folder behind a small provider interface, so we can swap to
// Paystack/Flutterwave later. Implemented in step 3.
export {};
