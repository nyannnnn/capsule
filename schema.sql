-- Wardrobe app: run this once in Supabase → SQL Editor → New query → Run.
-- Every row and photo is locked to the signed-in user (row level security).

create table if not exists public.items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  no          int,
  name        text,
  category    text,
  colour      text,
  brand       text,
  size        text,
  styles      text[] default '{}',
  seasons     text[] default '{}',
  fit         text,
  condition   text,
  length_cm   numeric,
  width_cm    numeric,
  weight_g    numeric,
  fate        text default 'undecided',
  away        boolean default false,
  notes       text,
  photo_path  text,
  thumb_path  text,
  back_path   text,
  back_thumb_path text,
  cut_path    text,
  back_cut_path text,
  wear_count  int default 0,
  last_worn   date,
  created_at  timestamptz default now()
);

create table if not exists public.wears (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null default auth.uid() references auth.users on delete cascade,
  worn_on   date not null default current_date,
  item_ids  uuid[] not null,
  note      text,
  created_at timestamptz default now()
);

create table if not exists public.profile (
  user_id    uuid primary key default auth.uid() references auth.users on delete cascade,
  data       jsonb not null default '{}',
  updated_at timestamptz default now()
);

alter table public.items   enable row level security;
alter table public.wears   enable row level security;
alter table public.profile enable row level security;

create policy "own items"   on public.items   for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own wears"   on public.wears   for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own profile" on public.profile for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Private photo bucket; each user can only touch files under their own folder.
insert into storage.buckets (id, name, public) values ('closet', 'closet', false)
  on conflict (id) do nothing;

create policy "own photos read"   on storage.objects for select
  using (bucket_id = 'closet' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own photos write"  on storage.objects for insert
  with check (bucket_id = 'closet' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own photos update" on storage.objects for update
  using (bucket_id = 'closet' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own photos delete" on storage.objects for delete
  using (bucket_id = 'closet' and (storage.foldername(name))[1] = auth.uid()::text);
