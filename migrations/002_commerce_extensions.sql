-- Additive commerce extensions. Existing data is preserved.
create table if not exists wishlists (user_id text not null references users(id) on delete cascade,product_id text not null references products(id) on delete cascade,created_at text not null,primary key(user_id,product_id));
create table if not exists order_status_events (id text primary key,order_id text not null references orders(id) on delete cascade,status text not null,note text,created_at text not null);
create index if not exists idx_order_status_events_order on order_status_events(order_id,created_at);
create table if not exists product_reviews (id text primary key,product_id text not null references products(id) on delete cascade,user_id text references users(id),order_id text references orders(id),rating integer not null check(rating between 1 and 5),message text not null,verified_purchase integer not null default 0,active integer not null default 1,created_at text not null);
create index if not exists idx_product_reviews_product on product_reviews(product_id,active,created_at);
