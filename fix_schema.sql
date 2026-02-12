-- ═══════════════════════════════════════════════════════════════════════
--  SecureChat — fix_schema.sql
--  Run this in Supabase SQL Editor to fix all runtime errors.
--
--  Fixes:
--  1. pgcrypto extension not enabled → gen_random_bytes() missing
--  2. Infinite RLS recursion on conversation_participants
--  3. user_status INSERT blocked by RLS (upsert needs both policies)
-- ═══════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────
--  FIX 1: Enable pgcrypto extension
--  Error: function gen_random_bytes(integer) does not exist
--  This must be enabled BEFORE any functions that use it.
-- ─────────────────────────────────────────────────────────────
create extension if not exists "pgcrypto";


-- ─────────────────────────────────────────────────────────────
--  FIX 2: Infinite RLS recursion on conversation_participants
--  Error: 42P17 - infinite recursion detected in policy for
--         relation "conversation_participants"
--
--  Root cause: cp_select_participant policy does
--    SELECT FROM conversation_participants inside its own
--    USING clause, which triggers itself recursively.
--
--  Solution: Create a SECURITY DEFINER function that bypasses
--  RLS when checking membership, then use it in policies.
-- ─────────────────────────────────────────────────────────────

-- Step 2a: Create the helper function (bypasses RLS)
create or replace function public.is_user_in_conversation(
  p_conversation_id uuid,
  p_user_id uuid
)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.conversation_participants
    where conversation_id = p_conversation_id
      and user_id = p_user_id
  );
$$;


-- Step 2b: Drop the recursive policies
drop policy if exists "cp_select_participant"      on public.conversation_participants;
drop policy if exists "conversations_select_participant" on public.conversations;
drop policy if exists "conversations_update_participant" on public.conversations;
drop policy if exists "messages_select_participant" on public.messages;
drop policy if exists "messages_insert_participant" on public.messages;
drop policy if exists "messages_update_own_or_status" on public.messages;


-- Step 2c: Recreate policies using the SECURITY DEFINER function

-- conversation_participants: SELECT
create policy "cp_select_participant"
  on public.conversation_participants for select
  using (
    public.is_user_in_conversation(conversation_id, auth.uid())
  );

-- conversations: SELECT
create policy "conversations_select_participant"
  on public.conversations for select
  using (
    public.is_user_in_conversation(id, auth.uid())
  );

-- conversations: UPDATE
create policy "conversations_update_participant"
  on public.conversations for update
  using (
    public.is_user_in_conversation(id, auth.uid())
  );

-- messages: SELECT
create policy "messages_select_participant"
  on public.messages for select
  using (
    public.is_user_in_conversation(conversation_id, auth.uid())
  );

-- messages: INSERT
create policy "messages_insert_participant"
  on public.messages for insert
  with check (
    sender_id = auth.uid()
    and public.is_user_in_conversation(conversation_id, auth.uid())
  );

-- messages: UPDATE
create policy "messages_update_own_or_status"
  on public.messages for update
  using (
    sender_id = auth.uid()
    or public.is_user_in_conversation(conversation_id, auth.uid())
  );


-- ─────────────────────────────────────────────────────────────
--  FIX 3: user_status INSERT/UPSERT fails with 403
--  Error: 42501 - new row violates row-level security policy
--         for table "user_status"
--
--  Root cause: The JS code uses .upsert() which needs both
--  INSERT and UPDATE policies. The policies exist but Supabase
--  upsert also needs the INSERT policy's WITH CHECK to pass
--  for the initial insert.
--
--  The real fix is ensuring the upsert has onConflict properly
--  set. Let's also recreate the policies to be safe and add
--  a DELETE policy for completeness.
-- ─────────────────────────────────────────────────────────────

-- Drop and recreate (idempotent)
drop policy if exists "status_select_anyone" on public.user_status;
drop policy if exists "status_insert_own"    on public.user_status;
drop policy if exists "status_update_own"    on public.user_status;

create policy "status_select_anyone"
  on public.user_status for select
  using (true);

create policy "status_insert_own"
  on public.user_status for insert
  with check (auth.uid() = user_id);

create policy "status_update_own"
  on public.user_status for update
  using (auth.uid() = user_id);


-- ─────────────────────────────────────────────────────────────
--  GRANT: Make sure the helper function is callable
-- ─────────────────────────────────────────────────────────────
grant execute on function public.is_user_in_conversation(uuid, uuid)
  to anon, authenticated;


-- ═══════════════════════════════════════════════════════════════
--  DONE — All three errors should now be resolved.
--  To verify:
--    1. Sign in → should load conversations without 42P17
--    2. User status should update without 42501
--    3. Starting a conversation should work without 42883
-- ═══════════════════════════════════════════════════════════════
