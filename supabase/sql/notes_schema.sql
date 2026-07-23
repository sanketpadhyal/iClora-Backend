create table if not exists notes_folders (
  id text not null,
  user_id text not null,
  name text not null,
  system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists notes_items (
  id text not null,
  user_id text not null,
  folder_id text not null,
  title text not null,
  "from" text,
  content text not null default '',
  preview text not null default '',
  pinned boolean not null default false,
  locked boolean not null default false,
  system boolean not null default false,
  storage_used numeric(12,4) not null default 0,
  created_at_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists notes_meta (
  user_id text primary key,
  active boolean not null default false,
  status text not null default 'activate',
  storage_used numeric(12,4) not null default 0,
  notes_count integer not null default 0,
  folders_count integer not null default 0,
  activated_on timestamptz,
  activated_on_label text,
  updated_at timestamptz not null default now()
);

alter table notes_items add column if not exists "from" text;
alter table notes_items add column if not exists created_at_label text;

create index if not exists idx_notes_items_user_updated on notes_items(user_id, updated_at desc);
create index if not exists idx_notes_items_user_folder_updated on notes_items(user_id, folder_id, updated_at desc);
create index if not exists idx_notes_folders_user_updated on notes_folders(user_id, updated_at desc);

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'notes_folders_pkey'
      and conrelid = 'public.notes_folders'::regclass
  ) then
    alter table notes_folders drop constraint notes_folders_pkey;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'notes_folders_user_id_id_pkey'
      and conrelid = 'public.notes_folders'::regclass
  ) then
    alter table notes_folders add constraint notes_folders_user_id_id_pkey primary key (user_id, id);
  end if;

  if exists (
    select 1
    from pg_constraint
    where conname = 'notes_items_pkey'
      and conrelid = 'public.notes_items'::regclass
  ) then
    alter table notes_items drop constraint notes_items_pkey;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'notes_items_user_id_id_pkey'
      and conrelid = 'public.notes_items'::regclass
  ) then
    alter table notes_items add constraint notes_items_user_id_id_pkey primary key (user_id, id);
  end if;
end $$;
