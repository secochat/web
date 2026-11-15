-- CoChat – Datenbankschema (im Supabase SQL Editor ausführen)

create extension if not exists pgcrypto;

-- ───────── Tabellen ─────────
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  security_code text not null,
  public_key text not null,               -- RSA-OAEP, SPKI, base64
  enc_private_key text not null,          -- mit Passwort-abgeleitetem AES-Schlüssel verschlüsselt (base64)
  key_salt text not null,
  key_iv text not null,
  rec_enc_private_key text,               -- gleicher private Schlüssel, mit dem Wiederherstellungsschlüssel verschlüsselt
  rec_salt text,
  rec_iv text,
  created_at timestamptz not null default now()
);
create unique index profiles_username_uq on public.profiles (lower(username));
create unique index profiles_code_uq on public.profiles (security_code);

create table public.profile_private (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null
);

create table public.contacts (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  contact_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, contact_id),
  check (owner_id <> contact_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  ciphertext text not null,
  iv text not null,
  key_for_recipient text not null,
  key_for_sender text not null,
  status text not null default 'sent' check (status in ('sent','delivered','read')),
  created_at timestamptz not null default now()
);
create index messages_pair_idx on public.messages (sender_id, recipient_id, created_at);
create index messages_recipient_idx on public.messages (recipient_id, status);

-- CoChatAI-Verlauf (NICHT Ende-zu-Ende verschlüsselt, da Google die Inhalte verarbeiten muss)
create table public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user','model')),
  content text not null,
  created_at timestamptz not null default now()
);
create index ai_messages_user_idx on public.ai_messages (user_id, created_at);

-- ───────── Row Level Security ─────────
alter table public.profiles enable row level security;
alter table public.profile_private enable row level security;
alter table public.contacts enable row level security;
alter table public.messages enable row level security;
alter table public.ai_messages enable row level security;

create policy "profil: eigenes oder Kontakt/Chatpartner lesen" on public.profiles
  for select to authenticated using (
    id = auth.uid()
    or exists (select 1 from public.contacts c where c.owner_id = auth.uid() and c.contact_id = profiles.id)
    or exists (select 1 from public.messages m where (m.sender_id = profiles.id and m.recipient_id = auth.uid()))
  );

create policy "profil: eigenes Schlüsselmaterial ändern" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "private: nur eigene" on public.profile_private
  for select to authenticated using (id = auth.uid());

create policy "kontakte: eigene lesen" on public.contacts
  for select to authenticated using (owner_id = auth.uid());
create policy "kontakte: eigene löschen" on public.contacts
  for delete to authenticated using (owner_id = auth.uid());

create policy "nachrichten: Beteiligte lesen" on public.messages
  for select to authenticated using (sender_id = auth.uid() or recipient_id = auth.uid());
create policy "nachrichten: als sich selbst senden" on public.messages
  for insert to authenticated with check (sender_id = auth.uid() and status = 'sent');
create policy "nachrichten: Empfänger setzt Status" on public.messages
  for update to authenticated using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());

create policy "ki: eigene lesen" on public.ai_messages
  for select to authenticated using (user_id = auth.uid());
create policy "ki: eigene Nutzer-Nachricht schreiben" on public.ai_messages
  for insert to authenticated with check (user_id = auth.uid() and role = 'user');
create policy "ki: eigenen Verlauf löschen" on public.ai_messages
  for delete to authenticated using (user_id = auth.uid());

-- Empfänger darf nur den Status ändern, nichts sonst
create or replace function public.messages_only_status() returns trigger
language plpgsql as $$
begin
  if new.sender_id <> old.sender_id or new.recipient_id <> old.recipient_id
     or new.ciphertext <> old.ciphertext or new.iv <> old.iv
     or new.key_for_recipient <> old.key_for_recipient or new.key_for_sender <> old.key_for_sender
     or new.created_at <> old.created_at then
    raise exception 'Nur der Status darf geändert werden';
  end if;
  if old.status = 'read' and new.status <> 'read' then
    raise exception 'Status kann nicht zurückgesetzt werden';
  end if;
  return new;
end $$;
create trigger messages_only_status_trg before update on public.messages
  for each row execute function public.messages_only_status();

-- ───────── Funktionen ─────────
-- Verfügbarkeit prüfen (auch vor der Registrierung, daher anon erlaubt)
create or replace function public.is_available(p_username text, p_code text)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'username_free', not exists (select 1 from profiles where lower(username) = lower(p_username)),
    'code_free',     not exists (select 1 from profiles where security_code = p_code)
  );
$$;
grant execute on function public.is_available(text, text) to anon, authenticated;

-- Trigger: Profil bei E-Mail-Registrierung aus den Metadaten anlegen
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare m jsonb := new.raw_user_meta_data;
begin
  insert into profile_private (id, email) values (new.id, new.email);
  if m ? 'username' and m ? 'security_code' and m ? 'public_key' then
    insert into profiles (id, username, security_code, public_key, enc_private_key, key_salt, key_iv,
                          rec_enc_private_key, rec_salt, rec_iv)
    values (new.id, m->>'username', m->>'security_code', m->>'public_key',
            m->>'enc_private_key', m->>'key_salt', m->>'key_iv',
            m->>'rec_enc_private_key', m->>'rec_salt', m->>'rec_iv');
  end if;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Profil nachträglich anlegen (z. B. nach „Mit Google fortfahren“)
create or replace function public.create_profile(
  p_username text, p_code text, p_public_key text,
  p_enc_private_key text, p_salt text, p_iv text,
  p_rec_enc text, p_rec_salt text, p_rec_iv text
) returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  insert into profiles (id, username, security_code, public_key, enc_private_key, key_salt, key_iv,
                        rec_enc_private_key, rec_salt, rec_iv)
  values (auth.uid(), p_username, p_code, p_public_key, p_enc_private_key, p_salt, p_iv,
          p_rec_enc, p_rec_salt, p_rec_iv);
end $$;
grant execute on function public.create_profile(text,text,text,text,text,text,text,text,text) to authenticated;

-- Kontakt per Benutzername, E-Mail oder Sicherheitscode hinzufügen (gegenseitig)
create or replace function public.add_contact(p_query text)
returns public.profiles language plpgsql security definer set search_path = public as $$
declare target public.profiles; q text := trim(p_query);
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet'; end if;
  select p.* into target from profiles p
   where p.security_code = q
      or lower(p.username) = lower(q)
      or p.id = (select pp.id from profile_private pp where lower(pp.email) = lower(q))
   limit 1;
  if target.id is null then raise exception 'Kein Nutzer gefunden'; end if;
  if target.id = auth.uid() then raise exception 'Das bist du selbst'; end if;
  insert into contacts (owner_id, contact_id) values (auth.uid(), target.id) on conflict do nothing;
  insert into contacts (owner_id, contact_id) values (target.id, auth.uid()) on conflict do nothing;
  return target;
end $$;
grant execute on function public.add_contact(text) to authenticated;

-- ───────── Realtime ─────────
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.ai_messages;

-- Kontakt-Änderungen live empfangen
alter publication supabase_realtime add table public.contacts;
