exports.up = async function up(knex) {
  await knex.raw("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  await knex.raw("CREATE EXTENSION IF NOT EXISTS citext");

  await knex.raw(`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email citext NOT NULL UNIQUE,
      password_hash text NOT NULL,
      full_name text NOT NULL,
      phone text,
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED','DELETED')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE properties (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug text NOT NULL UNIQUE,
      name text NOT NULL,
      description text,
      address_line text NOT NULL,
      ward text,
      district text,
      city text NOT NULL,
      country_code char(2) NOT NULL DEFAULT 'VN',
      latitude numeric(9,6),
      longitude numeric(9,6),
      check_in_time time,
      check_out_time time,
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX properties_status_city_idx ON properties(status, city);

    CREATE TABLE property_images (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      url text NOT NULL,
      alt_text text,
      sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0)
    );

    CREATE TABLE amenities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code text NOT NULL UNIQUE,
      name text NOT NULL,
      icon text
    );

    CREATE TABLE property_amenities (
      property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      amenity_id uuid NOT NULL REFERENCES amenities(id) ON DELETE RESTRICT,
      PRIMARY KEY (property_id, amenity_id)
    );

    CREATE TABLE room_types (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      name text NOT NULL,
      description text,
      max_guests integer NOT NULL CHECK (max_guests > 0),
      bed_count integer NOT NULL DEFAULT 0 CHECK (bed_count >= 0),
      bathroom_count numeric(4,1) NOT NULL DEFAULT 0 CHECK (bathroom_count >= 0),
      base_price numeric(15,0) NOT NULL CHECK (base_price >= 0),
      currency char(3) NOT NULL DEFAULT 'VND',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, property_id)
    );
    CREATE INDEX room_types_property_idx ON room_types(property_id);
    CREATE INDEX room_types_base_price_idx ON room_types(base_price);

    CREATE TABLE rooms (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      room_type_id uuid NOT NULL,
      property_id uuid NOT NULL,
      room_code text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (property_id, room_code),
      FOREIGN KEY (room_type_id, property_id)
        REFERENCES room_types(id, property_id) ON DELETE RESTRICT
    );
    CREATE INDEX rooms_room_type_idx ON rooms(room_type_id);

    CREATE TABLE carts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE cart_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      cart_id uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
      room_type_id uuid NOT NULL REFERENCES room_types(id) ON DELETE RESTRICT,
      check_in date NOT NULL,
      check_out date NOT NULL,
      room_quantity integer NOT NULL CHECK (room_quantity > 0),
      adults integer NOT NULL CHECK (adults > 0),
      children integer NOT NULL DEFAULT 0 CHECK (children >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (check_out > check_in),
      UNIQUE (cart_id, room_type_id, check_in, check_out)
    );
    CREATE INDEX cart_items_cart_idx ON cart_items(cart_id);

    CREATE TABLE bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_code text NOT NULL UNIQUE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      room_type_id uuid NOT NULL REFERENCES room_types(id) ON DELETE RESTRICT,
      check_in date NOT NULL,
      check_out date NOT NULL,
      room_quantity integer NOT NULL CHECK (room_quantity > 0),
      adults integer NOT NULL CHECK (adults > 0),
      children integer NOT NULL DEFAULT 0 CHECK (children >= 0),
      contact_full_name text NOT NULL,
      contact_email text NOT NULL,
      contact_phone text NOT NULL,
      special_requests text,
      status text NOT NULL DEFAULT 'PENDING_PAYMENT'
        CHECK (status IN ('PENDING_PAYMENT','CONFIRMED','CANCELLED','EXPIRED','COMPLETED')),
      night_count integer NOT NULL CHECK (night_count > 0),
      subtotal numeric(15,0) NOT NULL CHECK (subtotal >= 0),
      discount numeric(15,0) NOT NULL DEFAULT 0 CHECK (discount >= 0),
      total_amount numeric(15,0) NOT NULL CHECK (total_amount >= 0),
      currency char(3) NOT NULL DEFAULT 'VND',
      idempotency_key text NOT NULL,
      request_fingerprint text NOT NULL,
      hold_expires_at timestamptz,
      confirmed_at timestamptz,
      cancelled_at timestamptz,
      cancellation_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (check_out > check_in),
      CHECK (total_amount = subtotal - discount),
      UNIQUE (user_id, idempotency_key)
    );
    CREATE INDEX bookings_user_created_idx ON bookings(user_id, created_at DESC);
    CREATE INDEX bookings_selection_idx ON bookings(room_type_id, check_in, check_out, status);
    CREATE INDEX bookings_expiry_idx ON bookings(status, hold_expires_at);

    CREATE TABLE room_availability (
      room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      stay_date date NOT NULL,
      price numeric(15,0) NOT NULL CHECK (price >= 0),
      status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','HELD','BOOKED','CLOSED')),
      booking_id uuid REFERENCES bookings(id) ON DELETE RESTRICT,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (room_id, stay_date),
      CHECK ((booking_id IS NULL) = (status IN ('OPEN','CLOSED')))
    );
    CREATE INDEX room_availability_date_status_idx ON room_availability(stay_date, status);
    CREATE INDEX room_availability_booking_idx ON room_availability(booking_id);

    CREATE TABLE booking_rooms (
      booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
      PRIMARY KEY (booking_id, room_id)
    );

    CREATE TABLE booking_nights (
      booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
      stay_date date NOT NULL,
      price numeric(15,0) NOT NULL CHECK (price >= 0),
      PRIMARY KEY (booking_id, room_id, stay_date)
    );

    CREATE TABLE payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
      provider text NOT NULL DEFAULT 'ZALOPAY' CHECK (provider IN ('ZALOPAY')),
      attempt_number integer NOT NULL CHECK (attempt_number > 0),
      app_trans_id text NOT NULL UNIQUE,
      provider_trans_id text UNIQUE,
      amount numeric(15,0) NOT NULL CHECK (amount >= 0),
      currency char(3) NOT NULL DEFAULT 'VND',
      status text NOT NULL DEFAULT 'CREATED'
        CHECK (status IN ('CREATED','PENDING','SUCCEEDED','FAILED','EXPIRED')),
      checkout_url text,
      provider_code text,
      provider_message text,
      expires_at timestamptz NOT NULL,
      paid_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (booking_id, provider, attempt_number)
    );
    CREATE INDEX payments_status_expiry_idx ON payments(status, expires_at);
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    DROP TABLE IF EXISTS payments;
    DROP TABLE IF EXISTS booking_nights;
    DROP TABLE IF EXISTS booking_rooms;
    DROP TABLE IF EXISTS room_availability;
    DROP TABLE IF EXISTS bookings;
    DROP TABLE IF EXISTS cart_items;
    DROP TABLE IF EXISTS carts;
    DROP TABLE IF EXISTS rooms;
    DROP TABLE IF EXISTS room_types;
    DROP TABLE IF EXISTS property_amenities;
    DROP TABLE IF EXISTS amenities;
    DROP TABLE IF EXISTS property_images;
    DROP TABLE IF EXISTS properties;
    DROP TABLE IF EXISTS users;
  `);
};
