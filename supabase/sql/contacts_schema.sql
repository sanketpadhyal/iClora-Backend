create table if not exists contacts_meta (
  user_id text primary key,
  active boolean not null default false,
  status text not null default 'inactive',
  storage_used numeric not null default 0,
  contacts_count integer not null default 0,
  activated_on timestamptz,
  activated_on_label text,
  updated_at timestamptz
);

create table if not exists contacts_items (
  user_id text not null,
  id text not null,
  display_name text not null default 'New Contact',
  first_name text not null default '',
  last_name text not null default '',
  company text not null default '',
  phone text not null default '',
  extra_phones jsonb not null default '[]'::jsonb,
  email text not null default '',
  birthday text not null default '',
  address text not null default '',
  note text not null default '',
  photo_url text not null default '',
  photo_public_id text not null default '',
  photo_storage_used numeric not null default 0,
  system boolean not null default false,
  storage_used numeric not null default 0,
  created_at_label text,
  created_at timestamptz,
  updated_at timestamptz,
  primary key (user_id, id)
);

alter table contacts_items add column if not exists photo_url text not null default '';
alter table contacts_items add column if not exists photo_public_id text not null default '';
alter table contacts_items add column if not exists photo_storage_used numeric not null default 0;
alter table contacts_items add column if not exists extra_phones jsonb not null default '[]'::jsonb;
alter table contacts_items add column if not exists birthday text not null default '';
alter table contacts_items add column if not exists address text not null default '';

create index if not exists idx_contacts_items_user_display on contacts_items(user_id, display_name asc);
