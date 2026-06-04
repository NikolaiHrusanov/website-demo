# NexusBank — Card system setup

Run in **Supabase Dashboard → SQL Editor** (in order):

1. `supabase/banking-schema.sql`
2. `supabase/money-management.sql`
3. `supabase/cards-schema.sql`
4. **`supabase/cards-schema-v2.sql`** ← enhanced features (encryption, partners, analytics)

Optional for transfers:

5. `supabase/recipient-lookup.sql`

## Realtime

In **Database → Replication**, add to `supabase_realtime`:

- `cards`
- `card_transactions`
- `card_settings`

## Security (important)

- **Full card numbers** are encrypted in Postgres via `pgp_sym_encrypt` inside RPCs (`add_external_card_secure`). The app only reads from the `cards_safe` view, which **never** exposes encrypted data.
- **CVV** is validated when adding a card and is **never stored** (PCI best practice).
- For production, move encryption keys to **Supabase Vault** and use a payment processor (Stripe Issuing, etc.)—this demo stack is for learning/UI, not live PAN processing.

## Card programs

| Program | `partner_type` |
|---------|----------------|
| NexusBank Standard | `standard` |
| NexusBank × Flexi | `flexi` |
| NexusBank × Blaze Wear | `blaze_wear` |
| External debit/credit | `none` |
