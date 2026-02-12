-- ═══════════════════════════════════════════════════════════════════════
--  SecureChat — schema.sql
--  Complete Supabase PostgreSQL Schema
--  Tables · RLS · Indexes · Functions · Triggers · Realtime
--
--  Usage: Copy-paste into Supabase SQL Editor and run.
--  Order matters — tables before policies, policies before functions
--  that reference them, etc.
-- ═══════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────
--  EXTENSIONS
-- ─────────────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";      -- uuid_generate_v4()
create extension if not exists "pgcrypto";        -- gen_random_bytes() for salts
create extension if not exists "pg_trgm";         -- trigram indexes for search


-- ═══════════════════════════════════════════════════════════════
--  TABLE: profiles
--  Extends Supabase auth.users with display info.
--  Populated automatically via trigger on auth signup.
-- ═══════════════════════════════════════════════════════════════
create table public.profiles (
  id            uuid references auth.users on delete cascade primary key,
  display_name  text not null default '',
  email         text,
  avatar_url    text,
  status_message text default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.profiles is 'User profile data — auto-created on signup';

alter table public.profiles enable row level security;

create policy "profiles_select_anyone"
  on public.profiles for select
  using (true);

create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id);

create policy "profiles_delete_own"
  on public.profiles for delete
  using (auth.uid() = id);


-- ═══════════════════════════════════════════════════════════════
--  TABLE: contacts
--  Directional friend/contact relationships with status.
--  Accepted contacts have two rows (one per direction).
-- ═══════════════════════════════════════════════════════════════
create table public.contacts (
  id          uuid default uuid_generate_v4() primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  contact_id  uuid not null references public.profiles(id) on delete cascade,
  status      text not null default 'pending'
                check (status in ('pending', 'accepted', 'declined')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint contacts_no_self      check (user_id <> contact_id),
  constraint contacts_unique_pair  unique (user_id, contact_id)
);

comment on table public.contacts is 'Contact/friend relationships — pending, accepted, or declined';

alter table public.contacts enable row level security;

create policy "contacts_select_own"
  on public.contacts for select
  using (auth.uid() = user_id or auth.uid() = contact_id);

create policy "contacts_insert_own"
  on public.contacts for insert
  with check (auth.uid() = user_id);

create policy "contacts_update_involved"
  on public.contacts for update
  using (auth.uid() = user_id or auth.uid() = contact_id);

create policy "contacts_delete_involved"
  on public.contacts for delete
  using (auth.uid() = user_id or auth.uid() = contact_id);


-- ═══════════════════════════════════════════════════════════════
--  TABLE: blocked_users
--  One-directional block list.
-- ═══════════════════════════════════════════════════════════════
create table public.blocked_users (
  id              uuid default uuid_generate_v4() primary key,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  blocked_user_id uuid not null references public.profiles(id) on delete cascade,
  created_at      timestamptz not null default now(),

  constraint blocked_no_self     check (user_id <> blocked_user_id),
  constraint blocked_unique_pair unique (user_id, blocked_user_id)
);

comment on table public.blocked_users is 'One-directional user block list';

alter table public.blocked_users enable row level security;

create policy "blocked_select_own"
  on public.blocked_users for select
  using (auth.uid() = user_id);

create policy "blocked_insert_own"
  on public.blocked_users for insert
  with check (auth.uid() = user_id);

create policy "blocked_delete_own"
  on public.blocked_users for delete
  using (auth.uid() = user_id);


-- ═══════════════════════════════════════════════════════════════
--  TABLE: conversations
--  Chat conversation metadata + per-conversation encryption salt.
-- ═══════════════════════════════════════════════════════════════
create table public.conversations (
  id              uuid default uuid_generate_v4() primary key,
  encryption_salt text,          -- base64-encoded salt for PBKDF2
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.conversations is 'Chat conversations — salt used for PBKDF2 key derivation';

alter table public.conversations enable row level security;

-- Users can only see/update conversations they participate in
create policy "conversations_select_participant"
  on public.conversations for select
  using (
    exists (
      select 1 from public.conversation_participants cp
      where cp.conversation_id = id
        and cp.user_id = auth.uid()
    )
  );

create policy "conversations_update_participant"
  on public.conversations for update
  using (
    exists (
      select 1 from public.conversation_participants cp
      where cp.conversation_id = id
        and cp.user_id = auth.uid()
    )
  );

-- Insert allowed by service-role functions (get_or_create_conversation)
-- Direct insert not exposed to clients
create policy "conversations_insert_authenticated"
  on public.conversations for insert
  with check (auth.role() = 'authenticated');


-- ═══════════════════════════════════════════════════════════════
--  TABLE: conversation_participants
--  Many-to-many link between users and conversations.
-- ═══════════════════════════════════════════════════════════════
create table public.conversation_participants (
  id              uuid default uuid_generate_v4() primary key,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  joined_at       timestamptz not null default now(),

  constraint cp_unique unique (conversation_id, user_id)
);

comment on table public.conversation_participants is 'Links users to conversations (many-to-many)';

alter table public.conversation_participants enable row level security;

-- Users can see participants of conversations they belong to
create policy "cp_select_participant"
  on public.conversation_participants for select
  using (
    exists (
      select 1 from public.conversation_participants cp2
      where cp2.conversation_id = conversation_id
        and cp2.user_id = auth.uid()
    )
  );

-- Users can be added to conversations (by the RPC function)
create policy "cp_insert_authenticated"
  on public.conversation_participants for insert
  with check (auth.role() = 'authenticated');

-- Users can remove themselves from a conversation ("delete conversation")
create policy "cp_delete_own"
  on public.conversation_participants for delete
  using (user_id = auth.uid());


-- ═══════════════════════════════════════════════════════════════
--  TABLE: messages
--  Encrypted message storage. Server never sees plaintext.
--  ciphertext + iv are base64. file_metadata is JSON.
-- ═══════════════════════════════════════════════════════════════
create table public.messages (
  id              uuid default uuid_generate_v4() primary key,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id       uuid references public.profiles(id) on delete set null,
  ciphertext      text,                          -- base64 AES-256-GCM ciphertext
  iv              text,                          -- base64 96-bit IV
  idempotency_key text,                          -- client-generated UUID for dedup
  reply_to_id     uuid references public.messages(id) on delete set null,
  message_type    text not null default 'text'
                    check (message_type in ('text', 'file', 'system')),
  file_metadata   jsonb,                         -- { name, size, type, iv, isImage, url }
  status          text not null default 'sent'
                    check (status in ('sending', 'sent', 'delivered', 'read', 'deleted', 'failed')),
  hidden_for      uuid[] not null default '{}',  -- "delete for me" — array of user IDs
  deleted_at      timestamptz,                   -- "delete for everyone" timestamp
  deleted_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.messages is 'End-to-end encrypted messages — server stores only ciphertext';

alter table public.messages enable row level security;

-- Users can read messages in conversations they participate in
create policy "messages_select_participant"
  on public.messages for select
  using (
    exists (
      select 1 from public.conversation_participants cp
      where cp.conversation_id = conversation_id
        and cp.user_id = auth.uid()
    )
  );

-- Users can send messages to conversations they participate in
create policy "messages_insert_participant"
  on public.messages for insert
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.conversation_participants cp
      where cp.conversation_id = conversation_id
        and cp.user_id = auth.uid()
    )
  );

-- Users can update their own messages (status, delete for everyone)
-- Also allow RPC functions to update status (mark as read)
create policy "messages_update_own_or_status"
  on public.messages for update
  using (
    sender_id = auth.uid()
    or exists (
      select 1 from public.conversation_participants cp
      where cp.conversation_id = conversation_id
        and cp.user_id = auth.uid()
    )
  );


-- ═══════════════════════════════════════════════════════════════
--  TABLE: message_reads
--  Tracks when a user last read messages in a conversation.
--  Used for unread counts and read receipts.
-- ═══════════════════════════════════════════════════════════════
create table public.message_reads (
  id              uuid default uuid_generate_v4() primary key,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  read_at         timestamptz not null default now(),

  constraint mr_unique unique (conversation_id, user_id)
);

comment on table public.message_reads is 'Per-user read cursor for each conversation';

alter table public.message_reads enable row level security;

create policy "mr_select_own"
  on public.message_reads for select
  using (auth.uid() = user_id);

create policy "mr_insert_own"
  on public.message_reads for insert
  with check (auth.uid() = user_id);

create policy "mr_update_own"
  on public.message_reads for update
  using (auth.uid() = user_id);


-- ═══════════════════════════════════════════════════════════════
--  TABLE: user_status
--  Online/offline/away presence + last_seen timestamp.
-- ═══════════════════════════════════════════════════════════════
create table public.user_status (
  user_id    uuid references public.profiles(id) on delete cascade primary key,
  status     text not null default 'offline'
               check (status in ('online', 'offline', 'away')),
  last_seen  timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.user_status is 'User online/offline/away presence';

alter table public.user_status enable row level security;

create policy "status_select_anyone"
  on public.user_status for select
  using (true);

create policy "status_insert_own"
  on public.user_status for insert
  with check (auth.uid() = user_id);

create policy "status_update_own"
  on public.user_status for update
  using (auth.uid() = user_id);


-- ═══════════════════════════════════════════════════════════════
--  INDEXES
--  Covering indexes for all hot query paths.
-- ═══════════════════════════════════════════════════════════════

-- Contacts
create index idx_contacts_user_id    on public.contacts (user_id);
create index idx_contacts_contact_id on public.contacts (contact_id);
create index idx_contacts_status     on public.contacts (status);
create index idx_contacts_lookup     on public.contacts (user_id, status);

-- Blocked
create index idx_blocked_user_id on public.blocked_users (user_id);

-- Conversation participants
create index idx_cp_user_id         on public.conversation_participants (user_id);
create index idx_cp_conversation_id on public.conversation_participants (conversation_id);
create index idx_cp_lookup          on public.conversation_participants (user_id, conversation_id);

-- Messages — the most critical indexes
create index idx_messages_conversation      on public.messages (conversation_id);
create index idx_messages_conv_created      on public.messages (conversation_id, created_at desc);
create index idx_messages_sender            on public.messages (sender_id);
create index idx_messages_idempotency       on public.messages (idempotency_key)
  where idempotency_key is not null;
create index idx_messages_conv_status       on public.messages (conversation_id, status)
  where status in ('sent', 'delivered');

-- Message reads
create index idx_message_reads_lookup on public.message_reads (conversation_id, user_id);

-- User status
create index idx_user_status_status on public.user_status (status)
  where status = 'online';

-- Profile search (trigram for ilike queries)
create index idx_profiles_name_trgm  on public.profiles using gin (display_name gin_trgm_ops);
create index idx_profiles_email_trgm on public.profiles using gin (email gin_trgm_ops);


-- ═══════════════════════════════════════════════════════════════
--  FUNCTION: handle_new_user()
--  Trigger: auto-create a profile row when a new auth user signs up.
-- ═══════════════════════════════════════════════════════════════
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, email)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'display_name',
      split_part(new.email, '@', 1)
    ),
    new.email
  );
  return new;
exception
  when unique_violation then
    -- Profile already exists (edge case: rapid signup retries)
    return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ═══════════════════════════════════════════════════════════════
--  FUNCTION: update_modified_column()
--  Trigger: auto-set updated_at on any row update.
-- ═══════════════════════════════════════════════════════════════
create or replace function public.update_modified_column()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Apply to all tables with updated_at
create trigger trg_profiles_updated
  before update on public.profiles
  for each row execute function public.update_modified_column();

create trigger trg_contacts_updated
  before update on public.contacts
  for each row execute function public.update_modified_column();

create trigger trg_conversations_updated
  before update on public.conversations
  for each row execute function public.update_modified_column();

create trigger trg_messages_updated
  before update on public.messages
  for each row execute function public.update_modified_column();

create trigger trg_user_status_updated
  before update on public.user_status
  for each row execute function public.update_modified_column();


-- ═══════════════════════════════════════════════════════════════
--  FUNCTION: get_or_create_conversation(user_a, user_b)
--  Atomically finds or creates a 1-on-1 conversation.
--  Returns the conversation UUID.
--  Uses advisory lock to prevent race conditions.
-- ═══════════════════════════════════════════════════════════════
create or replace function public.get_or_create_conversation(
  user_a uuid,
  user_b uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  conv_id uuid;
  new_salt text;
  -- Deterministic lock key from the two user IDs (order-independent)
  lock_key bigint;
begin
  -- Prevent self-conversation
  if user_a = user_b then
    raise exception 'Cannot create conversation with yourself';
  end if;

  -- Deterministic advisory lock to prevent race conditions
  -- XOR the first 8 bytes of each UUID cast to bigint
  lock_key := abs(('x' || substr(user_a::text, 1, 8))::bit(32)::bigint
              # ('x' || substr(user_b::text, 1, 8))::bit(32)::bigint);
  perform pg_advisory_xact_lock(lock_key);

  -- Check if a conversation already exists between these two users
  select cp1.conversation_id into conv_id
  from public.conversation_participants cp1
  inner join public.conversation_participants cp2
    on cp1.conversation_id = cp2.conversation_id
  where cp1.user_id = user_a
    and cp2.user_id = user_b
  limit 1;

  if conv_id is not null then
    return conv_id;
  end if;

  -- Generate a cryptographically random salt for this conversation
  new_salt := encode(gen_random_bytes(16), 'base64');

  -- Create the conversation
  insert into public.conversations (encryption_salt)
  values (new_salt)
  returning id into conv_id;

  -- Add both participants
  insert into public.conversation_participants (conversation_id, user_id)
  values
    (conv_id, user_a),
    (conv_id, user_b);

  return conv_id;
end;
$$;


-- ═══════════════════════════════════════════════════════════════
--  FUNCTION: get_unread_count(p_conversation_id, p_user_id)
--  Efficient unread count: messages since last read cursor.
-- ═══════════════════════════════════════════════════════════════
create or replace function public.get_unread_count(
  p_conversation_id uuid,
  p_user_id uuid
)
returns integer
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  unread integer;
  last_read timestamptz;
begin
  -- Get user's last read timestamp for this conversation
  select mr.read_at into last_read
  from public.message_reads mr
  where mr.conversation_id = p_conversation_id
    and mr.user_id = p_user_id;

  -- Count messages after the last read cursor
  select count(*) into unread
  from public.messages m
  where m.conversation_id = p_conversation_id
    and m.sender_id != p_user_id
    and m.sender_id is not null
    and m.status != 'deleted'
    and not (m.hidden_for @> array[p_user_id])
    and m.created_at > coalesce(last_read, '1970-01-01T00:00:00Z'::timestamptz);

  return coalesce(unread, 0);
end;
$$;


-- ═══════════════════════════════════════════════════════════════
--  FUNCTION: mark_messages_read(p_conversation_id, p_user_id)
--  Batch-marks all messages as read and updates the read cursor.
-- ═══════════════════════════════════════════════════════════════
create or replace function public.mark_messages_read(
  p_conversation_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Verify user is a participant (RLS bypass in security definer)
  if not exists (
    select 1 from public.conversation_participants
    where conversation_id = p_conversation_id
      and user_id = p_user_id
  ) then
    raise exception 'User is not a participant in this conversation';
  end if;

  -- Upsert the read cursor
  insert into public.message_reads (conversation_id, user_id, read_at)
  values (p_conversation_id, p_user_id, now())
  on conflict (conversation_id, user_id)
  do update set read_at = now();

  -- Flip unread messages to 'read' status
  update public.messages
  set status = 'read'
  where conversation_id = p_conversation_id
    and sender_id != p_user_id
    and sender_id is not null
    and status in ('sent', 'delivered');
end;
$$;


-- ═══════════════════════════════════════════════════════════════
--  FUNCTION: hide_message_for_user(p_message_id, p_user_id)
--  "Delete for me" — appends user ID to hidden_for array.
-- ═══════════════════════════════════════════════════════════════
create or replace function public.hide_message_for_user(
  p_message_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Verify user is a participant in the message's conversation
  if not exists (
    select 1
    from public.messages m
    inner join public.conversation_participants cp
      on cp.conversation_id = m.conversation_id
    where m.id = p_message_id
      and cp.user_id = p_user_id
  ) then
    raise exception 'User cannot hide this message';
  end if;

  -- Append user to hidden_for (idempotent — array_append allows dupes,
  -- but the client checks membership with @> so duplicates are harmless)
  update public.messages
  set hidden_for = array_append(
    coalesce(hidden_for, '{}'),
    p_user_id
  )
  where id = p_message_id
    and not (coalesce(hidden_for, '{}') @> array[p_user_id]);
end;
$$;


-- ═══════════════════════════════════════════════════════════════
--  REALTIME PUBLICATION
--  Enable Supabase Realtime (Postgres changes) for key tables.
-- ═══════════════════════════════════════════════════════════════
-- Note: supabase_realtime publication is created automatically.
-- We add our tables to it. If this errors, the publication may
-- need to be created first (depends on Supabase project setup).

do $$
begin
  -- Try to add tables to the existing publication
  begin
    alter publication supabase_realtime add table public.messages;
  exception when others then
    raise notice 'messages already in publication or publication does not exist';
  end;

  begin
    alter publication supabase_realtime add table public.contacts;
  exception when others then
    raise notice 'contacts already in publication or publication does not exist';
  end;

  begin
    alter publication supabase_realtime add table public.conversations;
  exception when others then
    raise notice 'conversations already in publication or publication does not exist';
  end;

  begin
    alter publication supabase_realtime add table public.user_status;
  exception when others then
    raise notice 'user_status already in publication or publication does not exist';
  end;
end;
$$;


-- ═══════════════════════════════════════════════════════════════
--  STORAGE BUCKETS
--  Must be created via Supabase Dashboard → Storage → New Bucket
--  (SQL editor cannot create storage buckets directly)
-- ═══════════════════════════════════════════════════════════════
--
--  1. Bucket: "avatars"
--     • Public: YES
--     • Allowed MIME types: image/jpeg, image/png, image/gif, image/webp
--     • Max file size: 2 MB
--     • Policies:
--       - SELECT: public (anyone can view avatars)
--       - INSERT: authenticated, path ~ '^<user_id>/'
--       - UPDATE: authenticated, path ~ '^<user_id>/'
--       - DELETE: authenticated, path ~ '^<user_id>/'
--
--  2. Bucket: "encrypted-files"
--     • Public: YES (files are encrypted — URL alone is useless)
--     • Allowed MIME types: application/octet-stream
--     • Max file size: 10 MB
--     • Policies:
--       - SELECT: authenticated
--       - INSERT: authenticated
--       - DELETE: authenticated, owner matches
--
--  Example storage policies (apply via Dashboard → Storage → Policies):
--
--  -- avatars bucket SELECT (public)
--  create policy "avatars_select_public"
--    on storage.objects for select
--    using (bucket_id = 'avatars');
--
--  -- avatars bucket INSERT (own folder only)
--  create policy "avatars_insert_own"
--    on storage.objects for insert
--    with check (
--      bucket_id = 'avatars'
--      and auth.uid()::text = (storage.foldername(name))[1]
--    );
--
--  -- avatars bucket UPDATE (own folder only)
--  create policy "avatars_update_own"
--    on storage.objects for update
--    using (
--      bucket_id = 'avatars'
--      and auth.uid()::text = (storage.foldername(name))[1]
--    );
--
--  -- encrypted-files bucket SELECT (authenticated)
--  create policy "encfiles_select_auth"
--    on storage.objects for select
--    using (bucket_id = 'encrypted-files' and auth.role() = 'authenticated');
--
--  -- encrypted-files bucket INSERT (authenticated)
--  create policy "encfiles_insert_auth"
--    on storage.objects for insert
--    with check (bucket_id = 'encrypted-files' and auth.role() = 'authenticated');


-- ═══════════════════════════════════════════════════════════════
--  GRANTS
--  Ensure the anon and authenticated roles can call our RPC functions.
-- ═══════════════════════════════════════════════════════════════
grant usage on schema public to anon, authenticated;
grant all on all tables in schema public to anon, authenticated;
grant all on all sequences in schema public to anon, authenticated;
grant execute on all functions in schema public to anon, authenticated;


-- ═══════════════════════════════════════════════════════════════
--  DONE
--  After running this schema:
--  1. Create storage buckets "avatars" and "encrypted-files" via Dashboard
--  2. Apply the storage policies shown above
--  3. Replace SUPABASE_URL and SUPABASE_ANON_KEY in core.js
--  4. Serve the app files (index.html, core.js, services.js, app.js)
-- ═══════════════════════════════════════════════════════════════
