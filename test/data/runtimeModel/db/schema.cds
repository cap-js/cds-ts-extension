namespace rt;

// Custom type alias — exercises resolveBaseType chain-walking to a cds.* base.
type Name : String(100);

// All built-in scalar types the plugin's cdsTypeToTs claims to map.
// One entity collects them so a single row round-trips every type at runtime.
entity Scalars {
  key ID        : Integer;
      s_string  : String;
      s_large   : LargeString;
      s_uuid    : UUID;
      s_bool    : Boolean;
      s_int      : Integer;
      s_int64   : Integer64;
      s_decimal : Decimal;
      s_double  : Double;
      s_date    : Date;
      s_time    : Time;
      s_datetime: DateTime;
      s_ts      : Timestamp;
      s_alias   : Name;        // resolves through `Name` -> String
}

// Managed to-one association — synthesizes `author_ID` FK column (odata/sql flavor).
// Unmanaged to-one via `on` — must NOT synthesize an FK column.
entity Books {
  key ID        : Integer;
      title     : String;
      stock     : Integer;
      author    : Association to Authors;                       // managed -> author_ID
      editor    : Association to Authors on editor.ID = ID;     // unmanaged -> no FK
}

// To-many composition — exercises isToMany (cardinality.max === '*') and deep expand.
entity Authors {
  key ID      : Integer;
      name    : Name;
      address : Association to Addresses;                       // managed -> address_ID
      books   : Composition of many Books on books.author = $self;  // to-many
}

entity Addresses {
  key ID      : Integer;
      city    : String;
      country : String;
}

// Draft-enabled entity — the `.drafts` shadow must NOT appear in any compiled
// flavor's definitions (validates resolveSource's .drafts stripping).
@odata.draft.enabled
entity Orders {
  key ID     : Integer;
      note   : String;
      amount : Decimal;
}
