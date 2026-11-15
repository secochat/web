-- CoChat – Migration: Wiederherstellungsschlüssel
-- NUR ausführen, wenn du schema.sql schon früher ausgeführt hast (im Supabase SQL Editor).
-- Bei einer frischen Datenbank reicht schema.sql, diese Datei wird dann nicht gebraucht.

alter table public.profiles
  add column if not exists rec_enc_private_key text,
  add column if not exists rec_salt text,
  add column if not exists rec_iv text;

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

drop function if exists public.create_profile(text,text,text,text,text,text);
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
