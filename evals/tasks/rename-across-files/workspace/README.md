# billing

Invoices for the hosted plan. `src/store.ts` reads and writes the invoice file, `src/invoices.ts` has the
operations, `src/report.ts` prints the monthly summary and `src/reminders.ts` picks who to remind about unpaid
invoices.

Amounts are integer cents.
