create table if not exists gate_residual_buckets (
  billing_user_id text not null,
  billing_account_id text not null,
  meter_code text not null,
  pricing_fingerprint text not null,
  denom text not null,
  rounding text not null,
  remainder_numer text not null,
  updated_at timestamptz default now(),
  primary key (billing_user_id, meter_code, pricing_fingerprint)
);

alter table gate_residual_buckets enable row level security;
create policy p_residual_rw on gate_residual_buckets
  using (
    billing_user_id = current_setting('app.billing_user_id', true)
    and billing_account_id = current_setting('app.billing_account_id', true)
  )
  with check (
    billing_user_id = current_setting('app.billing_user_id', true)
    and billing_account_id = current_setting('app.billing_account_id', true)
  );

grant select, insert, update, delete on gate_residual_buckets to vluna;
