/**
 * Tool-urile de facturi expuse modelului de chat (function calling Ollama).
 * Fiecare tool: definiție JSON Schema (pentru model) + schemă zod (validare)
 * + execuție. Erorile se întorc ca rezultat structurat, nu ca excepții —
 * modelul trebuie să le poată explica utilizatorului în conversație.
 */
import { z } from 'zod';
import { fmtMoney } from './calc.js';
import type { InvoiceRow } from './operations.js';
import {
  addPartner,
  cancelInvoice,
  createInvoice,
  getBalance,
  getExpectedCollections,
  getPartnerStatement,
  getStatistics,
  listOpenInvoices,
  listOverdueInvoices,
  registerPayment,
  updatePartner,
} from './operations.js';
import { RELATIVE_PERIODS, resolvePeriod } from './perioade.js';

export interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const zDate = z.string().regex(DATE_RE, 'dată în format YYYY-MM-DD');
/** Modelele trimit uneori boolean-uri ca "true"/"false" — le acceptăm. */
const zBool = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());

const PERIOD_CONVENTIONS =
  'Convenții: last_month/last_year = luna/anul calendaristic precedent; last_two_weeks = ultimele 14 zile; ' +
  'next_month = luna calendaristică următoare; current_month = luna curentă; year_to_date = de la 1 ianuarie până azi.';

const periodProps = {
  period: {
    type: 'string',
    enum: [...RELATIVE_PERIODS],
    description: `Perioadă relativă. ${PERIOD_CONVENTIONS}`,
  },
  from: { type: 'string', description: 'Începutul intervalului explicit (YYYY-MM-DD), împreună cu "to". Alternativă la period.' },
  to: { type: 'string', description: 'Sfârșitul intervalului explicit (YYYY-MM-DD).' },
};

const periodShape = {
  period: z.enum(RELATIVE_PERIODS).optional(),
  from: zDate.optional(),
  to: zDate.optional(),
};

const invoiceRefProps = {
  invoice_id: { type: 'integer', description: 'Id-ul facturii, dacă e cunoscut.' },
  series: { type: 'string', description: 'Seria facturii (ex. "INV").' },
  number: { type: 'string', description: 'Numărul facturii (ex. "2026-0042").' },
  direction: {
    type: 'string',
    enum: ['issued', 'received'],
    description: 'issued = factură emisă de noi; received = primită de la furnizor. Necesară doar dacă seria+numărul sunt ambigue.',
  },
};

const invoiceRefShape = {
  invoice_id: z.coerce.number().int().positive().optional(),
  series: z.string().min(1).optional(),
  number: z.string().min(1).optional(),
  direction: z.enum(['issued', 'received']).optional(),
};

/** Formă compactă a unei facturi pentru răspunsul către model. */
function invoiceView(i: InvoiceRow) {
  return {
    id: i.id,
    partner: i.partner_name,
    direction: i.direction,
    series: i.series,
    number: i.number,
    issue_date: i.issue_date,
    due_date: i.due_date,
    currency: i.currency,
    total_amount: i.total_amount,
    paid_amount: i.paid_amount,
    remaining_amount: i.remaining_amount,
    status: i.effective_status,
    notes: i.notes ?? undefined,
  };
}

const MAX_LISTED = 50;

function listView(invoices: InvoiceRow[]) {
  return {
    count: invoices.length,
    total_remaining: invoices.reduce((s, i) => s + i.remaining_amount, 0),
    invoices: invoices.slice(0, MAX_LISTED).map(invoiceView),
    ...(invoices.length > MAX_LISTED ? { note: `Afișez doar primele ${MAX_LISTED} din ${invoices.length} facturi.` } : {}),
  };
}

interface ToolSpec {
  def: OllamaTool;
  /** Etichetă scurtă pentru UI („Consult facturile de plătit…"). */
  label: string;
  schema: z.ZodTypeAny;
  run: (args: never) => Promise<unknown>;
}

const openInvoiceFilterProps = {
  partner: { type: 'string', description: 'Filtru opțional: numele sau CUI-ul partenerului.' },
  due_from: { type: 'string', description: 'Filtru opțional: scadență de la (YYYY-MM-DD).' },
  due_to: { type: 'string', description: 'Filtru opțional: scadență până la (YYYY-MM-DD).' },
  overdue_only: { type: 'boolean', description: 'true = doar facturile restante (scadență depășită).' },
};

const openInvoiceFilterSchema = z.object({
  partner: z.string().min(1).optional(),
  due_from: zDate.optional(),
  due_to: zDate.optional(),
  overdue_only: zBool.optional(),
});

const TOOLS: Record<string, ToolSpec> = {
  list_invoices_to_pay: {
    def: {
      type: 'function',
      function: {
        name: 'list_invoices_to_pay',
        description:
          'Facturile DE PLĂTIT (primite de la furnizori, neachitate integral). Răspunde la „Ce facturi am de plătit?".',
        parameters: { type: 'object', properties: openInvoiceFilterProps },
      },
    },
    label: 'Consult facturile de plătit',
    schema: openInvoiceFilterSchema,
    run: async (args: z.infer<typeof openInvoiceFilterSchema>) => {
      const invoices = await listOpenInvoices('received', args);
      const view = listView(invoices);
      return { summary: `${view.count} facturi de plătit, rest total ${fmtMoney(view.total_remaining)}.`, ...view };
    },
  },

  list_invoices_to_collect: {
    def: {
      type: 'function',
      function: {
        name: 'list_invoices_to_collect',
        description:
          'Facturile DE ÎNCASAT (emise clienților, neîncasate integral). Răspunde la „Ce facturi am de încasat?".',
        parameters: { type: 'object', properties: openInvoiceFilterProps },
      },
    },
    label: 'Consult facturile de încasat',
    schema: openInvoiceFilterSchema,
    run: async (args: z.infer<typeof openInvoiceFilterSchema>) => {
      const invoices = await listOpenInvoices('issued', args);
      const view = listView(invoices);
      return { summary: `${view.count} facturi de încasat, rest total ${fmtMoney(view.total_remaining)}.`, ...view };
    },
  },

  get_expected_collections: {
    def: {
      type: 'function',
      function: {
        name: 'get_expected_collections',
        description:
          'Cuantumul încasărilor așteptate într-o perioadă, pe baza scadențelor facturilor emise și neîncasate. ' +
          'Răspunde la „Care este cuantumul încasărilor pentru luna viitoare?".',
        parameters: { type: 'object', properties: periodProps },
      },
    },
    label: 'Calculez încasările așteptate',
    schema: z.object(periodShape),
    run: async (args: z.infer<z.ZodObject<typeof periodShape>>) => {
      const range = resolvePeriod(args);
      const { expected, invoices } = await getExpectedCollections(range);
      return {
        summary: `Încasări așteptate ${range.from} – ${range.to}: ${fmtMoney(expected)} din ${invoices.length} facturi.`,
        range,
        expected,
        ...listView(invoices),
      };
    },
  },

  get_balance: {
    def: {
      type: 'function',
      function: {
        name: 'get_balance',
        description:
          'Balanța venituri vs cheltuieli pe o perioadă: total facturat emis vs primit (după data emiterii), ' +
          'total încasat vs plătit (după data plății) și soldurile nete. ' +
          'Răspunde la „Care este balanța dintre venituri și cheltuieli?".',
        parameters: { type: 'object', properties: periodProps },
      },
    },
    label: 'Calculez balanța venituri/cheltuieli',
    schema: z.object(periodShape),
    run: async (args: z.infer<z.ZodObject<typeof periodShape>>) => {
      const report = await getBalance(resolvePeriod(args));
      return {
        summary:
          `Perioada ${report.range.from} – ${report.range.to}: facturat ${fmtMoney(report.invoiced_issued)} venituri vs ` +
          `${fmtMoney(report.invoiced_received)} cheltuieli (net ${fmtMoney(report.invoiced_net)}); ` +
          `încasat ${fmtMoney(report.collected)}, plătit ${fmtMoney(report.paid)} (flux net ${fmtMoney(report.cash_net)}).`,
        ...report,
      };
    },
  },

  get_statistics: {
    def: {
      type: 'function',
      function: {
        name: 'get_statistics',
        description:
          'Statistici generale pe o perioadă: număr facturi emise/primite, sume facturate, încasat/plătit, ' +
          'TVA colectată/deductibilă, restanțe la zi, top parteneri. ' +
          'Răspunde la „Dă-mi statistici pe ultimele două săptămâni / ultima lună / ultimul an.".',
        parameters: { type: 'object', properties: periodProps },
      },
    },
    label: 'Adun statisticile',
    schema: z.object(periodShape),
    run: async (args: z.infer<z.ZodObject<typeof periodShape>>) => {
      const report = await getStatistics(resolvePeriod(args));
      return {
        summary:
          `Perioada ${report.range.from} – ${report.range.to}: ${report.count_issued} facturi emise ` +
          `(${fmtMoney(report.invoiced_issued)}), ${report.count_received} primite (${fmtMoney(report.invoiced_received)}); ` +
          `restanțe la zi: ${report.overdue_count} facturi, ${fmtMoney(report.overdue_amount)}.`,
        ...report,
      };
    },
  },

  get_partner_statement: {
    def: {
      type: 'function',
      function: {
        name: 'get_partner_statement',
        description:
          'Fișa unui partener: datele lui, toate facturile (ambele direcții) și soldul curent — ' +
          'cât ne datorează și cât îi datorăm.',
        parameters: {
          type: 'object',
          properties: { partner: { type: 'string', description: 'Numele sau CUI-ul partenerului.' } },
          required: ['partner'],
        },
      },
    },
    label: 'Deschid fișa partenerului',
    schema: z.object({ partner: z.string().min(1) }),
    run: async (args: { partner: string }) => {
      const statement = await getPartnerStatement(args.partner);
      return {
        summary:
          `${statement.partner.name} (CUI ${statement.partner.cui}): ne datorează ${fmtMoney(statement.they_owe_us)}, ` +
          `îi datorăm ${fmtMoney(statement.we_owe_them)}; ${statement.invoices.length} facturi în istoric.`,
        partner: statement.partner,
        they_owe_us: statement.they_owe_us,
        we_owe_them: statement.we_owe_them,
        invoices: statement.invoices.slice(0, MAX_LISTED).map(invoiceView),
      };
    },
  },

  list_overdue_invoices: {
    def: {
      type: 'function',
      function: {
        name: 'list_overdue_invoices',
        description: 'Toate facturile restante (scadență depășită, neplătite integral), atât de încasat cât și de plătit.',
        parameters: { type: 'object', properties: {} },
      },
    },
    label: 'Caut facturile restante',
    schema: z.object({}),
    run: async () => {
      const invoices = await listOverdueInvoices();
      const view = listView(invoices);
      return { summary: `${view.count} facturi restante, rest total ${fmtMoney(view.total_remaining)}.`, ...view };
    },
  },

  add_partner: {
    def: {
      type: 'function',
      function: {
        name: 'add_partner',
        description:
          'Adaugă un partener nou. Obligatoriu: name și cui. Trebuie precizat și tipul: is_client și/sau is_supplier. ' +
          'Dacă tipul lipsește, tool-ul NU inventează — cere informația; întreabă utilizatorul și reapelează.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Denumirea partenerului.' },
            cui: { type: 'string', description: 'Codul fiscal / CUI (cu sau fără prefixul RO).' },
            is_client: { type: 'boolean', description: 'true dacă îi emitem facturi (client).' },
            is_supplier: { type: 'boolean', description: 'true dacă primim facturi de la el (furnizor).' },
            registration_number: { type: 'string', description: 'Nr. Registrul Comerțului (opțional).' },
            email: { type: 'string' },
            phone: { type: 'string' },
            address: { type: 'string' },
            city: { type: 'string' },
            country: { type: 'string', description: 'Implicit "România".' },
            iban: { type: 'string' },
          },
          required: ['name', 'cui'],
        },
      },
    },
    label: 'Adaug partenerul',
    schema: z.object({
      name: z.string().min(1),
      cui: z.string().min(1),
      is_client: zBool.optional(),
      is_supplier: zBool.optional(),
      registration_number: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      address: z.string().optional(),
      city: z.string().optional(),
      country: z.string().optional(),
      iban: z.string().optional(),
    }),
    run: async (args: {
      name: string;
      cui: string;
      is_client?: boolean;
      is_supplier?: boolean;
      email?: string;
      iban?: string;
      [k: string]: unknown;
    }) => {
      // Nu inventăm tipul partenerului — fără el, înregistrarea nu are sens.
      if (args.is_client === undefined && args.is_supplier === undefined) {
        return {
          needs_info: true,
          message:
            'Pentru a înregistra partenerul, precizează tipul: este client (îi emitem facturi), ' +
            'furnizor (primim facturi de la el) sau ambele? Întreabă utilizatorul și reapelează tool-ul.',
          required: ['is_client și/sau is_supplier'],
          recommended: ['email', 'phone', 'address', 'city', 'iban', 'registration_number'],
        };
      }
      if (args.is_client === false && args.is_supplier === false) {
        return { error: 'Un partener trebuie să fie cel puțin client sau furnizor.' };
      }
      const partner = await addPartner(args);
      const missing = (['email', 'phone', 'iban', 'address'] as const).filter((f) => !args[f]);
      return {
        summary: `Partener adăugat: ${partner.name}, CUI ${partner.cui} (id ${partner.id}).`,
        partner,
        ...(missing.length
          ? { recommended_missing: missing, note: `Date recomandate necompletate: ${missing.join(', ')}.` }
          : {}),
      };
    },
  },

  update_partner: {
    def: {
      type: 'function',
      function: {
        name: 'update_partner',
        description: 'Actualizează datele unui partener existent, identificat prin nume sau CUI.',
        parameters: {
          type: 'object',
          properties: {
            partner: { type: 'string', description: 'Numele sau CUI-ul partenerului de actualizat.' },
            name: { type: 'string', description: 'Noua denumire (opțional).' },
            is_client: { type: 'boolean' },
            is_supplier: { type: 'boolean' },
            registration_number: { type: 'string' },
            email: { type: 'string' },
            phone: { type: 'string' },
            address: { type: 'string' },
            city: { type: 'string' },
            country: { type: 'string' },
            iban: { type: 'string' },
          },
          required: ['partner'],
        },
      },
    },
    label: 'Actualizez partenerul',
    schema: z.object({
      partner: z.string().min(1),
      name: z.string().min(1).optional(),
      is_client: zBool.optional(),
      is_supplier: zBool.optional(),
      registration_number: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      address: z.string().optional(),
      city: z.string().optional(),
      country: z.string().optional(),
      iban: z.string().optional(),
    }),
    run: async ({ partner, ...fields }: { partner: string; [k: string]: unknown }) => {
      const updated = await updatePartner(partner, fields);
      return { summary: `Partener actualizat: ${updated.name} (CUI ${updated.cui}).`, partner: updated };
    },
  },

  create_invoice: {
    def: {
      type: 'function',
      function: {
        name: 'create_invoice',
        description:
          'Creează o factură emisă (issued, către un client) sau primită (received, de la un furnizor). ' +
          'Sumele: dă FIE baza impozabilă (net_amount), FIE totalul cu TVA (total_amount) — restul se calculează ' +
          'automat cu cota vat_rate (implicit 19%).',
        parameters: {
          type: 'object',
          properties: {
            partner: { type: 'string', description: 'Numele sau CUI-ul partenerului (trebuie să existe).' },
            direction: { type: 'string', enum: ['issued', 'received'], description: 'issued = emisă de noi; received = primită.' },
            series: { type: 'string', description: 'Seria facturii.' },
            number: { type: 'string', description: 'Numărul facturii.' },
            issue_date: { type: 'string', description: 'Data emiterii (YYYY-MM-DD).' },
            due_date: { type: 'string', description: 'Data scadenței (YYYY-MM-DD).' },
            net_amount: { type: 'number', description: 'Baza impozabilă, fără TVA (alternativă la total_amount).' },
            total_amount: { type: 'number', description: 'Totalul cu TVA (alternativă la net_amount).' },
            vat_rate: { type: 'number', description: 'Cota TVA în procente. Implicit 19.' },
            currency: { type: 'string', description: 'Implicit RON.' },
            notes: { type: 'string' },
          },
          required: ['partner', 'direction', 'series', 'number', 'issue_date', 'due_date'],
        },
      },
    },
    label: 'Creez factura',
    schema: z.object({
      partner: z.string().min(1),
      direction: z.enum(['issued', 'received']),
      series: z.string().min(1),
      number: z.string().min(1),
      issue_date: zDate,
      due_date: zDate,
      net_amount: z.coerce.number().positive().optional(),
      total_amount: z.coerce.number().positive().optional(),
      vat_rate: z.coerce.number().min(0).optional(),
      currency: z.string().min(1).optional(),
      notes: z.string().optional(),
    }),
    run: async (args: Parameters<typeof createInvoice>[0]) => {
      const invoice = await createInvoice(args);
      const kind = invoice.direction === 'issued' ? 'emisă către' : 'primită de la';
      return {
        summary:
          `Factură ${kind} ${invoice.partner_name}: ${invoice.series} ${invoice.number}, ` +
          `bază ${fmtMoney(invoice.net_amount, invoice.currency)} + TVA ${fmtMoney(invoice.vat_amount, invoice.currency)} ` +
          `= total ${fmtMoney(invoice.total_amount, invoice.currency)}, scadentă la ${invoice.due_date}.`,
        invoice: invoiceView(invoice),
      };
    },
  },

  register_payment: {
    def: {
      type: 'function',
      function: {
        name: 'register_payment',
        description:
          'Înregistrează o plată (pe o factură primită) sau o încasare (pe o factură emisă). ' +
          'Factura se identifică prin invoice_id sau prin series + number. Statusul facturii se actualizează automat.',
        parameters: {
          type: 'object',
          properties: {
            ...invoiceRefProps,
            amount: { type: 'number', description: 'Suma plătită/încasată.' },
            payment_date: { type: 'string', description: 'Data plății (YYYY-MM-DD). Implicit azi.' },
            method: { type: 'string', enum: ['bank_transfer', 'cash', 'card', 'other'], description: 'Implicit bank_transfer.' },
            reference: { type: 'string', description: 'Nr. OP / referință (opțional).' },
            notes: { type: 'string' },
          },
          required: ['amount'],
        },
      },
    },
    label: 'Înregistrez plata',
    schema: z.object({
      ...invoiceRefShape,
      amount: z.coerce.number().positive('suma trebuie să fie pozitivă'),
      payment_date: zDate.optional(),
      method: z.enum(['bank_transfer', 'cash', 'card', 'other']).optional(),
      reference: z.string().optional(),
      notes: z.string().optional(),
    }),
    run: async (args: Parameters<typeof registerPayment>[0]) => {
      const { invoice, payment_id } = await registerPayment(args);
      const verb = invoice.direction === 'issued' ? 'Încasare' : 'Plată';
      return {
        summary:
          `${verb} de ${fmtMoney(args.amount, invoice.currency)} înregistrată pe factura ${invoice.series} ${invoice.number} ` +
          `(${invoice.partner_name}). Achitat ${fmtMoney(invoice.paid_amount, invoice.currency)} din ` +
          `${fmtMoney(invoice.total_amount, invoice.currency)} — status: ${invoice.effective_status}.`,
        payment_id,
        invoice: invoiceView(invoice),
      };
    },
  },

  cancel_invoice: {
    def: {
      type: 'function',
      function: {
        name: 'cancel_invoice',
        description:
          'Anulează o factură identificată prin invoice_id sau series + number. Refuză dacă factura are plăți înregistrate.',
        parameters: { type: 'object', properties: invoiceRefProps },
      },
    },
    label: 'Anulez factura',
    schema: z.object(invoiceRefShape),
    run: async (args: Parameters<typeof cancelInvoice>[0]) => {
      const invoice = await cancelInvoice(args);
      return { summary: `Factura ${invoice.series} ${invoice.number} (${invoice.partner_name}) a fost anulată.`, invoice: invoiceView(invoice) };
    },
  },
};

/** Definițiile trimise modelului în apelul /api/chat. */
export const facturiToolDefs: OllamaTool[] = Object.values(TOOLS).map((t) => t.def);

/** Eticheta scurtă afișată în UI când rulează un tool. */
export function facturiToolLabel(name: string): string {
  return TOOLS[name]?.label ?? `Rulez ${name}`;
}

/**
 * Execută un tool cerut de model și întoarce rezultatul ca JSON (conținutul
 * mesajului cu role "tool"). Orice eroare devine { error } — nu aruncă.
 */
/** Modelele trimit adesea "" sau null pentru parametrii opționali nefolosiți — îi tratăm ca absenți. */
function dropEmptyArgs(rawArgs: unknown): unknown {
  if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) return rawArgs;
  return Object.fromEntries(Object.entries(rawArgs).filter(([, v]) => v !== '' && v !== null && v !== undefined));
}

export async function executeFacturiTool(name: string, rawArgs: unknown): Promise<string> {
  const tool = TOOLS[name];
  if (!tool) {
    return JSON.stringify({ error: `Tool necunoscut: "${name}". Tool-urile disponibile: ${Object.keys(TOOLS).join(', ')}.` });
  }
  try {
    const args = tool.schema.parse(dropEmptyArgs(rawArgs ?? {}));
    return JSON.stringify(await tool.run(args as never));
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
      return JSON.stringify({ error: `Argumente invalide pentru ${name}: ${issues}` });
    }
    return JSON.stringify({ error: (err as Error).message });
  }
}
