-- Gestiunea facturilor și plăților: toate obiectele stau în schema dedicată
-- `facturi`, izolată de tabelele aplicației RAG (documents, chunks, ...).
-- Statusul facturii se recalculează în cod (src/services/facturi) după fiecare
-- plată; `overdue` depinde de data curentă, deci se derivă și la citire.

CREATE SCHEMA facturi;

-- updated_at automat la orice UPDATE, ca să nu depindem de disciplină în cod.
CREATE FUNCTION facturi.touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Un partener poate fi client, furnizor sau ambele.
CREATE TABLE facturi.partners (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  -- CUI normalizat: fără prefix "RO", fără spații (vezi normalizeCui în cod).
  cui TEXT NOT NULL UNIQUE,
  registration_number TEXT,
  is_client BOOLEAN NOT NULL DEFAULT false,
  is_supplier BOOLEAN NOT NULL DEFAULT false,
  email TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  country TEXT NOT NULL DEFAULT 'România',
  iban TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (is_client OR is_supplier)
);

CREATE TRIGGER partners_touch_updated_at
  BEFORE UPDATE ON facturi.partners
  FOR EACH ROW EXECUTE FUNCTION facturi.touch_updated_at();

-- direction: 'issued' = emisă de noi (de încasat / venit),
--            'received' = primită de la furnizor (de plătit / cheltuială).
CREATE TABLE facturi.invoices (
  id BIGSERIAL PRIMARY KEY,
  partner_id BIGINT NOT NULL REFERENCES facturi.partners(id),
  direction TEXT NOT NULL CHECK (direction IN ('issued', 'received')),
  series TEXT NOT NULL,
  number TEXT NOT NULL,
  issue_date DATE NOT NULL,
  due_date DATE NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RON',
  vat_rate NUMERIC(5,2) NOT NULL DEFAULT 19.00 CHECK (vat_rate >= 0),
  net_amount NUMERIC(14,2) NOT NULL CHECK (net_amount >= 0),
  vat_amount NUMERIC(14,2) NOT NULL CHECK (vat_amount >= 0),
  total_amount NUMERIC(14,2) NOT NULL CHECK (total_amount >= 0),
  status TEXT NOT NULL DEFAULT 'issued'
    CHECK (status IN ('draft', 'issued', 'partially_paid', 'paid', 'overdue', 'canceled')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (series, number, direction),
  CHECK (due_date >= issue_date)
);

CREATE INDEX invoices_partner_id_idx ON facturi.invoices (partner_id);
CREATE INDEX invoices_due_date_idx ON facturi.invoices (due_date);
CREATE INDEX invoices_status_idx ON facturi.invoices (status);
CREATE INDEX invoices_direction_idx ON facturi.invoices (direction);

CREATE TRIGGER invoices_touch_updated_at
  BEFORE UPDATE ON facturi.invoices
  FOR EACH ROW EXECUTE FUNCTION facturi.touch_updated_at();

-- Plăți (pe facturi primite) și încasări (pe facturi emise) — direcția
-- rezultă din factura părinte.
CREATE TABLE facturi.payments (
  id BIGSERIAL PRIMARY KEY,
  invoice_id BIGINT NOT NULL REFERENCES facturi.invoices(id) ON DELETE CASCADE,
  payment_date DATE NOT NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL DEFAULT 'bank_transfer'
    CHECK (method IN ('bank_transfer', 'cash', 'card', 'other')),
  reference TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX payments_invoice_id_idx ON facturi.payments (invoice_id);
CREATE INDEX payments_payment_date_idx ON facturi.payments (payment_date);
