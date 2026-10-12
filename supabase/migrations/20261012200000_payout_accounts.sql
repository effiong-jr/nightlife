-- Payout accounts (Bachs Connect): DJs/MCs (and, via admin, venues) get a
-- connected account, verified on the provider's hosted onboarding page. We
-- store only the account ID and its state, never ID documents or bank details.
-- A party can be paid once both `transfers` and `payouts` are active AND
-- nothing is outstanding: Bachs reports the capabilities active before the
-- bank account (`payout_destination`) has even been added.

alter table public.payout_accounts
  add column contact_email text check (contact_email is null or length(contact_email) <= 254),
  add column transfers_active boolean not null default false,
  add column payouts_active boolean not null default false,
  -- Requirement keys the provider still wants (for "Bachs still needs: …").
  add column outstanding text[] not null default '{}',
  add column synced_at timestamptz;

-- The provider's view of an account, as fetched by our server (webhook or
-- return from onboarding). Status follows the capabilities.
create function public.record_payout_account_state(
  p_provider text,
  p_recipient_id text,
  p_transfers_active boolean,
  p_payouts_active boolean,
  p_outstanding text[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.payout_accounts
  set transfers_active = p_transfers_active,
      payouts_active = p_payouts_active,
      outstanding = coalesce(p_outstanding, '{}'),
      status = case
        when p_transfers_active and p_payouts_active and coalesce(array_length(p_outstanding, 1), 0) = 0
          then 'active'::public.payout_account_status
        -- Was payable, now isn't: Bachs restricted it (needs attention).
        when status = 'active' then 'restricted'
        else 'pending'
      end,
      synced_at = now(),
      updated_at = now()
  where provider = p_provider and recipient_id = p_recipient_id;
  if not found then
    raise exception 'payout account % not found', p_recipient_id using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.record_payout_account_state(text, text, boolean, boolean, text[]) from public, anon, authenticated;
grant execute on function public.record_payout_account_state(text, text, boolean, boolean, text[]) to service_role;
