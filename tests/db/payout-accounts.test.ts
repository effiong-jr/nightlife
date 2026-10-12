// Payout accounts: status rules, privacy, onboarding and webhook sync.
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { PayeeAccount, PaymentProvider } from "@/lib/payments";
import { handlePaymentWebhook } from "@/lib/server/payment-webhooks";
import { startProfileOnboarding } from "@/lib/server/payout-accounts";
import type { Database } from "@/lib/supabase/database.types";
import { as, type Db, withTx } from "./db";
import { createStaffedVenue, createUser } from "./fixtures";

async function addAccount(db: Db, profileId: string) {
  const recipient = `acct_${randomUUID().slice(0, 12)}`;
  await db.query(
    "insert into public.payout_accounts (profile_id, provider, recipient_id, status) values ($1, 'bachs', $2, 'pending')",
    [profileId, recipient],
  );
  return recipient;
}

async function state(db: Db, recipient: string, transfers: boolean, payouts: boolean, outstanding: string[]) {
  await db.query("select public.record_payout_account_state('bachs', $1, $2, $3, $4)", [recipient, transfers, payouts, outstanding]);
  const { rows } = await db.query("select status from public.payout_accounts where recipient_id = $1", [recipient]);
  return rows[0].status;
}

describe("payout account status", () => {
  it("is only payable when both capabilities are active and nothing is outstanding", async () => {
    await withTx(async (db) => {
      const dj = await createUser(db);
      const acct = await addAccount(db, dj);
      // What the sandbox reports straight after creation: active, but no bank account yet.
      expect(await state(db, acct, true, true, ["persons.name", "payout_destination"])).toBe("pending");
      expect(await state(db, acct, true, true, [])).toBe("active");
      // Later restricted by the provider: flagged, not silently pending.
      expect(await state(db, acct, true, false, [])).toBe("restricted");
      expect(await state(db, acct, true, true, [])).toBe("active");
    });
  });

  it("is visible to its owner and admins only; nobody can edit it from the app", async () => {
    await withTx(async (db) => {
      const v = await createStaffedVenue(db);
      await addAccount(db, v.djId);
      const count = (userId: string) =>
        as(db, { userId }, async () => {
          const { rows } = await db.query("select count(*)::int as n from public.payout_accounts where profile_id = $1", [v.djId]);
          return rows[0].n;
        });
      expect(await count(v.djId)).toBe(1);
      expect(await count(v.mcId)).toBe(0);
      expect(await count(v.managerId)).toBe(0);
      expect(await count(await createUser(db, { isAdmin: true }))).toBe(1);
      await as(db, { userId: v.djId }, () =>
        expect(db.query("update public.payout_accounts set status = 'active' where profile_id = $1", [v.djId])).rejects.toThrow(
          /permission denied/,
        ),
      );
    });
  });
});

describe("onboarding and webhook sync (end to end, provider stubbed)", () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const admin = createClient<Database>(url, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });

  function fakeProvider(state: { account: PayeeAccount; created: number }): PaymentProvider {
    return {
      name: "bachs",
      createCheckout: () => Promise.reject(new Error("unused")),
      createRefund: () => Promise.reject(new Error("unused")),
      createPayeeAccount: async () => {
        state.created += 1;
        return state.account;
      },
      getPayeeAccount: async () => state.account,
      createOnboardingLink: async ({ accountId }) => ({ url: `https://sandbox-connect.bachs.io/${accountId}`, expiresAt: "x" }),
      transferToPayee: () => Promise.reject(new Error("unused")),
      getDefaultPayoutDestination: () => Promise.reject(new Error("unused")),
      payoutToBank: () => Promise.reject(new Error("unused")),
      parseWebhook: (rawBody) => {
        const { id, type, account } = JSON.parse(rawBody);
        return { kind: "payee_account_changed", eventId: id, type, accountId: account, payload: {} };
      },
    };
  }

  it("creates the account once, links to hosted onboarding, and turns active on the webhook", async () => {
    const { data: user } = await admin.auth.admin.createUser({ email: `${randomUUID()}@e2e.test`, email_confirm: true });
    const profileId = user.user!.id;
    const accountId = `acct_${randomUUID().slice(0, 12)}`;
    const sim = {
      created: 0,
      account: { accountId, transfersActive: true, payoutsActive: true, outstanding: ["persons.name", "payout_destination"] },
    };
    const deps = { admin, provider: fakeProvider(sim) };
    const input = { profileId, email: "dj@example.com", displayName: "DJ E2E", appUrl: "http://localhost:3000" };

    expect(await startProfileOnboarding(deps, input)).toBe(`https://sandbox-connect.bachs.io/${accountId}`);
    expect(await startProfileOnboarding(deps, input)).toBe(`https://sandbox-connect.bachs.io/${accountId}`);
    expect(sim.created).toBe(1);

    const row = async () =>
      (await admin.from("payout_accounts").select("status, outstanding, contact_email").eq("recipient_id", accountId).single()).data;
    expect(await row()).toEqual({ status: "pending", outstanding: ["persons.name", "payout_destination"], contact_email: "dj@example.com" });

    // They finish on Bachs; capability.updated arrives.
    sim.account = { ...sim.account, outstanding: [] };
    const result = await handlePaymentWebhook(
      JSON.stringify({ id: `evt_${randomUUID()}`, type: "capability.updated", account: accountId }),
      new Headers(),
      deps,
    );
    expect(result.body.result).toBe("payee_synced");
    expect(await row()).toMatchObject({ status: "active", outstanding: [] });

    // Events for accounts that aren't ours are acknowledged and ignored.
    const other = await handlePaymentWebhook(
      JSON.stringify({ id: `evt_${randomUUID()}`, type: "account.updated", account: "acct_someone_else" }),
      new Headers(),
      deps,
    );
    expect(other.body.result).toBe("payee_unknown");
  });
});
